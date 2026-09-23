// Database operations for invoices.
//
// Route handlers never touch the database directly — they call these functions.
// An invoice is created as DRAFT and becomes a financial obligation only when it
// is POSTED, at which point a ledger debit entry is written.

import { and, asc, eq } from "drizzle-orm";
import type { InvoiceStatus, InvoiceType } from "@bcis/shared";

import { db, type DbExecutor } from "../../db/connection";
import { invoiceLineItems, invoices } from "../../db/schema/billing";
import { serviceAccounts, subscribers, subscriptionPlans } from "../../db/schema/subscribers";
import { formatDateOnly } from "../../shared/date";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { buildReconnectionFeeLineItem } from "./invoice-calculations";
import { allocateNextInvoiceNumber } from "./invoice-number.service";
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
}

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

/** Lists invoices, newest first, with the subscriber and service account attached. */
export async function listInvoices(filters: ListInvoicesFilters = {}): Promise<InvoiceSummary[]> {
  const conditions = [];
  const query = db
    .select(invoiceSummaryColumns)
    .from(invoices)
    .innerJoin(serviceAccounts, eq(invoices.serviceAccountId, serviceAccounts.id))
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id));

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

  const rows = await query.where(conditions.length > 0 ? and(...conditions) : undefined);

  return rows.map((row) => toInvoiceSummary(row));
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
  return db.transaction(async (tx) => {
    const invoice = await tx
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        serviceAccountId: invoices.serviceAccountId,
        status: invoices.status,
        totalAmountCentavos: invoices.totalAmountCentavos,
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

    await tx
      .update(invoices)
      .set({ status: "posted", postedAt: new Date(), postedBy: postedByUserId })
      .where(eq(invoices.id, invoiceId));

    await recordInvoicePosted(tx, invoice, postedByUserId);

    return loadInvoiceDetail(tx, invoiceId);
  });
}

export interface CreateReconnectionFeeResult {
  invoice: InvoiceDetail;
  amountCentavos: number;
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

    const insertedInvoice = await tx
      .insert(invoices)
      .values({
        invoiceNumber: await allocateNextInvoiceNumber(
          tx,
          today.getFullYear(),
          today.getMonth() + 1
        ),
        serviceAccountId,
        invoiceType: "reconnection_fee",
        status: "draft",
        invoiceDate: formatDateOnly(today),
        dueDate: formatDateOnly(today),
        subtotalCentavos: lineItem.totalAmountCentavos,
        lateFeesCentavos: 0,
        totalAmountCentavos: lineItem.totalAmountCentavos,
        remainingBalanceCentavos: lineItem.totalAmountCentavos,
        notes: reason ?? null,
        createdBy: createdByUserId,
      })
      .returning({ id: invoices.id })
      .then((rows) => rows[0]);

    if (insertedInvoice === undefined) {
      throw new NotFoundError("Reconnection fee invoice could not be created");
    }

    await tx.insert(invoiceLineItems).values({
      invoiceId: insertedInvoice.id,
      description: lineItem.description,
      quantity: lineItem.quantity,
      unitAmountCentavos: lineItem.unitAmountCentavos,
      totalAmountCentavos: lineItem.totalAmountCentavos,
    });

    return {
      invoice: await loadInvoiceDetail(tx, insertedInvoice.id),
      amountCentavos: lineItem.totalAmountCentavos,
    };
  });
}
