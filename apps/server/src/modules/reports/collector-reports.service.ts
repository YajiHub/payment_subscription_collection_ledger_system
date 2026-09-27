// Collector Assignment (R12) and Collector Performance (R13).
//
// R12 answers "who covers whom": every active service account with the collector
// assigned to it, the area it sits in, and the plan it is on. It is a snapshot — an
// assignment has no date range — so it accepts the account filters only.
//
// R13 answers "how did each collector do": how much each collector's accounts paid
// over a date range, split cash from GCash by the same rule the collection reports
// use, alongside the remittance their batches declare and the variance against it.
//
// An account with no assigned collector is grouped as "Unassigned" rather than
// dropped, so the totals still describe the whole book.
//
// All arithmetic is on integer centavos.

import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";

import type { PaymentMethod, ServiceAccountStatus, ServiceType } from "@bcis/shared";
import { db, type DbExecutor } from "../../db/connection";
import { collectionAreas } from "../../db/schema/areas";
import { collectorBatches } from "../../db/schema/collections";
import { payments } from "../../db/schema/payments";
import { serviceAccounts, subscribers, subscriptionPlans } from "../../db/schema/subscribers";
import { users } from "../../db/schema/users";
import {
  accountFilterConditions,
  combineConditions,
  dateWithinRange,
  toReportDateRange,
  type ReportFilters,
} from "./report-filters";

/** The name an account with no assigned collector is listed under. */
export const UNASSIGNED_COLLECTOR_NAME = "Unassigned";

/** Accounts with one of these statuses still carry an assignment worth reporting. */
const ASSIGNED_ACCOUNT_STATUSES = ["active", "suspended", "pending"] as const;

// ─── R12 — Collector Assignment ──────────────────────────────────────────────

/** One service account together with the collector assigned to it. */
export interface CollectorAssignmentLine {
  collectorId: string | null;
  collectorName: string;
  subscriberName: string;
  serviceAccountNumber: string;
  planName: string;
  serviceType: ServiceType;
  areaName: string;
  accountStatus: ServiceAccountStatus;
}

export interface CollectorAssignmentReport {
  lines: CollectorAssignmentLine[];
  accountCount: number;
  /** How many distinct collectors cover at least one listed account. */
  collectorCount: number;
  /** How many distinct areas the listed accounts fall into. */
  areaCount: number;
}

/**
 * Builds the assignment list from service-account rows.
 *
 * Pure and database-free: it sorts by collector then account so two runs of the
 * report always agree, and counts the distinct collectors and areas.
 */
export function buildCollectorAssignmentReport(
  rows: readonly CollectorAssignmentLine[]
): CollectorAssignmentReport {
  const lines = [...rows].sort((left, right) => {
    const byCollector = left.collectorName.localeCompare(right.collectorName);
    if (byCollector !== 0) {
      return byCollector;
    }
    return left.serviceAccountNumber.localeCompare(right.serviceAccountNumber);
  });

  return {
    lines,
    accountCount: lines.length,
    collectorCount: new Set(lines.map((line) => line.collectorName)).size,
    areaCount: new Set(lines.map((line) => line.areaName)).size,
  };
}

/**
 * The active service accounts with their collector, area, and plan.
 *
 * The filters reach the SQL `where` clause; there is no date range because an
 * assignment is a current fact, not something that happened on a day.
 */
export async function loadCollectorAssignmentRows(
  filters: ReportFilters,
  executor: DbExecutor = db
): Promise<CollectorAssignmentLine[]> {
  const rows = await executor
    .select({
      collectorId: serviceAccounts.assignedCollectorId,
      collectorName: users.fullName,
      subscriberFirstName: subscribers.firstName,
      subscriberLastName: subscribers.lastName,
      serviceAccountNumber: serviceAccounts.serviceAccountNumber,
      planName: subscriptionPlans.name,
      serviceType: subscriptionPlans.serviceType,
      areaName: collectionAreas.name,
      accountStatus: serviceAccounts.status,
    })
    .from(serviceAccounts)
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
    .innerJoin(subscriptionPlans, eq(serviceAccounts.planId, subscriptionPlans.id))
    .leftJoin(users, eq(serviceAccounts.assignedCollectorId, users.id))
    .leftJoin(collectionAreas, eq(serviceAccounts.areaId, collectionAreas.id))
    .where(
      combineConditions([
        inArray(serviceAccounts.status, [...ASSIGNED_ACCOUNT_STATUSES]),
        ...accountFilterConditions(filters),
      ])
    )
    .orderBy(asc(subscribers.lastName), asc(serviceAccounts.serviceAccountNumber));

  return rows.map((row) => ({
    collectorId: row.collectorId,
    collectorName: row.collectorName ?? UNASSIGNED_COLLECTOR_NAME,
    subscriberName: `${row.subscriberLastName}, ${row.subscriberFirstName}`,
    serviceAccountNumber: row.serviceAccountNumber,
    planName: row.planName,
    serviceType: row.serviceType,
    areaName: row.areaName ?? UNASSIGNED_COLLECTOR_NAME,
    accountStatus: row.accountStatus,
  }));
}

// ─── R13 — Collector Performance ─────────────────────────────────────────────

/** One posted payment, reduced to what the performance report reads. */
export interface CollectorPaymentRow {
  collectorId: string | null;
  collectorName: string | null;
  paymentMethod: PaymentMethod;
  amountCentavos: number;
}

/** One collector batch, reduced to its remittance figures. */
export interface CollectorBatchRow {
  collectorId: string;
  collectorName: string;
  expectedRemittanceCentavos: number;
  actualRemittanceCentavos: number | null;
  varianceCentavos: number | null;
}

export interface CollectorPerformanceGroup {
  collectorId: string | null;
  collectorName: string;
  assignedAccountCount: number;
  paymentCount: number;
  collectedCentavos: number;
  cashCentavos: number;
  gcashCentavos: number;
  batchCount: number;
  expectedRemittanceCentavos: number;
  actualRemittanceCentavos: number;
  varianceCentavos: number;
}

export interface CollectorPerformanceReport {
  fromDate: string;
  toDate: string;
  groups: CollectorPerformanceGroup[];
  /** The same shape as a group, so the totals row needs no special handling. */
  totals: CollectorPerformanceGroup;
}

/** A blank group, so the accumulator below reads as a running sum rather than a wall. */
function emptyPerformanceGroup(
  collectorId: string | null,
  collectorName: string
): CollectorPerformanceGroup {
  return {
    collectorId,
    collectorName,
    assignedAccountCount: 0,
    paymentCount: 0,
    collectedCentavos: 0,
    cashCentavos: 0,
    gcashCentavos: 0,
    batchCount: 0,
    expectedRemittanceCentavos: 0,
    actualRemittanceCentavos: 0,
    varianceCentavos: 0,
  };
}

/**
 * Groups a range's posted payments and the collectors' batches by collector.
 *
 * Pure and database-free. Only POSTED payments count, using the same rule as every
 * other collection report, so a reversed payment is not "collected" here either.
 *
 * A batch is attributed to its collector only when the collector already appears in
 * the payment groups. That is what keeps an area, plan, or service-type filter
 * honest: those filters narrow the accounts, and the remittance figures follow the
 * narrowed set rather than contradicting it.
 */
export function buildCollectorPerformanceReport(
  paymentRows: readonly CollectorPaymentRow[],
  batchRows: readonly CollectorBatchRow[],
  range: { fromDate: string; toDate: string }
): CollectorPerformanceReport {
  const groupsByCollector = new Map<string, CollectorPerformanceGroup>();

  function groupFor(collectorId: string | null, collectorName: string): CollectorPerformanceGroup {
    // The empty string keys the "no collector assigned" group without colliding
    // with the null id, which Map would otherwise treat as a single key.
    const groupKey = collectorId ?? "";
    const existing = groupsByCollector.get(groupKey) ?? emptyPerformanceGroup(collectorId, collectorName);
    groupsByCollector.set(groupKey, existing);
    return existing;
  }

  for (const payment of paymentRows) {
    const group = groupFor(payment.collectorId, payment.collectorName ?? UNASSIGNED_COLLECTOR_NAME);
    group.paymentCount += 1;
    group.collectedCentavos += payment.amountCentavos;
    if (payment.paymentMethod === "cash") {
      group.cashCentavos += payment.amountCentavos;
    } else if (payment.paymentMethod === "gcash") {
      group.gcashCentavos += payment.amountCentavos;
    }
  }

  const collectorIdsInReport = new Set([...groupsByCollector.values()].map((group) => group.collectorId));

  for (const batch of batchRows) {
    if (!collectorIdsInReport.has(batch.collectorId)) {
      continue;
    }
    const group = groupFor(batch.collectorId, batch.collectorName);
    group.batchCount += 1;
    group.expectedRemittanceCentavos += batch.expectedRemittanceCentavos;
    group.actualRemittanceCentavos += batch.actualRemittanceCentavos ?? 0;
    group.varianceCentavos += batch.varianceCentavos ?? 0;
  }

  const groups = [...groupsByCollector.values()].sort((left, right) => {
    if (right.collectedCentavos !== left.collectedCentavos) {
      return right.collectedCentavos - left.collectedCentavos;
    }
    return left.collectorName.localeCompare(right.collectorName);
  });

  const totals = groups.reduce<CollectorPerformanceGroup>(
    (running, group) => ({
      collectorId: null,
      collectorName: "TOTAL",
      assignedAccountCount: running.assignedAccountCount + group.assignedAccountCount,
      paymentCount: running.paymentCount + group.paymentCount,
      collectedCentavos: running.collectedCentavos + group.collectedCentavos,
      cashCentavos: running.cashCentavos + group.cashCentavos,
      gcashCentavos: running.gcashCentavos + group.gcashCentavos,
      batchCount: running.batchCount + group.batchCount,
      expectedRemittanceCentavos:
        running.expectedRemittanceCentavos + group.expectedRemittanceCentavos,
      actualRemittanceCentavos: running.actualRemittanceCentavos + group.actualRemittanceCentavos,
      varianceCentavos: running.varianceCentavos + group.varianceCentavos,
    }),
    emptyPerformanceGroup(null, "TOTAL")
  );

  return { fromDate: range.fromDate, toDate: range.toDate, groups, totals };
}

/**
 * Fills in each collector's assigned account count.
 *
 * It is a separate step because the count is "accounts assigned today", which has
 * no date range, while the money columns are range-bound. Keeping them apart is
 * what stops a filtered payment range from silently changing the headcount.
 */
export function withAssignedAccountCounts(
  report: CollectorPerformanceReport,
  accountsPerCollector: ReadonlyMap<string, number>
): CollectorPerformanceReport {
  const groups = report.groups.map((group) => ({
    ...group,
    assignedAccountCount: accountsPerCollector.get(group.collectorId ?? "") ?? 0,
  }));

  return {
    ...report,
    groups,
    totals: {
      ...report.totals,
      assignedAccountCount: groups.reduce((sum, group) => sum + group.assignedAccountCount, 0),
    },
  };
}

/** Posted payments in a range, with the collecting account's assigned collector. */
export async function loadCollectorPaymentRows(
  range: { fromDate: string; toDate: string },
  filters: ReportFilters,
  executor: DbExecutor = db
): Promise<CollectorPaymentRow[]> {
  const rows = await executor
    .select({
      collectorId: serviceAccounts.assignedCollectorId,
      collectorName: users.fullName,
      paymentMethod: payments.paymentMethod,
      amountCentavos: payments.amountCentavos,
    })
    .from(payments)
    .innerJoin(serviceAccounts, eq(payments.serviceAccountId, serviceAccounts.id))
    .innerJoin(subscriptionPlans, eq(serviceAccounts.planId, subscriptionPlans.id))
    .leftJoin(users, eq(serviceAccounts.assignedCollectorId, users.id))
    .where(
      combineConditions([
        eq(payments.status, "posted"),
        dateWithinRange(payments.paymentDate, toReportDateRange(range.fromDate, range.toDate)),
        ...accountFilterConditions(filters),
      ])
    )
    .orderBy(asc(payments.paymentDate));

  return rows.map((row) => ({
    collectorId: row.collectorId,
    collectorName: row.collectorName,
    paymentMethod: row.paymentMethod,
    amountCentavos: row.amountCentavos,
  }));
}

/** Batches whose collection date falls in a range, for the remittance columns. */
export async function loadCollectorBatchRows(
  range: { fromDate: string; toDate: string },
  filters: ReportFilters,
  executor: DbExecutor = db
): Promise<CollectorBatchRow[]> {
  const conditions = [
    gte(collectorBatches.collectionDate, range.fromDate),
    lte(collectorBatches.collectionDate, range.toDate),
    // A cancelled batch never held money, so it is not part of any performance.
    // S4-1/S4-2: the lifecycle has distinct `submitted`, `remitted`, `reconciled`
    // and `closed` money-holding states, so a report must count all four — a
    // pre-lifecycle `submitted` row migrated to `remitted`, and lucid reports for
    // historical months would silently lose it if only `submitted`/`reconciled`
    // were listed here.
    inArray(collectorBatches.status, ["submitted", "remitted", "reconciled", "closed"] as const),
  ];

  if (filters.collectorId !== undefined) {
    conditions.push(eq(collectorBatches.collectorId, filters.collectorId));
  }

  return executor
    .select({
      collectorId: collectorBatches.collectorId,
      collectorName: users.fullName,
      expectedRemittanceCentavos: collectorBatches.expectedRemittanceCentavos,
      actualRemittanceCentavos: collectorBatches.actualRemittanceCentavos,
      varianceCentavos: collectorBatches.varianceCentavos,
    })
    .from(collectorBatches)
    .innerJoin(users, eq(collectorBatches.collectorId, users.id))
    .where(and(...conditions))
    .orderBy(asc(collectorBatches.collectionDate));
}

/** How many assigned accounts each collector covers, keyed by collector id. */
export async function loadAssignedAccountCounts(
  executor: DbExecutor = db
): Promise<Map<string, number>> {
  const rows = await executor
    .select({
      collectorId: serviceAccounts.assignedCollectorId,
      serviceAccountNumber: serviceAccounts.serviceAccountNumber,
    })
    .from(serviceAccounts)
    .where(inArray(serviceAccounts.status, [...ASSIGNED_ACCOUNT_STATUSES]));

  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = row.collectorId ?? "";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
