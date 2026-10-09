// Read-only queries for the payment screens: history, detail, receipt lookup, and
// the payment summary a cashier sees before posting.
//
// Route handlers never touch the database directly — they call these functions.

import { and, asc, count, desc, eq, gt, gte, inArray, lte, type SQL } from "drizzle-orm";

import type {
  GcashVerificationStatus,
  PaymentMethod,
  PaymentStatus,
} from "@bcis/shared";
import { db, type DbExecutor } from "../../db/connection";
import { invoices } from "../../db/schema/billing";
import { gcashPayments, paymentAllocations, payments } from "../../db/schema/payments";
import { serviceAccounts, subscribers } from "../../db/schema/subscribers";
import { users } from "../../db/schema/users";
import { NotFoundError } from "../../shared/errors";
import { getCurrentBalanceCentavos } from "../ledger/ledger.service";

export interface PaymentSummary {
  id: string;
  receiptNumber: string;
  serviceAccountId: string;
  serviceAccountNumber: string;
  subscriberId: string;
  subscriberName: string;
  paymentMethod: PaymentMethod;
  status: PaymentStatus;
  amountCentavos: number;
  allocatedCentavos: number;
  advanceCreditCentavos: number;
  paymentDate: string;
  notes: string | null;
  gcashReferenceNumber: string | null;
  postedAt: Date;
  postedById: string;
  postedByName: string;
  reversedAt: Date | null;
  reversedById: string | null;
}

export interface PaymentAllocationSummary {
  invoiceId: string;
  invoiceNumber: string;
  allocatedAmountCentavos: number;
}

export interface PaymentDetail extends PaymentSummary {
  allocations: PaymentAllocationSummary[];
  gcash: {
    referenceNumber: string;
    senderGcashNumber: string | null;
    senderName: string | null;
    screenshotFilePath: string | null;
    /**
     * Where the claim stands in the verification workflow. DERIVED from the
     * payment's status, which is the single authority on whether the money counts:
     * `posted` reads as "verified", and a reversal reads as "reversed".
     */
    verificationStatus: GcashVerificationStatus;
    verifiedAt: Date | null;
    verifiedById: string | null;
    rejectedAt: Date | null;
    rejectedById: string | null;
    rejectionReason: string | null;
  } | null;
}

/**
 * The verification vocabulary (VERIFIED / REJECTED / …) for a stored payment
 * status. One function, so the screen, the API and the docs cannot drift.
 */
export function gcashVerificationStatus(status: PaymentStatus): GcashVerificationStatus {
  switch (status) {
    case "pending_verification":
      return "pending_verification";
    case "posted":
      return "verified";
    case "rejected":
      return "rejected";
    case "reversed":
      return "reversed";
  }
}

/** One row of the GCash verification queue (section 4.3, the verifier's worklist). */
export interface PendingGcashPaymentSummary {
  paymentId: string;
  receiptNumber: string;
  serviceAccountId: string;
  serviceAccountNumber: string;
  subscriberId: string;
  subscriberName: string;
  amountCentavos: number;
  paymentDate: string;
  recordedAt: Date;
  recordedByName: string;
  referenceNumber: string;
  senderGcashNumber: string | null;
  senderName: string | null;
  screenshotFilePath: string | null;
}

export interface OutstandingInvoiceSummary {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  status: string;
  totalAmountCentavos: number;
  paidAmountCentavos: number;
  remainingBalanceCentavos: number;
}

export interface ServiceAccountPaymentSummary {
  serviceAccountId: string;
  outstandingInvoices: OutstandingInvoiceSummary[];
  outstandingTotalCentavos: number;
  /** A positive advance credit (a negative ledger balance), or zero. */
  creditBalanceCentavos: number;
}

export interface ListPaymentsFilters {
  serviceAccountId?: string;
  /** One subscriber's payments across every service account they hold. */
  subscriberId?: string;
  method?: PaymentMethod;
  status?: PaymentStatus;
  dateFrom?: string;
  dateTo?: string;
  /** 1-based page number. Defaults to the first page. */
  page?: number;
  /** Rows per page, already bounded by the query schema's maximum. */
  pageSize?: number;
}

/** One page of payments, with the total so a caller can render "page 2 of 7". */
export interface PaymentPage {
  items: PaymentSummary[];
  page: number;
  pageSize: number;
  total: number;
}

/** The page size used when a caller does not ask for one. Matches the query schema. */
const DEFAULT_PAYMENT_PAGE_SIZE = 50;

const paymentSummaryColumns = {
  id: payments.id,
  receiptNumber: payments.receiptNumber,
  serviceAccountId: payments.serviceAccountId,
  serviceAccountNumber: serviceAccounts.serviceAccountNumber,
  subscriberId: subscribers.id,
  subscriberFirstName: subscribers.firstName,
  subscriberLastName: subscribers.lastName,
  paymentMethod: payments.paymentMethod,
  status: payments.status,
  amountCentavos: payments.amountCentavos,
  allocatedCentavos: payments.allocatedCentavos,
  advanceCreditCentavos: payments.advanceCreditCentavos,
  paymentDate: payments.paymentDate,
  notes: payments.notes,
  gcashReferenceNumber: gcashPayments.gcashReferenceNumber,
  postedAt: payments.postedAt,
  postedById: payments.postedBy,
  postedByName: users.fullName,
  reversedAt: payments.reversedAt,
  reversedById: payments.reversedBy,
};

type PaymentJoinedRow = {
  id: string;
  receiptNumber: string;
  serviceAccountId: string;
  serviceAccountNumber: string;
  subscriberId: string;
  subscriberFirstName: string;
  subscriberLastName: string;
  paymentMethod: PaymentMethod;
  status: PaymentStatus;
  amountCentavos: number;
  allocatedCentavos: number;
  advanceCreditCentavos: number;
  paymentDate: string;
  notes: string | null;
  gcashReferenceNumber: string | null;
  postedAt: Date;
  postedById: string;
  postedByName: string;
  reversedAt: Date | null;
  reversedById: string | null;
};

function toPaymentSummary(row: PaymentJoinedRow): PaymentSummary {
  return {
    id: row.id,
    receiptNumber: row.receiptNumber,
    serviceAccountId: row.serviceAccountId,
    serviceAccountNumber: row.serviceAccountNumber,
    subscriberId: row.subscriberId,
    subscriberName: `${row.subscriberLastName}, ${row.subscriberFirstName}`,
    paymentMethod: row.paymentMethod,
    status: row.status,
    amountCentavos: row.amountCentavos,
    allocatedCentavos: row.allocatedCentavos,
    advanceCreditCentavos: row.advanceCreditCentavos,
    paymentDate: row.paymentDate,
    notes: row.notes,
    gcashReferenceNumber: row.gcashReferenceNumber,
    postedAt: row.postedAt,
    postedById: row.postedById,
    postedByName: row.postedByName,
    reversedAt: row.reversedAt,
    reversedById: row.reversedById,
  };
}

/**
 * Lists payments, newest first, ONE PAGE AT A TIME (S8-1).
 *
 * `posted_at` with the receipt number as a tie-breaker is a stable order, so a page
 * boundary cannot drop or repeat a row between two requests. `total` counts every
 * payment the filters matched.
 */
export async function listPayments(
  filters: ListPaymentsFilters = {},
  executor: DbExecutor = db
): Promise<PaymentPage> {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? DEFAULT_PAYMENT_PAGE_SIZE;
  const conditions: SQL[] = [];

  if (filters.serviceAccountId !== undefined) {
    conditions.push(eq(payments.serviceAccountId, filters.serviceAccountId));
  }
  if (filters.subscriberId !== undefined) {
    conditions.push(eq(subscribers.id, filters.subscriberId));
  }
  if (filters.method !== undefined) {
    conditions.push(eq(payments.paymentMethod, filters.method));
  }
  if (filters.status !== undefined) {
    conditions.push(eq(payments.status, filters.status));
  }
  if (filters.dateFrom !== undefined) {
    conditions.push(gte(payments.paymentDate, filters.dateFrom));
  }
  if (filters.dateTo !== undefined) {
    conditions.push(lte(payments.paymentDate, filters.dateTo));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const joinedPayments = () =>
    executor
      .select(paymentSummaryColumns)
      .from(payments)
      .innerJoin(serviceAccounts, eq(payments.serviceAccountId, serviceAccounts.id))
      .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
      .innerJoin(users, eq(payments.postedBy, users.id))
      .leftJoin(gcashPayments, eq(gcashPayments.paymentId, payments.id));

  const rows = await joinedPayments()
    .where(where)
    .orderBy(desc(payments.postedAt), desc(payments.receiptNumber))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const totalRows = await executor
    .select({ value: count() })
    .from(payments)
    .innerJoin(serviceAccounts, eq(payments.serviceAccountId, serviceAccounts.id))
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
    .innerJoin(users, eq(payments.postedBy, users.id))
    .leftJoin(gcashPayments, eq(gcashPayments.paymentId, payments.id))
    .where(where);

  return {
    items: rows.map((row) => toPaymentSummary(row)),
    page,
    pageSize,
    total: totalRows[0]?.value ?? 0,
  };
}

/**
 * All payments for a service account, newest first, one page at a time.
 *
 * A receipt lookup sends the account id with no page arguments and gets the first
 * page, which is the behaviour the receipt screen has always relied on.
 */
export async function listPaymentsForServiceAccount(
  serviceAccountId: string,
  page?: number,
  pageSize?: number
): Promise<PaymentPage> {
  return listPayments({ serviceAccountId, page, pageSize });
}

async function loadPaymentSummary(
  executor: DbExecutor,
  whereCondition: ReturnType<typeof eq>
): Promise<PaymentSummary | undefined> {
  const row = await executor
    .select(paymentSummaryColumns)
    .from(payments)
    .innerJoin(serviceAccounts, eq(payments.serviceAccountId, serviceAccounts.id))
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
    .innerJoin(users, eq(payments.postedBy, users.id))
    .leftJoin(gcashPayments, eq(gcashPayments.paymentId, payments.id))
    .where(whereCondition)
    .limit(1)
    .then((rows) => rows[0]);

  return row === undefined ? undefined : toPaymentSummary(row);
}

/** Loads one payment with its allocations and, for GCash, its reference details. */
export async function getPaymentById(paymentId: string): Promise<PaymentDetail> {
  const summary = await loadPaymentSummary(db, eq(payments.id, paymentId));
  if (summary === undefined) {
    throw new NotFoundError("Payment not found");
  }

  return withDetail(db, summary);
}

/**
 * The id of the user who recorded a payment, or null when no such payment exists.
 *
 * Used by the GCash proof-access guard, which lets the person who recorded a claim
 * view the proof they attached without granting that to every `payments:read`
 * holder. A missing payment reads as null, so the guard refuses without revealing
 * whether the row exists.
 */
export async function getPaymentRecorderId(paymentId: string): Promise<string | null> {
  const row = await db
    .select({ postedBy: payments.postedBy })
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1)
    .then((rows) => rows[0]);

  return row?.postedBy ?? null;
}

/** Loads one payment by its Official Receipt number, for the receipt lookup. */
export async function getPaymentByReceiptNumber(receiptNumber: string): Promise<PaymentDetail> {
  const summary = await loadPaymentSummary(db, eq(payments.receiptNumber, receiptNumber));
  if (summary === undefined) {
    throw new NotFoundError(`No payment found for receipt ${receiptNumber}`);
  }

  return withDetail(db, summary);
}

async function withDetail(executor: DbExecutor, summary: PaymentSummary): Promise<PaymentDetail> {
  const allocations = await executor
    .select({
      invoiceId: paymentAllocations.invoiceId,
      invoiceNumber: invoices.invoiceNumber,
      allocatedAmountCentavos: paymentAllocations.allocatedAmountCentavos,
    })
    .from(paymentAllocations)
    .innerJoin(invoices, eq(paymentAllocations.invoiceId, invoices.id))
    .where(eq(paymentAllocations.paymentId, summary.id))
    .orderBy(asc(invoices.invoiceDate));

  const gcash = await executor
    .select({
      referenceNumber: gcashPayments.gcashReferenceNumber,
      senderGcashNumber: gcashPayments.senderGcashNumber,
      senderName: gcashPayments.senderName,
      screenshotFilePath: gcashPayments.screenshotFilePath,
      verifiedAt: gcashPayments.verifiedAt,
      verifiedById: gcashPayments.verifiedBy,
      rejectedAt: gcashPayments.rejectedAt,
      rejectedById: gcashPayments.rejectedBy,
      rejectionReason: gcashPayments.rejectionReason,
    })
    .from(gcashPayments)
    .where(eq(gcashPayments.paymentId, summary.id))
    .limit(1)
    .then((rows) => rows[0]);

  return {
    ...summary,
    allocations,
    gcash:
      gcash === undefined
        ? null
        : { ...gcash, verificationStatus: gcashVerificationStatus(summary.status) },
  };
}

/**
 * The GCash payments waiting for a verifier, oldest claim first — the two-pane
 * queue's left-hand list (section 4.3).
 *
 * A pending payment has not touched a balance, so this is a worklist, not a
 * financial report; it deliberately shows nothing that was already decided.
 */
export async function listPendingGcashPayments(
  executor: DbExecutor = db
): Promise<PendingGcashPaymentSummary[]> {
  const rows = await executor
    .select({
      paymentId: payments.id,
      receiptNumber: payments.receiptNumber,
      serviceAccountId: payments.serviceAccountId,
      serviceAccountNumber: serviceAccounts.serviceAccountNumber,
      subscriberId: subscribers.id,
      subscriberFirstName: subscribers.firstName,
      subscriberLastName: subscribers.lastName,
      amountCentavos: payments.amountCentavos,
      paymentDate: payments.paymentDate,
      recordedAt: payments.postedAt,
      recordedByName: users.fullName,
      referenceNumber: gcashPayments.gcashReferenceNumber,
      senderGcashNumber: gcashPayments.senderGcashNumber,
      senderName: gcashPayments.senderName,
      screenshotFilePath: gcashPayments.screenshotFilePath,
    })
    .from(payments)
    .innerJoin(gcashPayments, eq(gcashPayments.paymentId, payments.id))
    .innerJoin(serviceAccounts, eq(payments.serviceAccountId, serviceAccounts.id))
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
    .innerJoin(users, eq(payments.postedBy, users.id))
    .where(
      and(
        eq(payments.paymentMethod, "gcash"),
        eq(payments.status, "pending_verification")
      )
    )
    .orderBy(asc(payments.postedAt), asc(payments.receiptNumber));

  return rows.map((row) => ({
    paymentId: row.paymentId,
    receiptNumber: row.receiptNumber,
    serviceAccountId: row.serviceAccountId,
    serviceAccountNumber: row.serviceAccountNumber,
    subscriberId: row.subscriberId,
    subscriberName: `${row.subscriberLastName}, ${row.subscriberFirstName}`,
    amountCentavos: row.amountCentavos,
    paymentDate: row.paymentDate,
    recordedAt: row.recordedAt,
    recordedByName: row.recordedByName,
    referenceNumber: row.referenceNumber,
    senderGcashNumber: row.senderGcashNumber,
    senderName: row.senderName,
    screenshotFilePath: row.screenshotFilePath,
  }));
}

/**
 * What a cashier sees before posting: the invoices still owed, oldest first, and
 * any advance credit the account already holds.
 */
export async function getServiceAccountPaymentSummary(
  serviceAccountId: string
): Promise<ServiceAccountPaymentSummary> {
  const outstanding = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      invoiceDate: invoices.invoiceDate,
      dueDate: invoices.dueDate,
      status: invoices.status,
      totalAmountCentavos: invoices.totalAmountCentavos,
      paidAmountCentavos: invoices.paidAmountCentavos,
      remainingBalanceCentavos: invoices.remainingBalanceCentavos,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.serviceAccountId, serviceAccountId),
        inArray(invoices.status, ["unpaid", "partially_paid", "overdue"]),
        gt(invoices.remainingBalanceCentavos, 0)
      )
    )
    .orderBy(asc(invoices.invoiceDate), asc(invoices.id));

  const ledgerBalance = await getCurrentBalanceCentavos(db, serviceAccountId);

  return {
    serviceAccountId,
    outstandingInvoices: outstanding,
    outstandingTotalCentavos: outstanding.reduce(
      (runningTotal, invoice) => runningTotal + invoice.remainingBalanceCentavos,
      0
    ),
    creditBalanceCentavos: ledgerBalance < 0 ? -ledgerBalance : 0,
  };
}
