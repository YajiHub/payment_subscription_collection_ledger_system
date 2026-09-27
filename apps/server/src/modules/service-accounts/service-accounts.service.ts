// Database operations for service accounts.
//
// A service account is the unit that billing, the ledger, and payments attach to.
// It is never deleted: it moves through active → suspended → active, or ends at
// terminated, and every move is written to service_status_history.
//
// Route handlers never touch the database directly — they call these functions.

import { desc, eq, inArray, like } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db, type DbExecutor } from "../../db/connection";
import {
  serviceAccounts,
  serviceStatusHistory,
  subscribers,
  subscriptionPlans,
} from "../../db/schema/subscribers";
import {
  reconnectionRecords,
  suspensionRecords,
  type ReconnectionRecord,
} from "../../db/schema/service-control";
import { users } from "../../db/schema/users";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { formatDateOnly } from "../../shared/date";
import { getCurrentBalanceCentavos } from "../ledger/ledger.service";
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
   * The current balance, read from the account's latest ledger entry.
   *
   * The ledger is the authority on what is owed: there is no balance column, and
   * this is the same figure `getSubscriberStatement` reports. A positive value is
   * what the subscriber owes; a negative value is an advance credit they hold.
   */
  balanceCentavos: number;
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

/**
 * Flattens a stored row plus its plan into the shape the API returns.
 *
 * The balance is passed in rather than looked up here: this function stays pure so
 * a caller inside a status-change transaction reads the balance from the same
 * transaction, and the brand-new-account path can pass a known zero.
 */
export function toServiceAccountSummary(
  account: ServiceAccountRow,
  plan: PlanSnapshot,
  balanceCentavos: number
): ServiceAccountSummary {
  return {
    ...account,
    planName: plan.name,
    serviceType: plan.serviceType,
    monthlyRateCentavos: plan.monthlyRateCentavos,
    balanceCentavos,
  };
}

/** Loads a service account together with its plan, or throws NotFoundError. */
async function requireServiceAccountWithPlan(
  serviceAccountId: string,
  executor: DbExecutor = db,
  options: { forUpdate?: boolean } = {}
): Promise<{ account: ServiceAccountRow; plan: PlanSnapshot }> {
  const query = executor
    .select({ account: serviceAccountColumns, plan: planColumns })
    .from(serviceAccounts)
    .innerJoin(subscriptionPlans, eq(serviceAccounts.planId, subscriptionPlans.id))
    .where(eq(serviceAccounts.id, serviceAccountId))
    .limit(1);

  // Inside a status-change transaction the row is locked so a concurrent
  // suspend/reconnect cannot slip between the guard and the update.
  const rows = options.forUpdate === true ? await query.for("update") : await query;
  const row = rows[0];

  if (row === undefined) {
    throw new NotFoundError("Service account not found");
  }

  return row;
}

/**
 * Rejects a collector assignment that points at the wrong kind of user.
 * Field collection is a role, not a label: only an active Collector may be assigned.
 */
export async function requireAssignableCollector(
  collectorId: string,
  executor: DbExecutor = db
): Promise<void> {
  const collector = await executor
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
async function nextServiceAccountNumber(today: Date, executor: DbExecutor = db): Promise<string> {
  const prefix = `SA-${formatDateSegment(today)}-`;

  const existingNumbers = await executor
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
  createdBy: string,
  executor: DbExecutor = db
): Promise<ServiceAccountSummary> {
  const plan = await requireAssignablePlan(input.planId, executor);

  if (input.assignedCollectorId !== undefined) {
    await requireAssignableCollector(input.assignedCollectorId, executor);
  }

  const serviceAccountNumber = await nextServiceAccountNumber(new Date(), executor);
  const activationDate = input.activationDate ?? null;

  const inserted = await executor
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

  // A brand-new account has no ledger entries yet, so its balance is zero by
  // construction — no lookup needed.
  return toServiceAccountSummary(inserted, plan, 0);
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
    const balanceCentavos = await getCurrentBalanceCentavos(db, row.account.id);
    const summary = toServiceAccountSummary(row.account, row.plan, balanceCentavos);
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

  const balanceCentavos = await getCurrentBalanceCentavos(db, serviceAccountId);

  return { ...toServiceAccountSummary(account, plan, balanceCentavos), statusHistory };
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
async function recordStatusChange(executor: DbExecutor, change: StatusChangeRecord): Promise<void> {
  await executor.insert(serviceStatusHistory).values(change);
}

/**
 * The operating paperwork that accompanies a status change (S4-7/S4-8).
 *
 * Every field is optional: an office suspension has no technician and no field
 * dates, while a field job records who went out and when it was requested and
 * completed. The service account's status stays the source of truth either way.
 */
export interface ServiceControlDetails {
  technicianId?: string;
  effectiveDate?: string;
  requestDate?: string;
  completionDate?: string;
  notes?: string;
}

/**
 * Cuts off an active account and pauses its billing.
 * The outstanding balance is untouched — suspension stops new invoices, it does
 * not forgive old ones.
 */
export async function suspendServiceAccount(
  serviceAccountId: string,
  reason: string,
  changedBy: string,
  details: ServiceControlDetails = {}
): Promise<ServiceAccountSummary> {
  // The status update and its audit row commit together, so the account can
  // never end up suspended with no record of who did it or why.
  return db.transaction(async (tx) => {
    const { account, plan } = await requireServiceAccountWithPlan(serviceAccountId, tx, {
      forUpdate: true,
    });

    if (account.status === "terminated") {
      throw new ConflictError("A terminated service account cannot be suspended");
    }

    if (account.status === "suspended") {
      throw new ConflictError("This service account is already suspended");
    }

    if (account.status === "pending") {
      throw new ConflictError("A pending service account has no service to suspend");
    }

    const effectiveDate = details.effectiveDate ?? formatDateOnly(new Date());

    const updated = await tx
      .update(serviceAccounts)
      .set({
        status: "suspended",
        suspensionDate: effectiveDate,
        updatedAt: new Date(),
      })
      .where(eq(serviceAccounts.id, serviceAccountId))
      .returning(serviceAccountColumns)
      .then((rows) => rows[0]);

    if (updated === undefined) {
      throw new NotFoundError("Service account not found");
    }

    await recordStatusChange(tx, {
      serviceAccountId,
      previousStatus: account.status,
      newStatus: "suspended",
      reason,
      changedBy,
    });

    // S1-7: the suspension record is the operating paperwork — who approved the cut,
    // when it takes effect and, when a technician performed it, who did and when.
    await tx.insert(suspensionRecords).values({
      serviceAccountId,
      reason,
      effectiveDate,
      approvedBy: changedBy,
      technicianId: details.technicianId ?? null,
      requestDate: details.requestDate ?? null,
      completionDate: details.completionDate ?? null,
      notes: details.notes ?? null,
      createdBy: changedBy,
    });

    const balanceCentavos = await getCurrentBalanceCentavos(tx, serviceAccountId);

    return toServiceAccountSummary(updated, plan, balanceCentavos);
  });
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
  // The re-activation and its audit row are one transaction, so a failure
  // cannot leave the account active with the move unrecorded.
  return db.transaction(async (tx) => {
    const { account, plan } = await requireServiceAccountWithPlan(serviceAccountId, tx, {
      forUpdate: true,
    });

    if (account.status === "terminated") {
      throw new ConflictError("A terminated service account cannot be reconnected");
    }

    if (account.status !== "suspended") {
      throw new ConflictError("Only a suspended service account can be reconnected");
    }

    const updated = await tx
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

    await recordStatusChange(tx, {
      serviceAccountId,
      previousStatus: "suspended",
      newStatus: "active",
      reason:
        reason ?? `Reconnected — reconnection fee of ${reconnectionFeeCentavos} centavos applies`,
      changedBy,
    });

    const balanceCentavos = await getCurrentBalanceCentavos(tx, serviceAccountId);

    return {
      serviceAccount: toServiceAccountSummary(updated, plan, balanceCentavos),
      reconnectionFeeEntry: {
        serviceAccountId,
        planId: plan.id,
        amountCentavos: reconnectionFeeCentavos,
        description: `Reconnection fee — ${plan.name}`,
      },
    };
  });
}

/**
 * Records the reconnection paperwork (S4-8): who asked for the service back, which
 * technician restored it, when the request was made and when it was completed.
 *
 * Called after the fee invoice exists so the record can point at it. The invoice is
 * the financial record; this row is the operating history beside it. Nothing is
 * edited or deleted — a corrected record is another row.
 */
export async function recordReconnection(
  serviceAccountId: string,
  reason: string | undefined,
  feeCentavos: number,
  createdBy: string,
  details: ServiceControlDetails & { invoiceId?: string | null } = {}
): Promise<ReconnectionRecord> {
  // The id is generated here rather than left to the database default so the row is
  // returned without a second round trip — and so the audit entry and the caller
  // both see the same record identity.
  const record: ReconnectionRecord = {
    id: randomUUID(),
    serviceAccountId,
    reason: reason ?? `Reconnected — reconnection fee of ${feeCentavos} centavos applies`,
    effectiveDate: details.effectiveDate ?? formatDateOnly(new Date()),
    approvedBy: createdBy,
    feeCentavos,
    technicianId: details.technicianId ?? null,
    requestDate: details.requestDate ?? null,
    completionDate: details.completionDate ?? null,
    invoiceId: details.invoiceId ?? null,
    notes: details.notes ?? null,
    createdAt: new Date(),
    createdBy,
  };

  await db.insert(reconnectionRecords).values(record);

  return record;
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
  // Termination and its audit row commit together; a terminated account is
  // never reactivated, so the history row is the only record of the decision.
  return db.transaction(async (tx) => {
    const { account, plan } = await requireServiceAccountWithPlan(serviceAccountId, tx, {
      forUpdate: true,
    });

    if (account.status === "terminated") {
      throw new ConflictError("This service account is already terminated");
    }

    const updated = await tx
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

    await recordStatusChange(tx, {
      serviceAccountId,
      previousStatus: account.status,
      newStatus: "terminated",
      reason,
      changedBy,
    });

    const balanceCentavos = await getCurrentBalanceCentavos(tx, serviceAccountId);

    return toServiceAccountSummary(updated, plan, balanceCentavos);
  });
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

  const balanceCentavos = await getCurrentBalanceCentavos(db, serviceAccountId);

  return {
    serviceAccount: toServiceAccountSummary(updated, newPlan, balanceCentavos),
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

  const balanceCentavos = await getCurrentBalanceCentavos(db, serviceAccountId);

  return toServiceAccountSummary(updated, plan, balanceCentavos);
}
