// Revenue by Plan (R9), by Service Type (R10), and by Area (R11).
//
// The three reports are one calculation grouped three ways, so a plan figure and a
// service-type figure can never disagree: both are the sum of the same invoices.
//
// The basis is BILLED revenue — the invoices raised for the date range — because
// that is what the Monthly Billing Summary reports and the two must reconcile. The
// rule for which invoices count is the same one too: a VOIDED invoice is not
// revenue and is excluded, every other status is included.
//
// Alongside what was billed, each group also shows what was collected and what is
// still outstanding, so a plan that sells well but is never paid is visible.
//
// All arithmetic is on integer centavos.

import { asc, eq, ne } from "drizzle-orm";

import type { InvoiceStatus, ServiceType } from "@bcis/shared";
import { db, type DbExecutor } from "../../db/connection";
import { invoices } from "../../db/schema/billing";
import { collectionAreas } from "../../db/schema/areas";
import { serviceAccounts, subscriptionPlans } from "../../db/schema/subscribers";
import {
  accountFilterConditions,
  combineConditions,
  dateWithinRange,
  toReportDateRange,
  type ReportDateRange,
  type ReportFilters,
} from "./report-filters";

/** A service account with no collection area shows under this label, never dropped. */
export const UNASSIGNED_AREA_NAME = "Unassigned";

/** Which column the revenue is grouped by. */
export const REVENUE_DIMENSIONS = ["plan", "service_type", "area"] as const;
export type RevenueDimension = (typeof REVENUE_DIMENSIONS)[number];

/** One invoice as the revenue query returns it. */
export interface RevenueInvoiceRow {
  invoiceDate: string;
  planName: string;
  serviceType: ServiceType;
  areaName: string | null;
  totalAmountCentavos: number;
  paidAmountCentavos: number;
  remainingBalanceCentavos: number;
  status: InvoiceStatus;
}

export interface RevenueGroup {
  /** The plan name, the service type, or the area name. */
  groupKey: string;
  groupLabel: string;
  invoiceCount: number;
  billedCentavos: number;
  collectedCentavos: number;
  outstandingCentavos: number;
}

export interface RevenueReport {
  dimension: RevenueDimension;
  fromDate: string;
  toDate: string;
  groups: RevenueGroup[];
  /** The same shape as a group, so the totals row needs no special handling. */
  totals: RevenueGroup;
}

/** The group key and label for an invoice under the chosen dimension. */
function groupIdentityOf(
  invoice: RevenueInvoiceRow,
  dimension: RevenueDimension
): { groupKey: string; groupLabel: string } {
  switch (dimension) {
    case "plan":
      return { groupKey: invoice.planName, groupLabel: invoice.planName };
    case "service_type":
      return { groupKey: invoice.serviceType, groupLabel: serviceTypeLabel(invoice.serviceType) };
    case "area":
      return {
        groupKey: invoice.areaName ?? UNASSIGNED_AREA_NAME,
        groupLabel: invoice.areaName ?? UNASSIGNED_AREA_NAME,
      };
  }
}

/** Human-readable service types, kept local so the report reads without a lookup. */
function serviceTypeLabel(serviceType: ServiceType): string {
  switch (serviceType) {
    case "internet":
      return "Internet";
    case "cable_tv":
      return "Cable TV";
    case "bundle":
      return "Bundle";
  }
}

/**
 * Groups the invoices of a date range by one dimension.
 *
 * Pure and database-free, so the grouping, the void exclusion, and the
 * "group totals add up to the grand total" guarantee are tested directly.
 */
export function buildRevenueReport(
  invoiceRows: readonly RevenueInvoiceRow[],
  dimension: RevenueDimension,
  range: { fromDate: string; toDate: string }
): RevenueReport {
  const groupsByKey = new Map<string, RevenueGroup>();

  for (const invoice of invoiceRows) {
    if (invoice.status === "void") {
      continue;
    }

    const { groupKey, groupLabel } = groupIdentityOf(invoice, dimension);
    const group = groupsByKey.get(groupKey) ?? {
      groupKey,
      groupLabel,
      invoiceCount: 0,
      billedCentavos: 0,
      collectedCentavos: 0,
      outstandingCentavos: 0,
    };

    group.invoiceCount += 1;
    group.billedCentavos += invoice.totalAmountCentavos;
    group.collectedCentavos += invoice.paidAmountCentavos;
    group.outstandingCentavos += invoice.remainingBalanceCentavos;
    groupsByKey.set(groupKey, group);
  }

  const groups = [...groupsByKey.values()].sort((left, right) => {
    if (right.billedCentavos !== left.billedCentavos) {
      return right.billedCentavos - left.billedCentavos;
    }
    return left.groupLabel.localeCompare(right.groupLabel);
  });

  return {
    dimension,
    fromDate: range.fromDate,
    toDate: range.toDate,
    groups,
    totals: groups.reduce<RevenueGroup>(
      (running, group) => ({
        groupKey: "TOTAL",
        groupLabel: "TOTAL",
        invoiceCount: running.invoiceCount + group.invoiceCount,
        billedCentavos: running.billedCentavos + group.billedCentavos,
        collectedCentavos: running.collectedCentavos + group.collectedCentavos,
        outstandingCentavos: running.outstandingCentavos + group.outstandingCentavos,
      }),
      {
        groupKey: "TOTAL",
        groupLabel: "TOTAL",
        invoiceCount: 0,
        billedCentavos: 0,
        collectedCentavos: 0,
        outstandingCentavos: 0,
      }
    ),
  };
}

/**
 * The invoices dated in a range, narrowed by whichever account filters were supplied.
 *
 * The date column is the INVOICE DATE, not the billing period: a reconnection fee
 * raised this month is this month's revenue, and it carries no billing period at all.
 */
export async function loadRevenueInvoiceRows(
  range: ReportDateRange,
  filters: ReportFilters,
  executor: DbExecutor = db
): Promise<RevenueInvoiceRow[]> {
  return executor
    .select({
      invoiceDate: invoices.invoiceDate,
      planName: subscriptionPlans.name,
      serviceType: subscriptionPlans.serviceType,
      areaName: collectionAreas.name,
      totalAmountCentavos: invoices.totalAmountCentavos,
      paidAmountCentavos: invoices.paidAmountCentavos,
      remainingBalanceCentavos: invoices.remainingBalanceCentavos,
      status: invoices.status,
    })
    .from(invoices)
    .innerJoin(serviceAccounts, eq(invoices.serviceAccountId, serviceAccounts.id))
    .innerJoin(subscriptionPlans, eq(serviceAccounts.planId, subscriptionPlans.id))
    .leftJoin(collectionAreas, eq(serviceAccounts.areaId, collectionAreas.id))
    .where(
      combineConditions([
        dateWithinRange(invoices.invoiceDate, toReportDateRange(range.fromDate, range.toDate)),
        ne(invoices.status, "void"),
        ...accountFilterConditions(filters),
      ])
    )
    .orderBy(asc(invoices.invoiceNumber));
}
