// Outstanding Receivables by Collector (report R6).
//
// It answers: which collector's assigned accounts carry the most overdue balance?
// Each invoice is aged with the SAME classifier the AR aging report uses, then the
// buckets are summed per collector. Two consequences the acceptance test pins:
//
//   • the totals across all collectors equal the AR aging grand total, because both
//     are the sum of the same outstanding invoices' remaining balances;
//   • the bucket boundaries stay exact and non-overlapping (31–60, 61–90, 90+).
//
// The columns are labelled with the SAME bucket names the AR aging report uses —
// "Current", "1-30 Days", "31-60 Days", "61-90 Days", "90+ Days" — and they are
// filled from those exact canonical buckets. Every outstanding centavo lands in
// one of them, so the five bucket columns reconcile to the collector's total. The
// earlier report dropped the not-yet-due and 1-30 columns while labelling the
// remainder "30-60", so its labelled columns did not sum to the total and a
// 31-day-past-due invoice was not where its label said (O7).
//
// An account with no assigned collector is grouped as "Unassigned" rather than
// dropped, so the totals still reconcile with the aging report.
//
// All arithmetic is on integer centavos.

import { eq } from "drizzle-orm";

import { OUTSTANDING_INVOICE_STATUSES, classifyInvoiceAge } from "@bcis/shared";
import { db, type DbExecutor } from "../../db/connection";
import { invoices } from "../../db/schema/billing";
import { serviceAccounts, subscribers, subscriptionPlans } from "../../db/schema/subscribers";
import { users } from "../../db/schema/users";
import { and, gt, inArray } from "drizzle-orm";
import type { OutstandingInvoiceAgingRow } from "../receivables/ar-aging.service";
import { accountFilterConditions, type ReportFilters } from "./report-filters";

/** A collector that has no accounts assigned to them. */
export const UNASSIGNED_COLLECTOR_NAME = "Unassigned";

/** One outstanding invoice together with the account's assigned collector. */
export interface OutstandingInvoiceWithCollectorRow extends OutstandingInvoiceAgingRow {
  collectorId: string | null;
  collectorName: string | null;
}

export interface CollectorOutstandingGroup {
  collectorId: string | null;
  collectorName: string;
  /** How many distinct service accounts owe money under this collector. */
  assignedAccountCount: number;
  totalOutstandingCentavos: number;
  /** Not yet past due. */
  currentCentavos: number;
  /** Invoices 1-30 days past due. */
  bucket_1_30_centavos: number;
  /** Invoices 31-60 days past due. */
  bucket_31_60_centavos: number;
  /** Invoices 61-90 days past due. */
  bucket_61_90_centavos: number;
  /** Invoices more than 90 days past due. */
  over_90_centavos: number;
}

export interface OutstandingByCollectorReport {
  asOfDate: string;
  groups: CollectorOutstandingGroup[];
  /** The same shape as a group, so the totals row needs no special handling. */
  totals: CollectorOutstandingGroup;
}

/** Adds one invoice to the right money bucket of a group. */
function addToBucket(
  group: CollectorOutstandingGroup,
  bucket: ReturnType<typeof classifyInvoiceAge>,
  amountCentavos: number
): void {
  switch (bucket) {
    case "current":
      group.currentCentavos += amountCentavos;
      break;
    case "1_to_30":
      group.bucket_1_30_centavos += amountCentavos;
      break;
    case "31_to_60":
      group.bucket_31_60_centavos += amountCentavos;
      break;
    case "61_to_90":
      group.bucket_61_90_centavos += amountCentavos;
      break;
    case "over_90":
      group.over_90_centavos += amountCentavos;
      break;
  }
}

/**
 * Groups outstanding invoices by the collector the account is assigned to.
 *
 * Pure and database-free, so the bucket arithmetic and the "totals equal the sum of
 * the remaining balances" guarantee are tested directly.
 */
export function buildOutstandingByCollector(
  invoiceRows: readonly OutstandingInvoiceWithCollectorRow[],
  asOfDate: Date
): OutstandingByCollectorReport {
  const groupsByCollector = new Map<string, CollectorOutstandingGroup>();
  const accountIdsByCollector = new Map<string, Set<string>>();

  for (const invoice of invoiceRows) {
    // The empty string keys the "no collector assigned" group without colliding
    // with the null id, which Map would otherwise treat as a single key.
    const groupKey = invoice.collectorId ?? "";
    const group = groupsByCollector.get(groupKey) ?? {
      collectorId: invoice.collectorId,
      collectorName: invoice.collectorName ?? UNASSIGNED_COLLECTOR_NAME,
      assignedAccountCount: 0,
      totalOutstandingCentavos: 0,
      currentCentavos: 0,
      bucket_1_30_centavos: 0,
      bucket_31_60_centavos: 0,
      bucket_61_90_centavos: 0,
      over_90_centavos: 0,
    };

    group.totalOutstandingCentavos += invoice.remainingBalanceCentavos;
    addToBucket(
      group,
      classifyInvoiceAge(new Date(invoice.dueDate), asOfDate),
      invoice.remainingBalanceCentavos
    );
    groupsByCollector.set(groupKey, group);

    const accountIds = accountIdsByCollector.get(groupKey) ?? new Set<string>();
    accountIds.add(invoice.serviceAccountId);
    accountIdsByCollector.set(groupKey, accountIds);
  }

  const groups = [...groupsByCollector.entries()]
    .map(([groupKey, group]) => ({
      ...group,
      assignedAccountCount: accountIdsByCollector.get(groupKey)?.size ?? 0,
    }))
    // The biggest debtors first: that is what management reads first.
    .sort((left, right) => {
      if (right.totalOutstandingCentavos !== left.totalOutstandingCentavos) {
        return right.totalOutstandingCentavos - left.totalOutstandingCentavos;
      }
      return left.collectorName.localeCompare(right.collectorName);
    });

  const totals = groups.reduce<CollectorOutstandingGroup>(
    (running, group) => ({
      collectorId: null,
      collectorName: "TOTAL",
      assignedAccountCount: running.assignedAccountCount + group.assignedAccountCount,
      totalOutstandingCentavos: running.totalOutstandingCentavos + group.totalOutstandingCentavos,
      currentCentavos: running.currentCentavos + group.currentCentavos,
      bucket_1_30_centavos: running.bucket_1_30_centavos + group.bucket_1_30_centavos,
      bucket_31_60_centavos: running.bucket_31_60_centavos + group.bucket_31_60_centavos,
      bucket_61_90_centavos: running.bucket_61_90_centavos + group.bucket_61_90_centavos,
      over_90_centavos: running.over_90_centavos + group.over_90_centavos,
    }),
    {
      collectorId: null,
      collectorName: "TOTAL",
      assignedAccountCount: 0,
      totalOutstandingCentavos: 0,
      currentCentavos: 0,
      bucket_1_30_centavos: 0,
      bucket_31_60_centavos: 0,
      bucket_61_90_centavos: 0,
      over_90_centavos: 0,
    }
  );

  return { asOfDate: asOfDate.toISOString().slice(0, 10), groups, totals };
}

/**
 * Every outstanding invoice, with the account's assigned collector (S6-2).
 *
 * A collector, area, plan, or service-type filter becomes a condition in the SQL
 * `where` clause, so a filtered report queries fewer invoices rather than filtering
 * an already-loaded set.
 */
export async function loadOutstandingInvoicesWithCollector(
  executor: DbExecutor = db,
  filters: ReportFilters = {}
): Promise<OutstandingInvoiceWithCollectorRow[]> {
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
      collectorId: serviceAccounts.assignedCollectorId,
      collectorName: users.fullName,
    })
    .from(invoices)
    .innerJoin(serviceAccounts, eq(invoices.serviceAccountId, serviceAccounts.id))
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
    .innerJoin(subscriptionPlans, eq(serviceAccounts.planId, subscriptionPlans.id))
    .leftJoin(users, eq(serviceAccounts.assignedCollectorId, users.id))
    .where(
      and(
        inArray(invoices.status, [...OUTSTANDING_INVOICE_STATUSES]),
        gt(invoices.remainingBalanceCentavos, 0),
        ...accountFilterConditions(filters)
      )
    );
}
