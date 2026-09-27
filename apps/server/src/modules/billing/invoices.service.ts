// Database operations for invoices.
//
// Route handlers never touch the database directly — they call these functions.
// An invoice is created as DRAFT and becomes a financial obligation only when it
// is POSTED, at which point a ledger debit entry is written.

import { and, asc, count, desc, eq, type SQL } from "drizzle-orm";
import type { InvoiceStatus, InvoiceType } from "@bcis/shared";

import { db, type DbExecutor } from "../../db/connection";
import { invoiceLineItems, invoices } from "../../db/schema/billing";
import { serviceAccounts, subscribers, subscriptionPlans } from "../../db/schema/subscribers";
import { formatDateOnly } from "../../shared/date";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { buildDiscountLineItem, buildInstallationFeeLineItem, buildReconnectionFeeLineItem, buildInvoiceDraftFromLineItems, calculatePercentageOfCentavos, type MonthlyInvoiceDraft } from "./invoice-calculations";
import { allocateNextInvoiceNumber } from "./invoice-number.service";
import { applyAdvanceCreditToInvoice } from "./advance-credit.service";
import { recordInvoicePosted } from "../ledger/ledger.service";

export interface InvoiceSummary {
  id: string;
  invoiceNumber: string;
  serviceAccountId: string;
  serviceAccountNumber: string;
  subscriberId: string;
  subscriberName: string;
  invoiceType: InvoiceType;
  status: InvoiceStatus;
  billingPeriodYear: number | null;
  billingPeriodMonth: number | null;
  invoiceDate: string;
  dueDate: string;
  subtotalCentavos: number;
  lateFeesCentavos: number;
  totalAmountCentavos: number;
  paidAmountCentavos: number;
  remainingBalanceCentavos: number;
  notes: string | null;
  voidedByTransactionId: string | null;
  createdAt: Date;
  postedAt: Date | null;
  voidedAt: Date | null;
}

export interface InvoiceLineItemSummary {
  id: string;
  description: string;
  quantity: number;
  unitAmountCentavos: number;
  totalAmountCentavos: number;
}

export interface InvoiceDetail extends InvoiceSummary {
  lineItems: InvoiceLineItemSummary[];
}

export interface ListInvoicesFilters {
  status?: InvoiceStatus;
  year?: number;
  month?: number;
  subscriberId?: string;
  /** 1-based page number. Defaults to the first page. */
  page?: number;
  /** Rows per page, already bounded by the query schema's maximum. */
  pageSize?: number;
}

/** One page of invoices, with the total so a caller can render "page 2 of 7". */
export interface InvoicePage {
  items: InvoiceSummary[];
  page: number;
  pageSize: number;
  total: number;
}

/** The page size used when a caller does not ask for one. Matches the query schema. */
const DEFAULT_INVOICE_PAGE_SIZE = 50;

const invoiceSummaryColumns = {
  id: invoices.id,
  invoiceNumber: invoices.invoiceNumber,
  serviceAccountId: invoices.serviceAccountId,
  serviceAccountNumber: serviceAccounts.serviceAccountNumber,
  subscriberId: subscribers.id,
  subscriberFirstName: subscribers.firstName,
  subscriberLastName: subscribers.lastName,
  invoiceType: invoices.invoiceType,
  status: invoices.status,
  billingPeriodYear: invoices.billingPeriodYear,
  billingPeriodMonth: invoices.billingPeriodMonth,
  invoiceDate: invoices.invoiceDate,
  dueDate: invoices.dueDate,
  subtotalCentavos: invoices.subtotalCentavos,
  lateFeesCentavos: invoices.lateFeesCentavos,
  totalAmountCentavos: invoices.totalAmountCentavos,
  paidAmountCentavos: invoices.paidAmountCentavos,
  remainingBalanceCentavos: invoices.remainingBalanceCentavos,
  notes: invoices.notes,
  voidedByTransactionId: invoices.voidedByTransactionId,
  createdAt: invoices.createdAt,
  postedAt: invoices.postedAt,
  voidedAt: invoices.voidedAt,
};

type InvoiceJoinedRow = {
  id: string;
  invoiceNumber: string;
  serviceAccountId: string;
  serviceAccountNumber: string;
  subscriberId: string;
  subscriberFirstName: string;
  subscriberLastName: string;
  invoiceType: InvoiceType;
  status: InvoiceStatus;
  billingPeriodYear: number | null;
  billingPeriodMonth: number | null;
  invoiceDate: string;
  dueDate: string;
  subtotalCentavos: number;
  lateFeesCentavos: number;
  totalAmountCentavos: number;
  paidAmountCentavos: number;
  remainingBalanceCentavos: number;
  notes: string | null;
  voidedByTransactionId: string | null;
  createdAt: Date;
  postedAt: Date | null;
  voidedAt: Date | null;
};

/** Flattens the joined row into the shape the API returns. */
function toInvoiceSummary(row: InvoiceJoinedRow): InvoiceSummary {
  return {
    id: row.id,
    invoiceNumber: row.invoiceNumber,
    serviceAccountId: row.serviceAccountId,
    serviceAccountNumber: row.serviceAccountNumber,
    subscriberId: row.subscriberId,
    subscriberName: `${row.subscriberLastName}, ${row.subscriberFirstName}`,
    invoiceType: row.invoiceType,
    status: row.status,
    billingPeriodYear: row.billingPeriodYear,
    billingPeriodMonth: row.billingPeriodMonth,
    invoiceDate: row.invoiceDate,
    dueDate: row.dueDate,
    subtotalCentavos: row.subtotalCentavos,
    lateFeesCentavos: row.lateFeesCentavos,
    totalAmountCentavos: row.totalAmountCentavos,
    paidAmountCentavos: row.paidAmountCentavos,
    remainingBalanceCentavos: row.remainingBalanceCentavos,
    notes: row.notes,
    voidedByTransactionId: row.voidedByTransactionId,
    createdAt: row.createdAt,
    postedAt: row.postedAt,
    voidedAt: row.voidedAt,
  };
}

const lineItemColumns = {
  id: invoiceLineItems.id,
  description: invoiceLineItems.description,
  quantity: invoiceLineItems.quantity,
  unitAmountCentavos: invoiceLineItems.unitAmountCentavos,
  totalAmountCentavos: invoiceLineItems.totalAmountCentavos,
};

/**
 * Lists invoices, newest first, ONE PAGE AT A TIME (S8-1).
 *
 * The page size is bounded by the query schema, and the ordering is stable —
 * `created_at` with the invoice number as a tie-breaker — so a page boundary cannot
 * drop or repeat a row between two requests. `total` is the count of everything the
 * filters matched, so the caller knows how many pages there are.
 */
export async function listInvoices(filters: ListInvoicesFilters = {}): Promise<InvoicePage> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? DEFAULT_INVOICE_PAGE_SIZE;
  const conditions: SQL[] = [];

  if (filters.status !== undefined) {
    conditions.push(eq(invoices.status, filters.status));
  }
  if (filters.year !== undefined) {
    conditions.push(eq(invoices.billingPeriodYear, filters.year));
  }
  if (filters.month !== undefined) {
    conditions.push(eq(invoices.billingPeriodMonth, filters.month));
  }
  if (filters.subscriberId !== undefined) {
    conditions.push(eq(serviceAccounts.subscriberId, filters.subscriberId));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select(invoiceSummaryColumns)
    .from(invoices)
    .innerJoin(serviceAccounts, eq(invoices.serviceAccountId, serviceAccounts.id))
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
    .where(where)
    .orderBy(desc(invoices.createdAt), desc(invoices.invoiceNumber))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const totalRows = await db
    .select({ value: count() })
    .from(invoices)
    .innerJoin(serviceAccounts, eq(invoices.serviceAccountId, serviceAccounts.id))
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
    .where(where);

  return {
    items: rows.map((row) => toInvoiceSummary(row)),
    page,
    pageSize,
    total: totalRows[0]?.value ?? 0,
  };
}

/** Loads one invoice together with its line items, or throws NotFoundError. */
export async function getInvoiceById(invoiceId: string): Promise<InvoiceDetail> {
  return loadInvoiceDetail(db, invoiceId);
}

async function loadInvoiceDetail(
  executor: DbExecutor,
  invoiceId: string
): Promise<InvoiceDetail> {
  const row = await executor
    .select(invoiceSummaryColumns)
    .from(invoices)
    .innerJoin(serviceAccounts, eq(invoices.serviceAccountId, serviceAccounts.id))
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
    .where(eq(invoices.id, invoiceId))
    .limit(1)
    .then((rows) => rows[0]);

  if (row === undefined) {
    throw new NotFoundError("Invoice not found");
  }

  const lineItems = await executor
    .select(lineItemColumns)
    .from(invoiceLineItems)
    .where(eq(invoiceLineItems.invoiceId, invoiceId))
    .orderBy(asc(invoiceLineItems.description));

  return {
    ...toInvoiceSummary(row),
    lineItems,
  };
}

/**
 * Posts a single draft invoice: it becomes a debt and a ledger debit is written.
 *
 * The status change and the ledger entry commit together, so an invoice can never
 * be posted without the ledger recording what the subscriber now owes.
 */
export async function postInvoiceForId(
  invoiceId: string,
  postedByUserId: string
): Promise<InvoiceDetail> {
  return db.transaction((tx) => postInvoiceInTransaction(tx, invoiceId, postedByUserId));
}

/**
 * The body of `postInvoiceForId`, running inside a caller-supplied transaction.
 *
 * Exported so the batch "post all drafts" action can post every invoice in ONE
 * transaction: either the whole batch posts, or nothing does.
 */
export async function postInvoiceInTransaction(
  tx: DbExecutor,
  invoiceId: string,
  postedByUserId: string
): Promise<InvoiceDetail> {
  const invoice = await tx
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      serviceAccountId: invoices.serviceAccountId,
      status: invoices.status,
      totalAmountCentavos: invoices.totalAmountCentavos,
      paidAmountCentavos: invoices.paidAmountCentavos,
      remainingBalanceCentavos: invoices.remainingBalanceCentavos,
      billingPeriodYear: invoices.billingPeriodYear,
      billingPeriodMonth: invoices.billingPeriodMonth,
    })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1)
    .for("update")
    .then((rows) => rows[0]);

  if (invoice === undefined) {
    throw new NotFoundError("Invoice not found");
  }

  if (invoice.status === "void") {
    throw new ConflictError("A voided invoice cannot be posted");
  }

  if (invoice.status !== "draft") {
    throw new ConflictError("Only a draft invoice can be posted");
  }

  // Advance credit may already have covered part (or all) of this draft, so the
  // posted status reflects what is still owed. An invoice that an advance credit
  // fully settled (nothing left owing, but something already paid towards it) is
  // CREDITED — it was cleared by credit, not by a payment. A zero-value invoice is
  // simply PAID; anything with a balance left is UNPAID.
  const postedStatus: InvoiceStatus =
    invoice.remainingBalanceCentavos === 0
      ? invoice.paidAmountCentavos > 0
        ? "credited"
        : "paid"
      : "unpaid";

  await tx
    .update(invoices)
    .set({ status: postedStatus, postedAt: new Date(), postedBy: postedByUserId })
    .where(eq(invoices.id, invoiceId));

  await recordInvoicePosted(tx, invoice, postedByUserId);

  return loadInvoiceDetail(tx, invoiceId);
}

export interface CreateReconnectionFeeResult {
  invoice: InvoiceDetail;
  amountCentavos: number;
}

export interface CreateInstallationFeeResult {
  invoice: InvoiceDetail;
  amountCentavos: number;
}

/** The invoice-level fields a fee invoice needs before its line items are known. */
interface DraftInvoiceInsert {
  invoiceNumber: string;
  serviceAccountId: string;
  invoiceType: InvoiceType;
  invoiceDate: string;
  dueDate: string;
  notes: string | null;
  createdByUserId: string;
}

/**
 * Inserts a draft invoice and its line items inside the caller's transaction.
 *
 * Every invoice total comes from the already-rounded line items, so the printed
 * document and the stored totals can never disagree.
 */
async function insertDraftInvoiceWithLineItems(
  tx: DbExecutor,
  input: DraftInvoiceInsert,
  draft: MonthlyInvoiceDraft
): Promise<string> {
  const insertedInvoice = await tx
    .insert(invoices)
    .values({
      invoiceNumber: input.invoiceNumber,
      serviceAccountId: input.serviceAccountId,
      invoiceType: input.invoiceType,
      status: "draft",
      invoiceDate: input.invoiceDate,
      dueDate: input.dueDate,
      subtotalCentavos: draft.subtotalCentavos,
      lateFeesCentavos: draft.lateFeesCentavos,
      totalAmountCentavos: draft.totalAmountCentavos,
      remainingBalanceCentavos: draft.remainingBalanceCentavos,
      notes: input.notes,
      createdBy: input.createdByUserId,
    })
    .returning({ id: invoices.id })
    .then((rows) => rows[0]);

  if (insertedInvoice === undefined) {
    throw new NotFoundError("Invoice could not be created");
  }

  await tx.insert(invoiceLineItems).values(
    draft.lineItems.map((lineItem) => ({
      invoiceId: insertedInvoice.id,
      description: lineItem.description,
      quantity: lineItem.quantity,
      unitAmountCentavos: lineItem.unitAmountCentavos,
      totalAmountCentavos: lineItem.totalAmountCentavos,
    }))
  );

  return insertedInvoice.id;
}

/**
 * Generates a reconnection fee invoice for a service account.
 *
 * The fee comes from the account's plan, so a price change only affects accounts
 * created after it. The invoice starts as a draft, like every other invoice.
 */
export async function createReconnectionFeeInvoice(
  serviceAccountId: string,
  reason: string | undefined,
  createdByUserId: string
): Promise<CreateReconnectionFeeResult> {
  return db.transaction(async (tx) => {
    const account = await tx
      .select({
        id: serviceAccounts.id,
        planName: subscriptionPlans.name,
        reconnectionFeeCentavos: subscriptionPlans.reconnectionFeeCentavos,
      })
      .from(serviceAccounts)
      .innerJoin(subscriptionPlans, eq(serviceAccounts.planId, subscriptionPlans.id))
      .where(eq(serviceAccounts.id, serviceAccountId))
      .limit(1)
      .for("update")
      .then((rows) => rows[0]);

    if (account === undefined) {
      throw new NotFoundError("Service account not found");
    }

    if (account.reconnectionFeeCentavos <= 0) {
      throw new ValidationError("This plan has no reconnection fee to charge");
    }

    const today = new Date();
    const lineItem = buildReconnectionFeeLineItem(account.planName, account.reconnectionFeeCentavos);
    const draft = buildInvoiceDraftFromLineItems([lineItem]);
    const invoiceNumber = await allocateNextInvoiceNumber(
      tx,
      today.getFullYear(),
      today.getMonth() + 1
    );

    const invoiceId = await insertDraftInvoiceWithLineItems(
      tx,
      {
        invoiceNumber,
        serviceAccountId,
        invoiceType: "reconnection_fee",
        invoiceDate: formatDateOnly(today),
        dueDate: formatDateOnly(today),
        notes: reason ?? null,
        createdByUserId,
      },
      draft
    );

    // A reconnection fee is a fresh invoice too, so any advance credit pays it down.
    await applyAdvanceCreditToInvoice(
      tx,
      {
        id: invoiceId,
        invoiceNumber,
        serviceAccountId,
        totalAmountCentavos: draft.totalAmountCentavos,
      },
      createdByUserId
    );

    return {
      invoice: await loadInvoiceDetail(tx, invoiceId),
      amountCentavos: draft.totalAmountCentavos,
    };
  });
}

/**
 * Generates an installation fee invoice for a service account.
 *
 * The fee is a first-class line item (S2-3), supplied by the caller, and the
 * invoice starts as a draft so it can be reviewed before it affects balances. Any
 * advance credit the subscriber holds is applied to it, exactly like a
 * reconnection fee.
 */
export async function createInstallationFeeInvoice(
  serviceAccountId: string,
  installationFeeCentavos: number,
  reason: string | undefined,
  createdByUserId: string
): Promise<CreateInstallationFeeResult> {
  if (!Number.isInteger(installationFeeCentavos) || installationFeeCentavos <= 0) {
    throw new ValidationError("The installation fee must be a positive whole number of centavos");
  }

  return db.transaction(async (tx) => {
    const account = await tx
      .select({
        id: serviceAccounts.id,
        planName: subscriptionPlans.name,
      })
      .from(serviceAccounts)
      .innerJoin(subscriptionPlans, eq(serviceAccounts.planId, subscriptionPlans.id))
      .where(eq(serviceAccounts.id, serviceAccountId))
      .limit(1)
      .for("update")
      .then((rows) => rows[0]);

    if (account === undefined) {
      throw new NotFoundError("Service account not found");
    }

    const today = new Date();
    const lineItem = buildInstallationFeeLineItem(account.planName, installationFeeCentavos);
    const draft = buildInvoiceDraftFromLineItems([lineItem]);
    const invoiceNumber = await allocateNextInvoiceNumber(
      tx,
      today.getFullYear(),
      today.getMonth() + 1
    );

    const invoiceId = await insertDraftInvoiceWithLineItems(
      tx,
      {
        invoiceNumber,
        serviceAccountId,
        invoiceType: "installation_fee",
        invoiceDate: formatDateOnly(today),
        dueDate: formatDateOnly(today),
        notes: reason ?? null,
        createdByUserId,
      },
      draft
    );

    await applyAdvanceCreditToInvoice(
      tx,
      {
        id: invoiceId,
        invoiceNumber,
        serviceAccountId,
        totalAmountCentavos: draft.totalAmountCentavos,
      },
      createdByUserId
    );

    return {
      invoice: await loadInvoiceDetail(tx, invoiceId),
      amountCentavos: draft.totalAmountCentavos,
    };
  });
}

export interface ApplyDiscountInput {
  /** A fixed discount in centavos, or undefined when a rate is supplied. */
  discountCentavos?: number;
  /** A discount rate in basis points (1% = 100 bp), or undefined for a fixed amount. */
  discountRateBasisPoints?: number;
  /** Why the discount was given; copied onto the line item and the invoice notes. */
  reason: string;
}

/**
 * Adds a discount line to a DRAFT invoice.
 *
 * Finalized invoices are immutable (S8-2), so only a draft may be discounted: the
 * line item is negative, the invoice's subtotal and total drop by exactly that
 * amount, and the remaining balance follows. A percentage discount is rounded half
 * away from zero ONCE, in integer centavos, before the line is summed.
 */
export async function applyDiscountToDraftInvoice(
  invoiceId: string,
  input: ApplyDiscountInput
): Promise<InvoiceDetail> {
  return db.transaction(async (tx) => {
    const invoice = await tx
      .select({
        id: invoices.id,
        status: invoices.status,
        subtotalCentavos: invoices.subtotalCentavos,
        lateFeesCentavos: invoices.lateFeesCentavos,
        paidAmountCentavos: invoices.paidAmountCentavos,
      })
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .limit(1)
      .for("update")
      .then((rows) => rows[0]);

    if (invoice === undefined) {
      throw new NotFoundError("Invoice not found");
    }

    if (invoice.status !== "draft") {
      throw new ConflictError("Only a draft invoice can be discounted");
    }

    const discountCentavos =
      input.discountRateBasisPoints === undefined
        ? (input.discountCentavos ?? 0)
        : calculatePercentageOfCentavos(invoice.subtotalCentavos, input.discountRateBasisPoints);

    if (!Number.isInteger(discountCentavos) || discountCentavos <= 0) {
      throw new ValidationError("The discount must be a positive whole number of centavos");
    }

    const chargeableCentavos = invoice.subtotalCentavos + invoice.lateFeesCentavos;

    // The discount may not take the invoice below zero, and it may not write off
    // money that has already been applied to it: the remaining balance is
    // `total − paid`, so a discount larger than the UNPAID total would leave a
    // negative balance. An advance credit can pay a draft down before it is ever
    // discounted, which is why the ceiling is the unpaid amount, not the whole
    // total.
    const unpaidCentavos = chargeableCentavos - invoice.paidAmountCentavos;
    if (discountCentavos > unpaidCentavos) {
      throw new ValidationError("The discount cannot exceed the invoice's unpaid total");
    }

    const lineItem = buildDiscountLineItem(input.reason, discountCentavos);
    await tx.insert(invoiceLineItems).values({
      invoiceId: invoice.id,
      description: lineItem.description,
      quantity: lineItem.quantity,
      unitAmountCentavos: lineItem.unitAmountCentavos,
      totalAmountCentavos: lineItem.totalAmountCentavos,
    });

    const totalAmountCentavos = chargeableCentavos - discountCentavos;
    await tx
      .update(invoices)
      .set({
        subtotalCentavos: invoice.subtotalCentavos - discountCentavos,
        totalAmountCentavos,
        remainingBalanceCentavos: totalAmountCentavos - invoice.paidAmountCentavos,
      })
      .where(eq(invoices.id, invoice.id));

    return loadInvoiceDetail(tx, invoice.id);
  });
}
