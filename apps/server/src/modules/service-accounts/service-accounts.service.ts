// Database operations for service accounts.
//
// A service account is the unit that billing, the ledger, and payments attach to.
// It is never deleted: it moves through active → suspended → active, or ends at
// terminated, and every move is written to service_status_history.
//
// Route handlers never touch the database directly — they call these functions.

import { desc, eq, inArray, like } from "drizzle-orm";

import { db } from "../../db/connection";
import {
  serviceAccounts,
  serviceStatusHistory,
  subscribers,
  subscriptionPlans,
} from "../../db/schema/subscribers";
import { users } from "../../db/schema/users";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { formatDateOnly } from "../../shared/date";
import { planColumns, requireAssignablePlan } from "../plans/plans.service";
import {
  formatDateSegment,
  generateServiceAccountNumber,
  nextSequenceNumber,
} from "../subscribers/account-number.service";
import type { ServiceAccountStatus, ServiceType } from "@bcis/shared";

// The plan facts a service account needs to carry for display and for the
// reconnection fee. A plan row always exists because plan_id is a NOT NULL foreign key.
export interface PlanSnapshot {
  id: string;
  name: string;
  serviceType: ServiceType;
  monthlyRateCentavos: number;
  reconnectionFeeCentavos: number;
}

// The stored columns of a service account, without anything joined in.
export interface ServiceAccountRow {
  id: string;
  serviceAccountNumber: string;
  subscriberId: string;
  planId: string;
  status: ServiceAccountStatus;
  activationDate: string | null;
  suspensionDate: string | null;
  terminationDate: string | null;
  assignedCollectorId: string | null;
  consecutiveOverdueMonths: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ServiceAccountSummary extends ServiceAccountRow {
  planName: string;
  serviceType: ServiceType;
  monthlyRateCentavos: number;
  /**
   * The outstanding balance is owned by the ledger (Phase 6).
   * Until then it is reported as null rather than a misleading zero.
   */
  balanceCentavos: null;
}

export interface ServiceAccountDetail extends ServiceAccountSummary {
  statusHistory: ServiceStatusHistorySummary[];
}

export interface ServiceStatusHistorySummary {
  id: string;
  previousStatus: ServiceAccountStatus;
  newStatus: ServiceAccountStatus;
  reason: string | null;
  changedBy: string;
  changedAt: Date;
}

export const serviceAccountColumns = {
  id: serviceAccounts.id,
  serviceAccountNumber: serviceAccounts.serviceAccountNumber,
  subscriberId: serviceAccounts.subscriberId,
  planId: serviceAccounts.planId,
  status: serviceAccounts.status,
  activationDate: serviceAccounts.activationDate,
  suspensionDate: serviceAccounts.suspensionDate,
  terminationDate: serviceAccounts.terminationDate,
  assignedCollectorId: serviceAccounts.assignedCollectorId,
  consecutiveOverdueMonths: serviceAccounts.consecutiveOverdueMonths,
  createdAt: serviceAccounts.createdAt,
  updatedAt: serviceAccounts.updatedAt,
};

const statusHistoryColumns = {
  id: serviceStatusHistory.id,
  previousStatus: serviceStatusHistory.previousStatus,
  newStatus: serviceStatusHistory.newStatus,
  reason: serviceStatusHistory.reason,
  changedBy: serviceStatusHistory.changedBy,
  changedAt: serviceStatusHistory.changedAt,
};

/** Flattens a stored row plus its plan into the shape the API returns. */
export function toServiceAccountSummary(
  account: ServiceAccountRow,
  plan: PlanSnapshot
): ServiceAccountSummary {
  return {
    ...account,
    planName: plan.name,
    serviceType: plan.serviceType,
    monthlyRateCentavos: plan.monthlyRateCentavos,
    balanceCentavos: null,
  };
}

/** Loads a service account together with its plan, or throws NotFoundError. */
async function requireServiceAccountWithPlan(
  serviceAccountId: string
): Promise<{ account: ServiceAccountRow; plan: PlanSnapshot }> {
  const row = await db
    .select({ account: serviceAccountColumns, plan: planColumns })
    .from(serviceAccounts)
    .innerJoin(subscriptionPlans, eq(serviceAccounts.planId, subscriptionPlans.id))
    .where(eq(serviceAccounts.id, serviceAccountId))
    .limit(1)
    .then((rows) => rows[0]);

  if (row === undefined) {
    throw new NotFoundError("Service account not found");
  }

  return row;
}

/**
 * Rejects a collector assignment that points at the wrong kind of user.
 * Field collection is a role, not a label: only an active Collector may be assigned.
 */
export async function requireAssignableCollector(collectorId: string): Promise<void> {
  const collector = await db
    .select({ role: users.role, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, collectorId))
    .limit(1)
    .then((rows) => rows[0]);

  if (collector === undefined) {
    throw new ValidationError("The assigned collector does not exist");
  }

  if (collector.role !== "collector") {
    throw new ValidationError("Only a user with the Collector role can be assigned");
  }

  if (!collector.isActive) {
    throw new ValidationError("The assigned collector is deactivated");
  }
}

/** Builds the next service account number for today, e.g. SA-20250124-00042. */
async function nextServiceAccountNumber(today: Date): Promise<string> {
  const prefix = `SA-${formatDateSegment(today)}-`;

  const existingNumbers = await db
    .select({ serviceAccountNumber: serviceAccounts.serviceAccountNumber })
    .from(serviceAccounts)
    .where(like(serviceAccounts.serviceAccountNumber, `${prefix}%`));

  const sequenceNumber = nextSequenceNumber(
    existingNumbers.map((row) => row.serviceAccountNumber),
    prefix
  );

  return generateServiceAccountNumber(today, sequenceNumber);
}

export interface CreateServiceAccountInput {
  planId: string;
  activationDate?: string;
  assignedCollectorId?: string;
}

/**
 * Inserts a service account. The caller has already established that the
 * subscriber exists.
 *
 * A brand-new account with no activation date is created "pending": the
 * installation is not finished, so it must not be billed. Supplying an
 * activation date means service has started, so the account is created "active".
 */
export async function insertServiceAccount(
  subscriberId: string,
  input: CreateServiceAccountInput,
  createdBy: string
): Promise<ServiceAccountSummary> {
  const plan = await requireAssignablePlan(input.planId);

  if (input.assignedCollectorId !== undefined) {
    await requireAssignableCollector(input.assignedCollectorId);
  }

  const serviceAccountNumber = await nextServiceAccountNumber(new Date());
  const activationDate = input.activationDate ?? null;

  const inserted = await db
    .insert(serviceAccounts)
    .values({
      serviceAccountNumber,
      subscriberId,
      planId: plan.id,
      status: activationDate === null ? "pending" : "active",
      activationDate,
      assignedCollectorId: input.assignedCollectorId ?? null,
      createdBy,
    })
    .returning(serviceAccountColumns)
    .then((rows) => rows[0]);

  // `.returning()` always yields the inserted row; the guard keeps types honest.
  if (inserted === undefined) {
    throw new NotFoundError("Service account could not be created");
  }

  return toServiceAccountSummary(inserted, plan);
}

/** Adds a service account to an existing subscriber. */
export async function createServiceAccountForSubscriber(
  subscriberId: string,
  input: CreateServiceAccountInput,
  createdBy: string
): Promise<ServiceAccountSummary> {
  const subscriber = await db
    .select({ id: subscribers.id })
    .from(subscribers)
    .where(eq(subscribers.id, subscriberId))
    .limit(1)
    .then((rows) => rows[0]);

  if (subscriber === undefined) {
    throw new NotFoundError("Subscriber not found");
  }

  return insertServiceAccount(subscriberId, input, createdBy);
}

/** Loads every service account of the given subscribers, grouped by subscriber id. */
export async function loadServiceAccountsForSubscribers(
  subscriberIds: readonly string[]
): Promise<Map<string, ServiceAccountSummary[]>> {
  const grouped = new Map<string, ServiceAccountSummary[]>();

  if (subscriberIds.length === 0) {
    return grouped;
  }

  const rows = await db
    .select({ account: serviceAccountColumns, plan: planColumns })
    .from(serviceAccounts)
    .innerJoin(subscriptionPlans, eq(serviceAccounts.planId, subscriptionPlans.id))
    .where(inArray(serviceAccounts.subscriberId, [...subscriberIds]));

  for (const row of rows) {
    const summary = toServiceAccountSummary(row.account, row.plan);
    const existing = grouped.get(row.account.subscriberId);

    if (existing === undefined) {
      grouped.set(row.account.subscriberId, [summary]);
    } else {
      existing.push(summary);
    }
  }

  return grouped;
}

/** Loads one service account with its plan and full status history. */
export async function getServiceAccountById(
  serviceAccountId: string
): Promise<ServiceAccountDetail> {
  const { account, plan } = await requireServiceAccountWithPlan(serviceAccountId);

  const statusHistory = await db
    .select(statusHistoryColumns)
    .from(serviceStatusHistory)
    .where(eq(serviceStatusHistory.serviceAccountId, serviceAccountId))
    .orderBy(desc(serviceStatusHistory.changedAt));

  return { ...toServiceAccountSummary(account, plan), statusHistory };
}

/** One entry in the status audit trail. */
interface StatusChangeRecord {
  serviceAccountId: string;
  previousStatus: ServiceAccountStatus;
  newStatus: ServiceAccountStatus;
  reason: string | null;
  changedBy: string;
}

/** Writes one row to the audit trail. Every status change goes through here. */
async function recordStatusChange(change: StatusChangeRecord): Promise<void> {
  await db.insert(serviceStatusHistory).values(change);
}

/**
 * Cuts off an active account and pauses its billing.
 * The outstanding balance is untouched — suspension stops new invoices, it does
 * not forgive old ones.
 */
export async function suspendServiceAccount(
  serviceAccountId: string,
  reason: string,
  changedBy: string
): Promise<ServiceAccountSummary> {
  const { account, plan } = await requireServiceAccountWithPlan(serviceAccountId);

  if (account.status === "terminated") {
    throw new ConflictError("A terminated service account cannot be suspended");
  }

  if (account.status === "suspended") {
    throw new ConflictError("This service account is already suspended");
  }

  if (account.status === "pending") {
    throw new ConflictError("A pending service account has no service to suspend");
  }

  const updated = await db
    .update(serviceAccounts)
    .set({
      status: "suspended",
      suspensionDate: formatDateOnly(new Date()),
      updatedAt: new Date(),
    })
    .where(eq(serviceAccounts.id, serviceAccountId))
    .returning(serviceAccountColumns)
    .then((rows) => rows[0]);

  if (updated === undefined) {
    throw new NotFoundError("Service account not found");
  }

  await recordStatusChange({
    serviceAccountId,
    previousStatus: account.status,
    newStatus: "suspended",
    reason,
    changedBy,
  });

  return toServiceAccountSummary(updated, plan);
}

export interface ReconnectionFeeEntry {
  serviceAccountId: string;
  planId: string;
  amountCentavos: number;
  description: string;
}

export interface ReconnectServiceAccountResult {
  serviceAccount: ServiceAccountSummary;
  reconnectionFeeEntry: ReconnectionFeeEntry;
}

/**
 * Restores service to a suspended account and reports the reconnection fee.
 *
 * The fee amount comes from the account's plan, so a price change only affects
 * accounts created after it. Phase 4 turns the returned entry into a reconnection
 * fee invoice; Phase 3 records the amount and the audit trail.
 */
export async function reconnectServiceAccount(
  serviceAccountId: string,
  reason: string | undefined,
  changedBy: string
): Promise<ReconnectServiceAccountResult> {
  const { account, plan } = await requireServiceAccountWithPlan(serviceAccountId);

  if (account.status === "terminated") {
    throw new ConflictError("A terminated service account cannot be reconnected");
  }

  if (account.status !== "suspended") {
    throw new ConflictError("Only a suspended service account can be reconnected");
  }

  const updated = await db
    .update(serviceAccounts)
    .set({
      status: "active",
      suspensionDate: null,
      terminationDate: null,
      updatedAt: new Date(),
    })
    .where(eq(serviceAccounts.id, serviceAccountId))
    .returning(serviceAccountColumns)
    .then((rows) => rows[0]);

  if (updated === undefined) {
    throw new NotFoundError("Service account not found");
  }

  const reconnectionFeeCentavos = plan.reconnectionFeeCentavos;

  await recordStatusChange({
    serviceAccountId,
    previousStatus: "suspended",
    newStatus: "active",
    reason:
      reason ?? `Reconnected — reconnection fee of ${reconnectionFeeCentavos} centavos applies`,
    changedBy,
  });

  return {
    serviceAccount: toServiceAccountSummary(updated, plan),
    reconnectionFeeEntry: {
      serviceAccountId,
      planId: plan.id,
      amountCentavos: reconnectionFeeCentavos,
      description: `Reconnection fee — ${plan.name}`,
    },
  };
}

/**
 * Permanently ends service. The row stays forever: invoices and receipts still
 * point at it, and a terminated account is never reactivated.
 */
export async function terminateServiceAccount(
  serviceAccountId: string,
  reason: string,
  changedBy: string
): Promise<ServiceAccountSummary> {
  const { account, plan } = await requireServiceAccountWithPlan(serviceAccountId);

  if (account.status === "terminated") {
    throw new ConflictError("This service account is already terminated");
  }

  const updated = await db
    .update(serviceAccounts)
    .set({
      status: "terminated",
      terminationDate: formatDateOnly(new Date()),
      updatedAt: new Date(),
    })
    .where(eq(serviceAccounts.id, serviceAccountId))
    .returning(serviceAccountColumns)
    .then((rows) => rows[0]);

  if (updated === undefined) {
    throw new NotFoundError("Service account not found");
  }

  await recordStatusChange({
    serviceAccountId,
    previousStatus: account.status,
    newStatus: "terminated",
    reason,
    changedBy,
  });

  return toServiceAccountSummary(updated, plan);
}

export interface PlanChangeResult {
  serviceAccount: ServiceAccountSummary;
  previousPlanId: string;
  previousMonthlyRateCentavos: number;
  newMonthlyRateCentavos: number;
}

/**
 * Moves an account onto a different plan.
 *
 * The old and new monthly rates are returned so Phase 4 can post the prorated
 * adjustment entry; Phase 3 changes which plan the account bills against.
 */
export async function changeServiceAccountPlan(
  serviceAccountId: string,
  newPlanId: string
): Promise<PlanChangeResult> {
  const { account, plan: currentPlan } = await requireServiceAccountWithPlan(serviceAccountId);

  if (account.status === "terminated") {
    throw new ConflictError("A terminated service account cannot change plans");
  }

  if (account.planId === newPlanId) {
    throw new ValidationError("This service account is already on that plan");
  }

  const newPlan = await requireAssignablePlan(newPlanId);

  const updated = await db
    .update(serviceAccounts)
    .set({ planId: newPlan.id, updatedAt: new Date() })
    .where(eq(serviceAccounts.id, serviceAccountId))
    .returning(serviceAccountColumns)
    .then((rows) => rows[0]);

  if (updated === undefined) {
    throw new NotFoundError("Service account not found");
  }

  return {
    serviceAccount: toServiceAccountSummary(updated, newPlan),
    previousPlanId: currentPlan.id,
    previousMonthlyRateCentavos: currentPlan.monthlyRateCentavos,
    newMonthlyRateCentavos: newPlan.monthlyRateCentavos,
  };
}

/** Assigns or clears the field collector. `null` means office payment only. */
export async function assignCollector(
  serviceAccountId: string,
  assignedCollectorId: string | null
): Promise<ServiceAccountSummary> {
  const { plan } = await requireServiceAccountWithPlan(serviceAccountId);

  if (assignedCollectorId !== null) {
    await requireAssignableCollector(assignedCollectorId);
  }

  const updated = await db
    .update(serviceAccounts)
    .set({ assignedCollectorId, updatedAt: new Date() })
    .where(eq(serviceAccounts.id, serviceAccountId))
    .returning(serviceAccountColumns)
    .then((rows) => rows[0]);

  if (updated === undefined) {
    throw new NotFoundError("Service account not found");
  }

  return toServiceAccountSummary(updated, plan);
}
