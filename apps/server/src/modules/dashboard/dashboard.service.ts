// The Management Dashboard (Phase 8 §2).
//
// The dashboard is the first screen after login for the Administrator and the
// Manager, so it must answer "how are we doing?" at a glance and must never be
// wrong: a wrong total is a wrong decision.
//
// Two rules keep it honest:
//
//   1. Every figure is assembled by a PURE function from rows a loader fetched, so
//      the arithmetic is tested without a database.
//   2. The revenue and receivables figures reuse the SAME summing rules the reports
//      use (`summarizePayments`, `summarizeInvoices`, and the AR aging buckets).
//      The dashboard is a second view of one calculation, never a second
//      calculation that can drift from the report it summarises.
//
// A voided invoice is not revenue, a reversed payment is not money collected, and an
// empty database produces zeros — all three are pinned by tests.
//
// All amounts are integer centavos.

import { and, desc, gte, lt } from "drizzle-orm";

import type {
  CollectorBatchStatus,
  InvoiceStatus,
  PaymentMethod,
  PaymentStatus,
  ServiceAccountStatus,
} from "@bcis/shared";
import { db, type DbExecutor } from "../../db/connection";
import { billingRuns, invoices } from "../../db/schema/billing";
import { collectorBatches } from "../../db/schema/collections";
import { payments } from "../../db/schema/payments";
import { serviceAccounts } from "../../db/schema/subscribers";
import {
  formatDateOnly,
  isDayInMonthWindow,
  monthWindowOfDay,
  utcMidnightOfDay,
} from "../../shared/date";
import {
  buildAgingReport,
  loadOutstandingInvoices,
  type OutstandingInvoiceAgingRow,
} from "../receivables/ar-aging.service";
import { summarizePayments } from "../reports/daily-collection.service";
import { summarizeInvoices } from "../reports/monthly-billing.service";

export interface DashboardKpis {
  // Subscriber metrics
  totalActiveServiceAccounts: number;
  newServiceAccountsThisMonth: number;
  suspendedAccounts: number;
  terminatedAccounts: number;

  // Revenue metrics (current calendar month)
  totalInvoicedThisMonthCentavos: number;
  totalCollectedThisMonthCentavos: number;
  /** (collected / invoiced) * 100, to two decimals. 0 when nothing was invoiced. */
  collectionRatePercent: number;

  // AR metrics (as of today)
  totalOutstandingArCentavos: number;
  /** Remaining balances more than 30 days past due — the 31-60, 61-90, and 90+ buckets. */
  overdueOver30DaysCentavos: number;
  /** Remaining balances more than 90 days past due. */
  overdueOver90DaysCentavos: number;

  // Collection operations
  openCollectorBatches: number;
  submittedBatchesPendingReconciliation: number;

  // Last billing run info
  lastBillingRunDate: string | null;
  lastBillingRunAccountsCount: number | null;
}

/** A service account, reduced to what the subscriber metrics count. */
export interface ServiceAccountCountRow {
  status: ServiceAccountStatus;
  createdAt: Date;
}

/**
 * An invoice, reduced to what the revenue metrics sum.
 *
 * The three money columns are all loaded, even though the dashboard only shows the
 * invoiced total: it passes the same rows to the same `summarizeInvoices` rule the
 * Monthly Billing Summary uses, so the dashboard figure cannot drift from the report.
 */
export interface MonthlyInvoiceRow {
  status: InvoiceStatus;
  invoiceDate: string;
  totalAmountCentavos: number;
  paidAmountCentavos: number;
  remainingBalanceCentavos: number;
}

/** A payment, reduced to what the collection metrics sum. */
export interface MonthlyPaymentRow {
  status: PaymentStatus;
  paymentDate: string;
  paymentMethod: PaymentMethod;
  amountCentavos: number;
}

export interface BatchStatusRow {
  status: CollectorBatchStatus;
}

export interface LastBillingRunRow {
  ranAt: Date;
  totalServiceAccountsProcessed: number;
}

/**
 * Everything the dashboard reads, in one bundle.
 *
 * The loaders narrow each query to the month or the outstanding set so the
 * dashboard does not scan whole tables, but the RULES below re-check the ranges and
 * statuses themselves. The arithmetic therefore has exactly one home.
 */
export interface DashboardSnapshot {
  serviceAccounts: ServiceAccountCountRow[];
  monthInvoices: MonthlyInvoiceRow[];
  monthPayments: MonthlyPaymentRow[];
  outstandingInvoices: OutstandingInvoiceAgingRow[];
  batches: BatchStatusRow[];
  latestBillingRun: LastBillingRunRow | null;
}

/**
 * (collected / invoiced) * 100, rounded to two decimals.
 *
 * A month with no invoices has no collection rate at all: reporting 0% would read as
 * a collections failure, and dividing by zero would report nonsense. 0 is the honest
 * "nothing was billed" answer.
 */
export function computeCollectionRatePercent(
  invoicedCentavos: number,
  collectedCentavos: number
): number {
  if (invoicedCentavos <= 0) {
    return 0;
  }
  return Math.round((collectedCentavos / invoicedCentavos) * 10000) / 100;
}

/** Counts accounts by status from the loaded rows. */
function countByStatus(
  rows: readonly ServiceAccountCountRow[],
  status: ServiceAccountStatus
): number {
  return rows.filter((row) => row.status === status).length;
}

/**
 * Builds every KPI from the loaded snapshot.
 *
 * Pure and database-free: an empty snapshot produces all zeros, which is what the
 * dashboard must show on a fresh installation.
 */
export function buildDashboardKpis(
  snapshot: DashboardSnapshot,
  businessDay: string
): DashboardKpis {
  const monthWindow = monthWindowOfDay(businessDay);

  const invoicesThisMonth = snapshot.monthInvoices.filter((invoice) =>
    isDayInMonthWindow(invoice.invoiceDate, monthWindow)
  );
  const paymentsThisMonth = snapshot.monthPayments.filter((payment) =>
    isDayInMonthWindow(payment.paymentDate, monthWindow)
  );

  const invoiceTotals = summarizeInvoices(invoicesThisMonth);
  const paymentTotals = summarizePayments(paymentsThisMonth);

  // The aging report's own arithmetic, so the dashboard's overdue figures are the
  // same numbers the AR aging report shows for the same day.
  const aging = buildAgingReport(snapshot.outstandingInvoices, utcMidnightOfDay(businessDay));

  const overdueOver30DaysCentavos =
    aging.totals.bucket_31_60 + aging.totals.bucket_61_90 + aging.totals.over_90;
  const overdueOver90DaysCentavos = aging.totals.over_90;

  return {
    totalActiveServiceAccounts: countByStatus(snapshot.serviceAccounts, "active"),
    newServiceAccountsThisMonth: snapshot.serviceAccounts.filter((account) =>
      isDayInMonthWindow(formatDateOnly(account.createdAt), monthWindow)
    ).length,
    suspendedAccounts: countByStatus(snapshot.serviceAccounts, "suspended"),
    terminatedAccounts: countByStatus(snapshot.serviceAccounts, "terminated"),

    totalInvoicedThisMonthCentavos: invoiceTotals.totalInvoicedCentavos,
    totalCollectedThisMonthCentavos: paymentTotals.grandTotalCentavos,
    collectionRatePercent: computeCollectionRatePercent(
      invoiceTotals.totalInvoicedCentavos,
      paymentTotals.grandTotalCentavos
    ),

    totalOutstandingArCentavos: aging.totals.grandTotal,
    overdueOver30DaysCentavos,
    overdueOver90DaysCentavos,

    openCollectorBatches: snapshot.batches.filter((batch) => batch.status === "open").length,
    submittedBatchesPendingReconciliation: snapshot.batches.filter(
      (batch) => batch.status === "submitted"
    ).length,

    lastBillingRunDate:
      snapshot.latestBillingRun === null ? null : formatDateOnly(snapshot.latestBillingRun.ranAt),
    lastBillingRunAccountsCount:
      snapshot.latestBillingRun === null
        ? null
        : snapshot.latestBillingRun.totalServiceAccountsProcessed,
  };
}

/** The invoice statuses that count as revenue and as an outstanding balance. */
export const OUTSTANDING_INVOICE_STATUSES = ["posted", "partially_paid", "overdue"] as const;

/**
 * Loads everything the dashboard reads.
 *
 * The month queries are narrowed by day string (inclusive start, exclusive end), the
 * outstanding invoices by the same rules the AR aging report uses, and the batch and
 * billing-run reads are single small tables. No query here writes anything.
 */
export async function loadDashboardSnapshot(
  businessDay: string,
  executor: DbExecutor = db
): Promise<DashboardSnapshot> {
  const monthWindow = monthWindowOfDay(businessDay);

  const accountRows: ServiceAccountCountRow[] = await executor
    .select({ status: serviceAccounts.status, createdAt: serviceAccounts.createdAt })
    .from(serviceAccounts);

  const invoiceRows: MonthlyInvoiceRow[] = await executor
    .select({
      status: invoices.status,
      invoiceDate: invoices.invoiceDate,
      totalAmountCentavos: invoices.totalAmountCentavos,
      paidAmountCentavos: invoices.paidAmountCentavos,
      remainingBalanceCentavos: invoices.remainingBalanceCentavos,
    })
    .from(invoices)
    .where(
      and(
        gte(invoices.invoiceDate, monthWindow.monthStart),
        lt(invoices.invoiceDate, monthWindow.nextMonthStart)
      )
    );

  const paymentRows: MonthlyPaymentRow[] = await executor
    .select({
      status: payments.status,
      paymentDate: payments.paymentDate,
      paymentMethod: payments.paymentMethod,
      amountCentavos: payments.amountCentavos,
    })
    .from(payments)
    .where(
      and(
        gte(payments.paymentDate, monthWindow.monthStart),
        lt(payments.paymentDate, monthWindow.nextMonthStart)
      )
    );

  const outstandingInvoices = await loadOutstandingInvoices(executor);

  const batchRows: BatchStatusRow[] = await executor
    .select({ status: collectorBatches.status })
    .from(collectorBatches);

  const latestBillingRun = await executor
    .select({
      ranAt: billingRuns.ranAt,
      totalServiceAccountsProcessed: billingRuns.totalServiceAccountsProcessed,
    })
    .from(billingRuns)
    .orderBy(desc(billingRuns.ranAt))
    .limit(1)
    .then((rows) => rows[0]);

  return {
    serviceAccounts: accountRows,
    monthInvoices: invoiceRows,
    monthPayments: paymentRows,
    outstandingInvoices,
    batches: batchRows,
    latestBillingRun: latestBillingRun ?? null,
  };
}

/** The dashboard's KPI bundle for a given moment (defaults to now). */
export async function getDashboardKpis(
  now: Date = new Date(),
  executor: DbExecutor = db
): Promise<DashboardKpis> {
  const businessDay = formatDateOnly(now);
  const snapshot = await loadDashboardSnapshot(businessDay, executor);
  return buildDashboardKpis(snapshot, businessDay);
}
