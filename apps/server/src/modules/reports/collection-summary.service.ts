// The Weekly (R7) and Annual (R8) Collection Summaries.
//
// They answer the same question the Daily Collection Summary answers — what came in
// — over a week and over a year. The summing rule is deliberately the SAME one:
// `summarizePayments` from daily-collection.service.ts, which counts only POSTED
// payments and splits the cash drawer from GCash. A weekly figure therefore cannot
// disagree with the seven daily figures that make it up, and the annual figure
// cannot disagree with the twelve monthly ones.
//
// The periods are contiguous in the report: a day or a month with no collection is
// still listed, with zeros, so a gap is visible rather than silently missing.
//
// All arithmetic is on integer centavos.

import { asc, eq } from "drizzle-orm";

import { getMonthYearLabel, type PaymentMethod, type PaymentStatus } from "@bcis/shared";
import { db, type DbExecutor } from "../../db/connection";
import { payments } from "../../db/schema/payments";
import { serviceAccounts, subscriptionPlans } from "../../db/schema/subscribers";
import { addDaysToDay } from "../../shared/date";
import {
  summarizePayments,
  type PaymentTotals,
} from "./daily-collection.service";
import {
  accountFilterConditions,
  combineConditions,
  dateWithinRange,
  monthRange,
  resolveReportDateRange,
  toReportDateRange,
  weekRange,
  yearRange,
  type ReportFilters,
} from "./report-filters";

/** One payment, reduced to the fields the summing rule reads plus its own day. */
export interface CollectionSummaryPaymentRow {
  paymentDate: string;
  paymentMethod: PaymentMethod;
  status: PaymentStatus;
  amountCentavos: number;
}

/** One period of the summary: one day of a week, or one month of a year. */
export interface CollectionPeriodSummary {
  /** A day ("2025-01-24") for a week, or a month ("2025-01") for a year. */
  periodKey: string;
  periodLabel: string;
  totals: PaymentTotals;
}

export interface CollectionRangeSummary {
  fromDate: string;
  toDate: string;
  periods: CollectionPeriodSummary[];
  totals: PaymentTotals;
}

/** How a period is keyed, labelled, and iterated so an empty period is still listed. */
interface PeriodStepper {
  keyOfDay(day: string): string;
  labelOf(key: string): string;
  /** Every period between the two ends, inclusive, in order. */
  keysBetween(fromDate: string, toDate: string): string[];
}

/** Day-keyed periods: one line per day, so a quiet day shows zeros. */
const DAILY_STEPPER: PeriodStepper = {
  keyOfDay: (day) => day,
  labelOf: (key) => key,
  keysBetween: (fromDate, toDate) => {
    const keys: string[] = [];
    for (let day = fromDate; day <= toDate; day = addDaysToDay(day, 1)) {
      keys.push(day);
    }
    return keys;
  },
};

/** Month-keyed periods: one line per month, so a quiet month shows zeros. */
const MONTHLY_STEPPER: PeriodStepper = {
  keyOfDay: (day) => day.slice(0, 7),
  labelOf: (key) => {
    const year = Number.parseInt(key.slice(0, 4), 10);
    const month = Number.parseInt(key.slice(5, 7), 10);
    return getMonthYearLabel(month, year);
  },
  keysBetween: (fromDate, toDate) => {
    const keys: string[] = [];
    const endKey = toDate.slice(0, 7);

    for (
      let cursor = monthRange(fromDate).fromDate;
      cursor.slice(0, 7) <= endKey;
      cursor = addMonthsToFirstDay(cursor)
    ) {
      keys.push(cursor.slice(0, 7));
    }
    return keys;
  },
};

/** The first day of the month after the one the given first-day belongs to. */
function addMonthsToFirstDay(firstDayOfMonth: string): string {
  const year = Number.parseInt(firstDayOfMonth.slice(0, 4), 10);
  const month = Number.parseInt(firstDayOfMonth.slice(5, 7), 10);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
}

/**
 * Builds a summary over a set of payment rows, grouped by period.
 *
 * Pure and database-free: every period's totals and the grand total come from the
 * one `summarizePayments` rule, so the periods always add up to the grand total.
 */
export function buildCollectionRangeSummary(
  paymentRows: readonly CollectionSummaryPaymentRow[],
  range: { fromDate: string; toDate: string },
  stepper: PeriodStepper = DAILY_STEPPER
): CollectionRangeSummary {
  const rowsByPeriod = new Map<string, CollectionSummaryPaymentRow[]>();
  for (const payment of paymentRows) {
    const key = stepper.keyOfDay(payment.paymentDate);
    const bucket = rowsByPeriod.get(key) ?? [];
    bucket.push(payment);
    rowsByPeriod.set(key, bucket);
  }

  const periods: CollectionPeriodSummary[] = stepper
    .keysBetween(range.fromDate, range.toDate)
    .map((periodKey) => ({
      periodKey,
      periodLabel: stepper.labelOf(periodKey),
      totals: summarizePayments(rowsByPeriod.get(periodKey) ?? []),
    }));

  // The grand total is summed from the raw rows, not from the period totals, so it
  // cannot drift if a payment ever falls outside the listed periods.
  return {
    fromDate: range.fromDate,
    toDate: range.toDate,
    periods,
    totals: summarizePayments(paymentRows),
  };
}

export interface WeeklyCollectionReport extends CollectionRangeSummary {
  /** The Monday the reported week starts on. */
  weekStartDate: string;
}

/** R7 — the week's collections, day by day. */
export function buildWeeklyCollectionReport(
  paymentRows: readonly CollectionSummaryPaymentRow[],
  range: { fromDate: string; toDate: string }
): WeeklyCollectionReport {
  return {
    ...buildCollectionRangeSummary(paymentRows, range, DAILY_STEPPER),
    weekStartDate: range.fromDate,
  };
}

export interface AnnualCollectionReport extends CollectionRangeSummary {
  year: number;
}

/** R8 — the year's collections, month by month. */
export function buildAnnualCollectionReport(
  paymentRows: readonly CollectionSummaryPaymentRow[],
  year: number
): AnnualCollectionReport {
  const range = yearRange(`${year}-01-01`);
  return { ...buildCollectionRangeSummary(paymentRows, range, MONTHLY_STEPPER), year };
}

/** The default week: the Monday..Sunday containing the office's business day. */
export function resolveWeeklyRange(filters: ReportFilters, today: string): ReturnType<typeof toReportDateRange> {
  return resolveReportDateRange(filters, weekRange(today));
}

/** The default range for a revenue-style report: the current calendar month. */
export function resolveMonthlyRange(
  filters: ReportFilters,
  today: string
): ReturnType<typeof toReportDateRange> {
  return resolveReportDateRange(filters, monthRange(today));
}

/**
 * The payments in a date range, narrowed by whichever account filters were supplied.
 *
 * The filters reach the SQL `where` clause: a collector filter adds
 * `service_accounts.assigned_collector_id = $1`, and so on. The same rows feed both
 * the weekly and the annual summary, so the two reports can never disagree.
 */
export async function loadCollectionSummaryRows(
  range: { fromDate: string; toDate: string },
  filters: ReportFilters,
  executor: DbExecutor = db
): Promise<CollectionSummaryPaymentRow[]> {
  return executor
    .select({
      paymentDate: payments.paymentDate,
      paymentMethod: payments.paymentMethod,
      status: payments.status,
      amountCentavos: payments.amountCentavos,
    })
    .from(payments)
    .innerJoin(serviceAccounts, eq(payments.serviceAccountId, serviceAccounts.id))
    .innerJoin(subscriptionPlans, eq(serviceAccounts.planId, subscriptionPlans.id))
    .where(
      combineConditions([
        dateWithinRange(payments.paymentDate, toReportDateRange(range.fromDate, range.toDate)),
        ...accountFilterConditions(filters),
      ])
    )
    .orderBy(asc(payments.paymentDate));
}
