// The Subscriber Master List (R17).
//
// The subscriber list is a screen with a search box; this is the same data as a
// report, so it can be printed and exported. One line per service account, because
// that is the level the filters work at — a household with Internet and Cable TV
// appears twice, once per plan, and the plan, service-type, area, collector and
// account-status filters therefore all mean something.
//
// A subscriber with no service account yet still appears, with empty account
// columns, so the report is a master list of the book rather than only of its billing.
//
// It is a current snapshot: a subscriber's contact details and their plan have no
// date range, so the report takes no date filter and says so on the screen.
//
// Nothing here is money: the master list is identity and coverage, not balances. The
// outstanding balance per account is the AR aging report's job.

import { asc, eq } from "drizzle-orm";

import type { ServiceAccountStatus, ServiceType } from "@bcis/shared";
import { db, type DbExecutor } from "../../db/connection";
import { collectionAreas } from "../../db/schema/areas";
import { serviceAccounts, subscribers, subscriptionPlans } from "../../db/schema/subscribers";
import { users } from "../../db/schema/users";
import {
  accountFilterConditions,
  combineConditions,
  type ReportFilters,
} from "./report-filters";

/** The filters the master list honours. There is no date range: it is a snapshot. */
export interface SubscriberMasterListFilters extends ReportFilters {
  /** Only service accounts in this lifecycle state. */
  serviceStatus?: ServiceAccountStatus;
}

/** One line of the report: a subscriber and one of their service accounts. */
export interface SubscriberMasterListRow {
  subscriberId: string;
  subscriberAccountNumber: string;
  subscriberName: string;
  primaryPhone: string;
  emailAddress: string | null;
  serviceAddress: string;
  areaName: string | null;
  serviceAccountNumber: string | null;
  planName: string | null;
  serviceType: ServiceType | null;
  accountStatus: ServiceAccountStatus | null;
  collectorName: string | null;
}

export interface SubscriberMasterListReport {
  rows: SubscriberMasterListRow[];
  /** How many distinct subscribers the report covers. */
  subscriberCount: number;
  /** How many of the lines carry a service account. */
  accountCount: number;
}

/**
 * Sorts the master list by subscriber name, then by account number.
 *
 * Pure and database-free: two runs over the same rows produce the same order, and
 * the two counts describe exactly the lines below them.
 */
export function buildSubscriberMasterListReport(
  rows: readonly SubscriberMasterListRow[]
): SubscriberMasterListReport {
  const sorted = [...rows].sort((left, right) => {
    const byName = left.subscriberName.localeCompare(right.subscriberName);
    if (byName !== 0) {
      return byName;
    }
    return (left.serviceAccountNumber ?? "").localeCompare(right.serviceAccountNumber ?? "");
  });

  return {
    rows: sorted,
    subscriberCount: new Set(sorted.map((row) => row.subscriberId)).size,
    accountCount: sorted.filter((row) => row.serviceAccountNumber !== null).length,
  };
}

/**
 * Every subscriber with their service accounts, narrowed by the filters.
 *
 * The joins are LEFT joins so a subscriber without an account is still listed; the
 * filters still reach the SQL `where` clause, so a collector filter returns only the
 * accounts that collector covers.
 */
export async function loadSubscriberMasterListRows(
  filters: SubscriberMasterListFilters,
  executor: DbExecutor = db
): Promise<SubscriberMasterListRow[]> {
  const rows = await executor
    .select({
      subscriberId: subscribers.id,
      subscriberAccountNumber: subscribers.accountNumber,
      subscriberFirstName: subscribers.firstName,
      subscriberLastName: subscribers.lastName,
      primaryPhone: subscribers.primaryPhone,
      emailAddress: subscribers.emailAddress,
      serviceAddress: subscribers.serviceAddress,
      areaName: collectionAreas.name,
      serviceAccountNumber: serviceAccounts.serviceAccountNumber,
      planName: subscriptionPlans.name,
      serviceType: subscriptionPlans.serviceType,
      accountStatus: serviceAccounts.status,
      collectorName: users.fullName,
    })
    .from(subscribers)
    .leftJoin(serviceAccounts, eq(serviceAccounts.subscriberId, subscribers.id))
    .leftJoin(subscriptionPlans, eq(serviceAccounts.planId, subscriptionPlans.id))
    .leftJoin(collectionAreas, eq(serviceAccounts.areaId, collectionAreas.id))
    .leftJoin(users, eq(serviceAccounts.assignedCollectorId, users.id))
    .where(
      combineConditions([
        ...accountFilterConditions(filters),
        ...(filters.serviceStatus === undefined
          ? []
          : [eq(serviceAccounts.status, filters.serviceStatus)]),
      ])
    )
    .orderBy(asc(subscribers.lastName), asc(subscribers.firstName), asc(serviceAccounts.serviceAccountNumber));

  return rows.map((row) => ({
    subscriberId: row.subscriberId,
    subscriberAccountNumber: row.subscriberAccountNumber,
    subscriberName: `${row.subscriberLastName}, ${row.subscriberFirstName}`,
    primaryPhone: row.primaryPhone,
    emailAddress: row.emailAddress,
    serviceAddress: row.serviceAddress,
    areaName: row.areaName,
    serviceAccountNumber: row.serviceAccountNumber,
    planName: row.planName,
    serviceType: row.serviceType,
    accountStatus: row.accountStatus,
    collectorName: row.collectorName,
  }));
}
