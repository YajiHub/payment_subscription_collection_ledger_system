// Read-only queries for the payment screens: history, detail, receipt lookup, and
// the payment summary a cashier sees before posting.
//
// Route handlers never touch the database directly — they call these functions.

import { and, asc, desc, eq, gt, gte, inArray, lte } from "drizzle-orm";

import type { PaymentMethod, PaymentStatus } from "@bcis/shared";
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
    verifiedAt: Date | null;
  } | null;
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
  method?: PaymentMethod;
  status?: PaymentStatus;
  dateFrom?: string;
  dateTo?: string;
}

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

/** Lists payments, newest first, with subscriber and cashier names attached. */
export async function listPayments(
  filters: ListPaymentsFilters = {},
  executor: DbExecutor = db
): Promise<PaymentSummary[]> {
  const conditions = [];

  if (filters.serviceAccountId !== undefined) {
    conditions.push(eq(payments.serviceAccountId, filters.serviceAccountId));
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

  const rows = await executor
    .select(paymentSummaryColumns)
    .from(payments)
    .innerJoin(serviceAccounts, eq(payments.serviceAccountId, serviceAccounts.id))
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
    .innerJoin(users, eq(payments.postedBy, users.id))
    .leftJoin(gcashPayments, eq(gcashPayments.paymentId, payments.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(payments.postedAt));

  return rows.map((row) => toPaymentSummary(row));
}

/** All payments for a service account, newest first. */
export async function listPaymentsForServiceAccount(
  serviceAccountId: string
): Promise<PaymentSummary[]> {
  return listPayments({ serviceAccountId });
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
    })
    .from(gcashPayments)
    .where(eq(gcashPayments.paymentId, summary.id))
    .limit(1)
    .then((rows) => rows[0]);

  return {
    ...summary,
    allocations,
    gcash: gcash ?? null,
  };
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
        inArray(invoices.status, ["posted", "partially_paid", "overdue"]),
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
