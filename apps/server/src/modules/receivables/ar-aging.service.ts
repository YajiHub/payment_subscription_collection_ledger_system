// Accounts-receivable aging: how long unpaid invoices have been past due.
//
// An invoice falls into exactly one bucket by how many whole days it is past its
// due date: current (not yet due), 1–30, 31–60, 61–90, or 90+ days. Buckets are
// summed per service account and totalled across all accounts.
//
// The grand total is, by construction, the sum of every outstanding invoice's
// remaining balance — the acceptance test pins that equality. All amounts are
// integer centavos.

import { and, eq, gt, inArray } from "drizzle-orm";

import { classifyInvoiceAge, type AgingBucket } from "@bcis/shared";
import { db, type DbExecutor } from "../../db/connection";
import { invoices } from "../../db/schema/billing";
import { serviceAccounts, subscribers, subscriptionPlans } from "../../db/schema/subscribers";

/** Invoices that still owe money — the only ones aging applies to. */
const OUTSTANDING_INVOICE_STATUSES = ["posted", "partially_paid", "overdue"] as const;

/** What aging shows for one service account. */
export interface AgingEntry {
  subscriberId: string;
  subscriberName: string;
  serviceAccountId: string;
  serviceAccountNumber: string;
  planName: string;
  currentCentavos: number;
  bucket_1_30_centavos: number;
  bucket_31_60_centavos: number;
  bucket_61_90_centavos: number;
  over_90_centavos: number;
  totalOutstandingCentavos: number;
}

export interface ArAgingTotals {
  current: number;
  bucket_1_30: number;
  bucket_31_60: number;
  bucket_61_90: number;
  over_90: number;
  grandTotal: number;
}

export interface ArAgingReport {
  asOfDate: string;
  entries: AgingEntry[];
  totals: ArAgingTotals;
}

/** One outstanding invoice as the aging query returns it. */
export interface OutstandingInvoiceAgingRow {
  invoiceId: string;
  serviceAccountId: string;
  remainingBalanceCentavos: number;
  dueDate: string;
  subscriberId: string;
  subscriberFirstName: string;
  subscriberLastName: string;
  serviceAccountNumber: string;
  planName: string;
}

/** Adds one amount to the right bucket of an entry. */
function addToBucket(entry: AgingEntry, bucket: AgingBucket, amountCentavos: number): void {
  switch (bucket) {
    case "current":
      entry.currentCentavos += amountCentavos;
      break;
    case "1_to_30":
      entry.bucket_1_30_centavos += amountCentavos;
      break;
    case "31_to_60":
      entry.bucket_31_60_centavos += amountCentavos;
      break;
    case "61_to_90":
      entry.bucket_61_90_centavos += amountCentavos;
      break;
    case "over_90":
      entry.over_90_centavos += amountCentavos;
      break;
  }
}

/**
 * Buckets outstanding invoices by age and sums them per service account.
 *
 * Pure and database-free, so the bucket arithmetic and the "grand total equals the
 * sum of the remaining balances" guarantee can be tested directly.
 */
export function buildAgingReport(
  invoiceRows: readonly OutstandingInvoiceAgingRow[],
  asOfDate: Date
): { entries: AgingEntry[]; totals: ArAgingTotals } {
  const agingByAccount = new Map<string, AgingEntry>();

  for (const invoice of invoiceRows) {
    const existing = agingByAccount.get(invoice.serviceAccountId) ?? {
      subscriberId: invoice.subscriberId,
      subscriberName: `${invoice.subscriberLastName}, ${invoice.subscriberFirstName}`,
      serviceAccountId: invoice.serviceAccountId,
      serviceAccountNumber: invoice.serviceAccountNumber,
      planName: invoice.planName,
      currentCentavos: 0,
      bucket_1_30_centavos: 0,
      bucket_31_60_centavos: 0,
      bucket_61_90_centavos: 0,
      over_90_centavos: 0,
      totalOutstandingCentavos: 0,
    };

    const bucket = classifyInvoiceAge(new Date(invoice.dueDate), asOfDate);
    addToBucket(existing, bucket, invoice.remainingBalanceCentavos);
    existing.totalOutstandingCentavos += invoice.remainingBalanceCentavos;

    agingByAccount.set(invoice.serviceAccountId, existing);
  }

  // Highest balance first: the biggest debtors are what management reads first.
  const entries = [...agingByAccount.values()].sort(
    (left, right) => right.totalOutstandingCentavos - left.totalOutstandingCentavos
  );

  const totals = entries.reduce<ArAgingTotals>(
    (running, entry) => ({
      current: running.current + entry.currentCentavos,
      bucket_1_30: running.bucket_1_30 + entry.bucket_1_30_centavos,
      bucket_31_60: running.bucket_31_60 + entry.bucket_31_60_centavos,
      bucket_61_90: running.bucket_61_90 + entry.bucket_61_90_centavos,
      over_90: running.over_90 + entry.over_90_centavos,
      grandTotal: running.grandTotal + entry.totalOutstandingCentavos,
    }),
    { current: 0, bucket_1_30: 0, bucket_31_60: 0, bucket_61_90: 0, over_90: 0, grandTotal: 0 }
  );

  return { entries, totals };
}

/** Loads every outstanding invoice with its subscriber and plan. */
export async function loadOutstandingInvoices(
  executor: DbExecutor = db
): Promise<OutstandingInvoiceAgingRow[]> {
  return executor
    .select({
      invoiceId: invoices.id,
      serviceAccountId: invoices.serviceAccountId,
      remainingBalanceCentavos: invoices.remainingBalanceCentavos,
      dueDate: invoices.dueDate,
      subscriberId: subscribers.id,
      subscriberFirstName: subscribers.firstName,
      subscriberLastName: subscribers.lastName,
      serviceAccountNumber: serviceAccounts.serviceAccountNumber,
      planName: subscriptionPlans.name,
    })
    .from(invoices)
    .innerJoin(serviceAccounts, eq(invoices.serviceAccountId, serviceAccounts.id))
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
    .innerJoin(subscriptionPlans, eq(serviceAccounts.planId, subscriptionPlans.id))
    .where(
      and(
        inArray(invoices.status, [...OUTSTANDING_INVOICE_STATUSES]),
        gt(invoices.remainingBalanceCentavos, 0)
      )
    );
}

/** Computes the AR aging report as of a given day (defaults to a caller-supplied one). */
export async function computeArAging(
  asOfDate: Date,
  executor: DbExecutor = db
): Promise<ArAgingReport> {
  const invoiceRows = await loadOutstandingInvoices(executor);
  const { entries, totals } = buildAgingReport(invoiceRows, asOfDate);

  return { asOfDate: asOfDate.toISOString().slice(0, 10), entries, totals };
}