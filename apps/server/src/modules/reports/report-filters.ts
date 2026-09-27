// The filter vocabulary every report shares (S6-2).
//
// A report filter is only real when it reaches the SQL `where` clause. The audit
// found reports that accepted a parameter and ignored it — an aging report that
// returned every account whichever collector was asked for — so this module owns
// the ONE place a filter becomes a condition, and every report loader calls it.
//
// Two consequences the tests pin:
//   • supplying a filter changes the condition list, so it changes the query;
//   • omitting a filter adds no condition, so an unfiltered report stays complete.
//
// Dates are calendar days in the office's local timezone (see shared/date.ts). The
// range is INCLUSIVE at both ends as the user supplies it; a loader that needs a
// half-open range uses `toDateExclusive` from the resolved range, so an off-by-one
// day cannot creep in from a timezone conversion.

import { and, eq, gte, lte, type AnyColumn, type SQL } from "drizzle-orm";

import type { ServiceType } from "@bcis/shared";
import { serviceAccounts, subscriptionPlans } from "../../db/schema/subscribers";
import { formatDateOnly, addDaysToDay } from "../../shared/date";

/** The filters a report may carry. Every field is optional and narrows the result. */
export interface ReportFilters {
  /** First day of the range, inclusive. */
  fromDate?: string;
  /** Last day of the range, inclusive. */
  toDate?: string;
  /** Only accounts assigned to this collector. */
  collectorId?: string;
  /** Only accounts in this collection area. */
  areaId?: string;
  /** Only accounts on this plan. */
  planId?: string;
  /** Only accounts whose plan is of this service type. */
  serviceType?: ServiceType;
}

/** A date range the loaders can use directly, with the exclusive end pre-computed. */
export interface ReportDateRange {
  fromDate: string;
  toDate: string;
  /** The day after `toDate`: `[fromDate, toDateExclusive)` never includes the wrong day. */
  toDateExclusive: string;
}

/** Turns an inclusive calendar range into the shape the SQL comparisons want. */
export function toReportDateRange(fromDate: string, toDate: string): ReportDateRange {
  return { fromDate, toDate, toDateExclusive: addDaysToDay(toDate, 1) };
}

/** The month containing a calendar day, as an inclusive report range. */
export function monthRange(day: string): ReportDateRange {
  const year = day.slice(0, 4);
  const month = day.slice(5, 7);
  return toReportDateRange(`${year}-${month}-01`, lastDayOfMonth(day));
}

/** The calendar year containing a calendar day, as an inclusive report range. */
export function yearRange(day: string): ReportDateRange {
  const year = day.slice(0, 4);
  return toReportDateRange(`${year}-01-01`, `${year}-12-31`);
}

/**
 * The Monday..Sunday week containing a calendar day.
 *
 * Local calendar arithmetic (not UTC) so a Sunday stays in the week the office is
 * working in; `getDay()` is 0 for Sunday, so Sunday belongs to the week that began
 * six days earlier.
 */
export function weekRange(day: string): ReportDateRange {
  const localDay = new Date(`${day}T12:00:00`);
  const dayOfWeek = localDay.getDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;

  const monday = new Date(localDay);
  monday.setDate(localDay.getDate() - daysSinceMonday);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  return toReportDateRange(formatDateOnly(monday), formatDateOnly(sunday));
}

/** The last calendar day of the month containing a day. */
function lastDayOfMonth(day: string): string {
  const year = Number.parseInt(day.slice(0, 4), 10);
  const month = Number.parseInt(day.slice(5, 7), 10);
  // Day 0 of the next month is the last day of this one.
  return formatDateOnly(new Date(year, month, 0, 12, 0, 0));
}

/**
 * The range a report covers: the caller's two days when both are given, otherwise
 * the fallback window (the current week, month, or year). Supplying only one end is
 * a caller mistake the schema cannot catch on its own, so it falls back to the
 * whole window rather than creating a half-open range nobody asked for.
 */
export function resolveReportDateRange(
  filters: ReportFilters,
  fallback: ReportDateRange
): ReportDateRange {
  if (filters.fromDate !== undefined && filters.toDate !== undefined) {
    return toReportDateRange(filters.fromDate, filters.toDate);
  }
  return fallback;
}

// ─── Filters as SQL conditions ───────────────────────────────────────────────

/**
 * The account filters as SQL conditions, ready to spread into an `and(...)`.
 *
 * The names read from the joined `service_accounts` and `subscription_plans` rows,
 * so a loader that selects from payments or invoices gets the same filtering for
 * free once it joins those two tables.
 */
export function accountFilterConditions(filters: ReportFilters): SQL[] {
  const conditions: SQL[] = [];

  if (filters.collectorId !== undefined) {
    conditions.push(eq(serviceAccounts.assignedCollectorId, filters.collectorId));
  }
  if (filters.areaId !== undefined) {
    conditions.push(eq(serviceAccounts.areaId, filters.areaId));
  }
  if (filters.planId !== undefined) {
    conditions.push(eq(serviceAccounts.planId, filters.planId));
  }
  if (filters.serviceType !== undefined) {
    conditions.push(eq(subscriptionPlans.serviceType, filters.serviceType));
  }

  return conditions;
}

/**
 * Combines a list of conditions into one condition, or `undefined` when there are
 * none, so an unfiltered query passes `undefined` to `.where()` and reads every row.
 */
export function combineConditions(conditions: readonly SQL[]): SQL | undefined {
  return conditions.length === 0 ? undefined : and(...conditions);
}

/** The date conditions for an inclusive report range on one date column. */
export function dateWithinRange(column: AnyColumn, range: ReportDateRange): SQL {
  return and(gte(column, range.fromDate), lte(column, range.toDate)) as SQL;
}
