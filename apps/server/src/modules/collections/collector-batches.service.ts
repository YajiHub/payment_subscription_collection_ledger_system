// Field collection: creating batches, recording what the collector found, and the
// office remittance/reconciliation workflow.
//
// The financial rules live here:
//
//   • A batch's expected remittance is ALWAYS the sum of its recorded collections.
//     It is recomputed inside the same transaction as every collection write, so it
//     can never drift by a centavo.
//   • A service account may belong to only one OPEN batch at a time. This is checked
//     under an advisory lock keyed by the account id, so two clerks cannot assign the
//     same account to two open batches at once.
//   • A Collector may only see and change their OWN batches. The check is on the
//     server; the client filter is only a convenience.
//   • Collections and batches are never deleted. A wrong collection is VOIDED (its
//     payment is reversed); a batch with no collections is CANCELLED.
//   • Variance is stored (actual - expected), never silently absorbed.

import { and, asc, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";

import {
  type CollectionResult,
  type CollectedMethod,
  type CollectorBatchStatus,
  type UserRole,
  isMoneyCollectionResult,
} from "@bcis/shared";
import { db, type DbExecutor } from "../../db/connection";
import { invoices } from "../../db/schema/billing";
import {
  batchAssignments,
  collectorBatches,
  type BatchAssignment,
  type CollectorBatch,
} from "../../db/schema/collections";
import { payments } from "../../db/schema/payments";
import { serviceAccounts, subscribers, subscriptionPlans } from "../../db/schema/subscribers";
import { users } from "../../db/schema/users";
import { type AuditActor } from "../../shared/audit/audit-logger";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { isUniqueViolation } from "../../shared/unique-violation";
import { getNextCollectorBatchNumber } from "./collector-batch-number.service";
import { postPaymentWithinTransaction } from "../payments/post-payment.service";
import { reversePaymentWithinTransaction } from "../payments/reverse-payment.service";

/** The authenticated caller, reduced to what the batch services need. */
export interface BatchActor {
  id: string;
  role: UserRole;
  /** Where the caller connected from, carried through to the audit trail. */
  clientIpAddress?: string;
}

/**
 * The batch actor as the audit logger needs it.
 *
 * The user id is the same as the acting user's; the IP is optional because a
 * non-HTTP caller may not know it.
 */
function actorForAudit(actor: BatchActor): AuditActor {
  return { userId: actor.id, clientIpAddress: actor.clientIpAddress ?? null };
}

/** A batch as the list and header screens show it. */
export interface CollectorBatchSummary {
  id: string;
  batchNumber: string;
  collectorId: string;
  collectorName: string;
  status: CollectorBatchStatus;
  collectionDate: string;
  expectedRemittanceCentavos: number;
  actualRemittanceCentavos: number | null;
  varianceCentavos: number | null;
  varianceNotes: string | null;
  assignmentCount: number;
  collectedCount: number;
  createdAt: Date;
  submittedAt: Date | null;
  reconciledAt: Date | null;
}

/** One assigned service account and the collector's result for it. */
export interface BatchAssignmentSummary {
  id: string;
  serviceAccountId: string;
  serviceAccountNumber: string;
  subscriberId: string;
  subscriberName: string;
  planName: string;
  outstandingBalanceCentavos: number;
  collectionResult: CollectionResult | null;
  collectedAmountCentavos: number | null;
  collectedMethod: CollectedMethod | null;
  paymentId: string | null;
  collectorNotes: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
}

export interface CollectorBatchDetail extends CollectorBatchSummary {
  assignments: BatchAssignmentSummary[];
  collectedTotalCentavos: number;
  outstandingTotalCentavos: number;
}

export interface ListCollectorBatchesFilters {
  collectorId?: string;
  status?: CollectorBatchStatus;
  dateFrom?: string;
  dateTo?: string;
  page: number;
  pageSize: number;
}

export interface ListCollectorBatchesResult {
  items: CollectorBatchSummary[];
  page: number;
  pageSize: number;
  total: number;
}

export interface CreateCollectorBatchInput {
  collectorId: string;
  collectionDate: string;
  serviceAccountIds: string[];
}

const OUTSTANDING_INVOICE_STATUSES = ["posted", "partially_paid", "overdue"] as const;

/**
 * Rejects a batch a Collector does not own, by pretending it does not exist.
 *
 * A 404 (rather than 403) keeps one collector from learning that another
 * collector's batch exists at all. Office roles (Admin, Billing Clerk, Cashier,
 * Manager) are not restricted here.
 */
function assertBatchIsVisible(batch: { collectorId: string }, actor: BatchActor): void {
  if (actor.role === "collector" && batch.collectorId !== actor.id) {
    throw new NotFoundError("Collector batch not found");
  }
}

/**
 * Serializes assignment of one service account across the whole system.
 *
 * The lock is keyed by the account id, so two batches for different accounts never
 * block each other, and it is released when the transaction ends.
 */
async function lockServiceAccountAssignment(
  executor: DbExecutor,
  serviceAccountId: string
): Promise<void> {
  await executor.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`batch-assignment:${serviceAccountId}`}))`
  );
}

/** True when the account already belongs to an open batch. */
async function isInOpenBatch(executor: DbExecutor, serviceAccountId: string): Promise<boolean> {
  const rows = await executor
    .select({ id: batchAssignments.id })
    .from(batchAssignments)
    .innerJoin(collectorBatches, eq(batchAssignments.batchId, collectorBatches.id))
    .where(
      and(
        eq(batchAssignments.serviceAccountId, serviceAccountId),
        eq(collectorBatches.status, "open")
      )
    )
    .limit(1);

  return rows.length > 0;
}

/** The outstanding balance of each account, keyed by account id, in centavos. */
async function loadOutstandingBalances(
  executor: DbExecutor,
  serviceAccountIds: readonly string[]
): Promise<Map<string, number>> {
  const balances = new Map<string, number>();
  if (serviceAccountIds.length === 0) {
    return balances;
  }

  const rows = await executor
    .select({
      serviceAccountId: invoices.serviceAccountId,
      remainingBalanceCentavos: invoices.remainingBalanceCentavos,
    })
    .from(invoices)
    .where(
      and(
        inArray(invoices.serviceAccountId, [...serviceAccountIds]),
        inArray(invoices.status, [...OUTSTANDING_INVOICE_STATUSES]),
        isNotNull(invoices.remainingBalanceCentavos)
      )
    );

  for (const row of rows) {
    const running = balances.get(row.serviceAccountId) ?? 0;
    balances.set(row.serviceAccountId, running + row.remainingBalanceCentavos);
  }

  return balances;
}

/** Recomputes and stores a batch's expected remittance from its recorded collections. */
async function recomputeExpectedRemittance(
  executor: DbExecutor,
  batchId: string
): Promise<number> {
  const rows = await executor
    .select({ collectedAmountCentavos: batchAssignments.collectedAmountCentavos })
    .from(batchAssignments)
    .where(eq(batchAssignments.batchId, batchId));

  const expectedCentavos = rows.reduce(
    (runningTotal, row) => runningTotal + (row.collectedAmountCentavos ?? 0),
    0
  );

  await executor
    .update(collectorBatches)
    .set({ expectedRemittanceCentavos: expectedCentavos })
    .where(eq(collectorBatches.id, batchId));

  return expectedCentavos;
}

/** Loads a batch row for update, or throws NotFoundError. */
async function requireBatchForUpdate(
  executor: DbExecutor,
  batchId: string
): Promise<CollectorBatch> {
  const batch = await executor
    .select()
    .from(collectorBatches)
    .where(eq(collectorBatches.id, batchId))
    .limit(1)
    .for("update")
    .then((rows) => rows[0]);

  if (batch === undefined) {
    throw new NotFoundError("Collector batch not found");
  }

  return batch;
}

/** Loads one assignment of a batch for update, or throws NotFoundError. */
async function requireAssignmentForUpdate(
  executor: DbExecutor,
  batchId: string,
  serviceAccountId: string
): Promise<BatchAssignment> {
  const assignment = await executor
    .select()
    .from(batchAssignments)
    .where(
      and(
        eq(batchAssignments.batchId, batchId),
        eq(batchAssignments.serviceAccountId, serviceAccountId)
      )
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0]);

  if (assignment === undefined) {
    throw new NotFoundError("This service account is not assigned to the batch");
  }

  return assignment;
}

/** Flattens a stored batch row into the summary shape the API returns. */
function toCollectorBatchSummary(
  batch: CollectorBatch,
  collectorName: string,
  assignmentCount: number,
  collectedCount: number
): CollectorBatchSummary {
  return {
    id: batch.id,
    batchNumber: batch.batchNumber,
    collectorId: batch.collectorId,
    collectorName,
    status: batch.status,
    collectionDate: batch.collectionDate,
    expectedRemittanceCentavos: batch.expectedRemittanceCentavos,
    actualRemittanceCentavos: batch.actualRemittanceCentavos,
    varianceCentavos: batch.varianceCentavos,
    varianceNotes: batch.varianceNotes,
    assignmentCount,
    collectedCount,
    createdAt: batch.createdAt,
    submittedAt: batch.submittedAt,
    reconciledAt: batch.reconciledAt,
  };
}

/**
 * Inserts a batch row, translating a duplicate batch number into a clean 409.
 *
 * The advisory lock in `getNextCollectorBatchNumber` keeps two writers from taking
 * the same number; this catch is the second line of defence for the race it cannot
 * see (for example, a number restored from a backup). Either way the caller gets a
 * 409, never a 500.
 */
async function insertBatchRow(
  executor: DbExecutor,
  values: {
    batchNumber: string;
    collectorId: string;
    collectionDate: string;
    createdBy: string;
  }
): Promise<CollectorBatch | undefined> {
  try {
    return await executor
      .insert(collectorBatches)
      .values(values)
      .returning()
      .then((rows) => rows[0]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(`Batch number ${values.batchNumber} is already in use`);
    }
    throw error;
  }
}

/**
 * Creates a batch for a collector with its first service accounts.
 *
 * Every account is assigned under its own advisory lock and refused if it already
 * sits in another open batch, so the "one open batch per account" rule holds even
 * under concurrent requests.
 */
export async function createCollectorBatch(
  input: CreateCollectorBatchInput,
  actor: BatchActor
): Promise<CollectorBatchDetail> {
  const uniqueAccountIds = [...new Set(input.serviceAccountIds)];

  return db.transaction(async (tx) => {
    const collector = await tx
      .select({ id: users.id, fullName: users.fullName, role: users.role, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, input.collectorId))
      .limit(1)
      .then((rows) => rows[0]);

    if (collector === undefined) {
      throw new ValidationError("The selected collector does not exist");
    }
    if (collector.role !== "collector") {
      throw new ValidationError("Only a user with the Collector role can hold a batch");
    }
    if (!collector.isActive) {
      throw new ValidationError("The selected collector is deactivated");
    }

    const accounts = await tx
      .select({ id: serviceAccounts.id })
      .from(serviceAccounts)
      .where(inArray(serviceAccounts.id, uniqueAccountIds));

    if (accounts.length !== uniqueAccountIds.length) {
      throw new ValidationError("One or more selected service accounts do not exist");
    }

    // Sorted so two concurrent requests take the account locks in the same order
    // and cannot deadlock by grabbing them in opposite orders.
    for (const serviceAccountId of [...uniqueAccountIds].sort()) {
      await lockServiceAccountAssignment(tx, serviceAccountId);
      if (await isInOpenBatch(tx, serviceAccountId)) {
        throw new ConflictError(
          "A selected service account is already in an open collector batch"
        );
      }
    }

    const batchNumber = await getNextCollectorBatchNumber(tx, input.collectionDate);
    const outstandingBalances = await loadOutstandingBalances(tx, uniqueAccountIds);

    const batch = await insertBatchRow(tx, {
      batchNumber,
      collectorId: input.collectorId,
      collectionDate: input.collectionDate,
      createdBy: actor.id,
    });

    if (batch === undefined) {
      throw new ConflictError(`Batch number ${batchNumber} is already in use`);
    }

    await tx.insert(batchAssignments).values(
      uniqueAccountIds.map((serviceAccountId) => ({
        batchId: batch.id,
        serviceAccountId,
        outstandingBalanceCentavos: outstandingBalances.get(serviceAccountId) ?? 0,
      }))
    );

    return {
      ...toCollectorBatchSummary(batch, collector.fullName, uniqueAccountIds.length, 0),
      assignments: [],
      collectedTotalCentavos: 0,
      outstandingTotalCentavos: 0,
    };
  });
}

/**
 * Adds service accounts to an open batch.
 *
 * Office roles may add to any open batch; a Collector may only add to their own.
 */
export async function addBatchAssignments(
  batchId: string,
  serviceAccountIds: string[],
  actor: BatchActor
): Promise<CollectorBatchDetail> {
  const uniqueAccountIds = [...new Set(serviceAccountIds)];

  return db.transaction(async (tx) => {
    const batch = await requireBatchForUpdate(tx, batchId);
    assertBatchIsVisible(batch, actor);

    if (batch.status !== "open") {
      throw new ConflictError("Accounts can only be added to an open batch");
    }

    const accounts = await tx
      .select({ id: serviceAccounts.id })
      .from(serviceAccounts)
      .where(inArray(serviceAccounts.id, uniqueAccountIds));

    if (accounts.length !== uniqueAccountIds.length) {
      throw new ValidationError("One or more selected service accounts do not exist");
    }

    for (const serviceAccountId of [...uniqueAccountIds].sort()) {
      await lockServiceAccountAssignment(tx, serviceAccountId);
      if (await isInOpenBatch(tx, serviceAccountId)) {
        throw new ConflictError(
          "A selected service account is already in an open collector batch"
        );
      }
    }

    const outstandingBalances = await loadOutstandingBalances(tx, uniqueAccountIds);

    await tx.insert(batchAssignments).values(
      uniqueAccountIds.map((serviceAccountId) => ({
        batchId,
        serviceAccountId,
        outstandingBalanceCentavos: outstandingBalances.get(serviceAccountId) ?? 0,
      }))
    );

    return loadBatchDetail(tx, batchId, actor);
  });
}

/** Records the result of visiting one assigned subscriber. */
export interface RecordCollectionResult {
  batchId: string;
  serviceAccountId: string;
  expectedRemittanceCentavos: number;
  paymentId: string | null;
}

export interface RecordCollectionCommand {
  result: CollectionResult;
  collectedAmountCentavos?: number;
  collectedMethod?: CollectedMethod;
  collectorNotes?: string;
  gcash?: { referenceNumber: string; senderName?: string; senderGcashNumber?: string };
}

/**
 * Records what the collector found at one subscriber and, when money changed hands,
 * creates the official payment (with its allocations, receipt, and ledger credits)
 * in the same transaction.
 *
 * The batch's expected remittance is recomputed before the transaction commits, so
 * it always equals the sum of the recorded collections.
 */
export async function recordCollection(
  batchId: string,
  serviceAccountId: string,
  command: RecordCollectionCommand,
  actor: BatchActor
): Promise<RecordCollectionResult> {
  const takesMoney = isMoneyCollectionResult(command.result);

  return db.transaction(async (tx) => {
    const batch = await requireBatchForUpdate(tx, batchId);
    assertBatchIsVisible(batch, actor);

    if (batch.status !== "open") {
      throw new ConflictError("Collections can only be recorded on an open batch");
    }

    const assignment = await requireAssignmentForUpdate(tx, batchId, serviceAccountId);

    if (assignment.voidedAt !== null) {
      throw new ConflictError(
        "This assignment's collection was voided; create a new batch to collect again"
      );
    }
    if (assignment.collectionResult !== null) {
      throw new ConflictError(
        "A collection has already been recorded for this account; void it before recording another"
      );
    }

    let paymentId: string | null = null;

    if (takesMoney) {
      if (
        command.collectedAmountCentavos === undefined ||
        command.collectedAmountCentavos <= 0
      ) {
        throw new ValidationError("A collected amount greater than zero is required");
      }
      if (command.collectedMethod === undefined) {
        throw new ValidationError("The method the money was received by is required");
      }

      const posted = await postPaymentWithinTransaction(tx, {
        serviceAccountId,
        paymentMethod: command.collectedMethod,
        amountCentavos: command.collectedAmountCentavos,
        paymentDate: batch.collectionDate,
        notes: `Field collection ${batch.batchNumber}`,
        postedByUserId: actor.id,
        actor: actorForAudit(actor),
        gcash: command.gcash,
      });
      paymentId = posted.payment.id;
    }

    await tx
      .update(batchAssignments)
      .set({
        collectionResult: command.result,
        collectedAmountCentavos: takesMoney ? (command.collectedAmountCentavos ?? null) : null,
        collectedMethod: takesMoney ? (command.collectedMethod ?? null) : null,
        paymentId,
        collectorNotes: command.collectorNotes ?? null,
        updatedAt: new Date(),
      })
      .where(eq(batchAssignments.id, assignment.id));

    const expectedRemittanceCentavos = await recomputeExpectedRemittance(tx, batchId);

    return { batchId, serviceAccountId, expectedRemittanceCentavos, paymentId };
  });
}

/**
 * Voids a recorded collection on an open batch.
 *
 * The payment it created is reversed (never deleted) and the assignment is cleared
 * and stamped with who voided it and why. The batch total drops by the voided
 * amount in the same transaction, so it stays exact.
 */
export async function voidCollection(
  batchId: string,
  serviceAccountId: string,
  reason: string,
  actor: BatchActor
): Promise<RecordCollectionResult> {
  return db.transaction(async (tx) => {
    const batch = await requireBatchForUpdate(tx, batchId);

    if (batch.status !== "open") {
      throw new ConflictError("A collection can only be voided on an open batch");
    }

    const assignment = await requireAssignmentForUpdate(tx, batchId, serviceAccountId);

    if (assignment.voidedAt !== null) {
      throw new ConflictError("This collection has already been voided");
    }
    if (assignment.collectionResult === null) {
      throw new ConflictError("There is no collection recorded for this account");
    }

    if (assignment.paymentId !== null) {
      await reversePaymentWithinTransaction(
        tx,
        assignment.paymentId,
        reason,
        actor.id,
        actorForAudit(actor)
      );
    }

    await tx
      .update(batchAssignments)
      .set({
        collectionResult: null,
        collectedAmountCentavos: null,
        collectedMethod: null,
        paymentId: null,
        voidedAt: new Date(),
        voidedBy: actor.id,
        voidReason: reason,
        updatedAt: new Date(),
      })
      .where(eq(batchAssignments.id, assignment.id));

    const expectedRemittanceCentavos = await recomputeExpectedRemittance(tx, batchId);

    return { batchId, serviceAccountId, expectedRemittanceCentavos, paymentId: null };
  });
}

export interface SubmitRemittanceResult {
  batchId: string;
  expectedRemittanceCentavos: number;
  actualRemittanceCentavos: number;
  varianceCentavos: number;
  hasVariance: boolean;
}

/**
 * Records the cash the collector actually handed in and freezes the batch.
 *
 * Variance is `actual - expected`: positive means the collector handed in more
 * (overage), negative means less (shortage). It is stored as-is. Only an open batch
 * can be submitted, so re-submitting is a conflict rather than a second transition.
 */
export async function submitBatchRemittance(
  batchId: string,
  actualRemittanceCentavos: number,
  actor: BatchActor
): Promise<SubmitRemittanceResult> {
  return db.transaction(async (tx) => {
    const batch = await requireBatchForUpdate(tx, batchId);
    assertBatchIsVisible(batch, actor);

    if (batch.status !== "open") {
      throw new ConflictError("Only an open batch can be submitted for remittance");
    }

    const varianceCentavos = actualRemittanceCentavos - batch.expectedRemittanceCentavos;

    await tx
      .update(collectorBatches)
      .set({
        status: "submitted",
        actualRemittanceCentavos,
        varianceCentavos,
        submittedAt: new Date(),
      })
      .where(eq(collectorBatches.id, batchId));

    return {
      batchId,
      expectedRemittanceCentavos: batch.expectedRemittanceCentavos,
      actualRemittanceCentavos,
      varianceCentavos,
      hasVariance: varianceCentavos !== 0,
    };
  });
}

export interface ReconcileBatchResult {
  batchId: string;
  varianceCentavos: number;
  expectedRemittanceCentavos: number;
  actualRemittanceCentavos: number;
  /** The total of the payments this batch created — what the ledger received. */
  ledgerCreditTotalCentavos: number;
  /** True when the ledger credits match the batch's expected remittance exactly. */
  ledgerReconciles: boolean;
}

/**
 * Closes a submitted batch, requiring an explanation for any variance.
 *
 * Reconciliation cannot precede remittance and cannot be applied twice: only a
 * "submitted" batch may be reconciled. The ledger totals of the batch's payments
 * are recomputed and returned so the office can see that the money the batch
 * represents really reached the ledger.
 */
export async function reconcileBatch(
  batchId: string,
  varianceNotes: string | undefined,
  actor: BatchActor
): Promise<ReconcileBatchResult> {
  return db.transaction(async (tx) => {
    const batch = await requireBatchForUpdate(tx, batchId);

    if (batch.status !== "submitted") {
      throw new ConflictError("Only a submitted batch can be reconciled");
    }

    const varianceCentavos = batch.varianceCentavos ?? 0;
    const trimmedNotes = varianceNotes?.trim() ?? "";

    if (varianceCentavos !== 0 && trimmedNotes.length === 0) {
      throw new ValidationError(
        "Variance notes are required when the cash handed in differs from what was collected"
      );
    }

    const paymentRows = await tx
      .select({ amountCentavos: payments.amountCentavos })
      .from(payments)
      .innerJoin(batchAssignments, eq(batchAssignments.paymentId, payments.id))
      .where(eq(batchAssignments.batchId, batchId));

    const ledgerCreditTotalCentavos = paymentRows.reduce(
      (runningTotal, row) => runningTotal + row.amountCentavos,
      0
    );

    await tx
      .update(collectorBatches)
      .set({
        status: "reconciled",
        varianceNotes: trimmedNotes.length > 0 ? trimmedNotes : null,
        reconciledAt: new Date(),
        reconciledBy: actor.id,
      })
      .where(eq(collectorBatches.id, batchId));

    return {
      batchId,
      varianceCentavos,
      expectedRemittanceCentavos: batch.expectedRemittanceCentavos,
      actualRemittanceCentavos: batch.actualRemittanceCentavos ?? 0,
      ledgerCreditTotalCentavos,
      ledgerReconciles: ledgerCreditTotalCentavos === batch.expectedRemittanceCentavos,
    };
  });
}

/** Abandons an open batch. A batch with any recorded collection cannot be cancelled. */
export async function cancelBatch(
  batchId: string,
  reason: string | undefined,
  actor: BatchActor
): Promise<CollectorBatchSummary> {
  return db.transaction(async (tx) => {
    const batch = await requireBatchForUpdate(tx, batchId);
    assertBatchIsVisible(batch, actor);

    if (batch.status !== "open") {
      throw new ConflictError("Only an open batch can be cancelled");
    }

    const collected = await tx
      .select({ id: batchAssignments.id })
      .from(batchAssignments)
      .where(
        and(eq(batchAssignments.batchId, batchId), isNotNull(batchAssignments.collectedAmountCentavos))
      );

    if (collected.length > 0) {
      throw new ConflictError(
        "A batch with recorded collections cannot be cancelled; void the collections first"
      );
    }

    const updated = await tx
      .update(collectorBatches)
      .set({
        status: "cancelled",
        cancelledAt: new Date(),
        cancelledBy: actor.id,
        cancelReason: reason ?? null,
      })
      .where(eq(collectorBatches.id, batchId))
      .returning()
      .then((rows) => rows[0]);

    if (updated === undefined) {
      throw new NotFoundError("Collector batch not found");
    }

    const collectorName = await loadCollectorName(tx, updated.collectorId);
    return toCollectorBatchSummary(updated, collectorName, 0, 0);
  });
}

/** The collector's display name. */
async function loadCollectorName(executor: DbExecutor, collectorId: string): Promise<string> {
  const collector = await executor
    .select({ fullName: users.fullName })
    .from(users)
    .where(eq(users.id, collectorId))
    .limit(1)
    .then((rows) => rows[0]);

  return collector?.fullName ?? "";
}

/** One batch row joined with its collector's name. */
interface BatchListRow {
  batch: CollectorBatch;
  collectorName: string;
}

/** The per-batch assignment counts the list screen needs. */
interface AssignmentCounts {
  assignmentCount: number;
  collectedCount: number;
}

async function loadAssignmentCounts(
  executor: DbExecutor,
  batchIds: readonly string[]
): Promise<Map<string, AssignmentCounts>> {
  const counts = new Map<string, AssignmentCounts>();
  if (batchIds.length === 0) {
    return counts;
  }

  const rows = await executor
    .select({
      batchId: batchAssignments.batchId,
      collectedAmountCentavos: batchAssignments.collectedAmountCentavos,
    })
    .from(batchAssignments)
    .where(inArray(batchAssignments.batchId, [...batchIds]));

  for (const row of rows) {
    const running = counts.get(row.batchId) ?? { assignmentCount: 0, collectedCount: 0 };
    running.assignmentCount += 1;
    if (row.collectedAmountCentavos !== null) {
      running.collectedCount += 1;
    }
    counts.set(row.batchId, running);
  }

  return counts;
}

/** A collector that can be given a batch. */
export interface AssignableCollector {
  id: string;
  fullName: string;
  isActive: boolean;
}

/**
 * Every active collector, for the "which collector is this batch for?" picker.
 *
 * It lives here rather than on the user-management screen because a Billing Clerk
 * creates batches but holds no `users:read` permission.
 */
export async function listAssignableCollectors(): Promise<AssignableCollector[]> {
  return db
    .select({ id: users.id, fullName: users.fullName, isActive: users.isActive })
    .from(users)
    .where(and(eq(users.role, "collector"), eq(users.isActive, true)))
    .orderBy(asc(users.fullName));
}

/**
 * Lists batches, newest field date first.
 *
 * A Collector only ever sees their own batches: their id is forced into the filter
 * here, on the server, so a hand-crafted request cannot read another collector's run.
 */
export async function listCollectorBatches(
  filters: ListCollectorBatchesFilters,
  actor: BatchActor
): Promise<ListCollectorBatchesResult> {
  const conditions = [];

  if (actor.role === "collector") {
    conditions.push(eq(collectorBatches.collectorId, actor.id));
  } else if (filters.collectorId !== undefined) {
    conditions.push(eq(collectorBatches.collectorId, filters.collectorId));
  }

  if (filters.status !== undefined) {
    conditions.push(eq(collectorBatches.status, filters.status));
  }
  if (filters.dateFrom !== undefined) {
    conditions.push(gte(collectorBatches.collectionDate, filters.dateFrom));
  }
  if (filters.dateTo !== undefined) {
    conditions.push(lte(collectorBatches.collectionDate, filters.dateTo));
  }

  const rows: BatchListRow[] = await db
    .select({ batch: collectorBatches, collectorName: users.fullName })
    .from(collectorBatches)
    .innerJoin(users, eq(collectorBatches.collectorId, users.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(collectorBatches.collectionDate), desc(collectorBatches.createdAt));

  const counts = await loadAssignmentCounts(
    db,
    rows.map((row) => row.batch.id)
  );

  const items = rows.map((row) => {
    const batchCounts = counts.get(row.batch.id) ?? { assignmentCount: 0, collectedCount: 0 };
    return toCollectorBatchSummary(
      row.batch,
      row.collectorName,
      batchCounts.assignmentCount,
      batchCounts.collectedCount
    );
  });

  const offset = (filters.page - 1) * filters.pageSize;

  return {
    items: items.slice(offset, offset + filters.pageSize),
    page: filters.page,
    pageSize: filters.pageSize,
    total: items.length,
  };
}

/** Loads one batch with its assignments, enforcing the Collector isolation rule. */
export async function getCollectorBatchDetail(
  batchId: string,
  actor: BatchActor
): Promise<CollectorBatchDetail> {
  return loadBatchDetail(db, batchId, actor);
}

async function loadBatchDetail(
  executor: DbExecutor,
  batchId: string,
  actor: BatchActor
): Promise<CollectorBatchDetail> {
  const row = await executor
    .select({ batch: collectorBatches, collectorName: users.fullName })
    .from(collectorBatches)
    .innerJoin(users, eq(collectorBatches.collectorId, users.id))
    .where(eq(collectorBatches.id, batchId))
    .limit(1)
    .then((rows) => rows[0]);

  if (row === undefined) {
    throw new NotFoundError("Collector batch not found");
  }
  assertBatchIsVisible(row.batch, actor);

  const assignmentRows = await executor
    .select({
      id: batchAssignments.id,
      serviceAccountId: batchAssignments.serviceAccountId,
      serviceAccountNumber: serviceAccounts.serviceAccountNumber,
      subscriberId: subscribers.id,
      subscriberFirstName: subscribers.firstName,
      subscriberLastName: subscribers.lastName,
      planName: subscriptionPlans.name,
      outstandingBalanceCentavos: batchAssignments.outstandingBalanceCentavos,
      collectionResult: batchAssignments.collectionResult,
      collectedAmountCentavos: batchAssignments.collectedAmountCentavos,
      collectedMethod: batchAssignments.collectedMethod,
      paymentId: batchAssignments.paymentId,
      collectorNotes: batchAssignments.collectorNotes,
      voidedAt: batchAssignments.voidedAt,
      voidReason: batchAssignments.voidReason,
    })
    .from(batchAssignments)
    .innerJoin(serviceAccounts, eq(batchAssignments.serviceAccountId, serviceAccounts.id))
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
    .innerJoin(subscriptionPlans, eq(serviceAccounts.planId, subscriptionPlans.id))
    .where(eq(batchAssignments.batchId, batchId))
    .orderBy(asc(serviceAccounts.serviceAccountNumber));

  const assignments: BatchAssignmentSummary[] = assignmentRows.map((assignment) => ({
    id: assignment.id,
    serviceAccountId: assignment.serviceAccountId,
    serviceAccountNumber: assignment.serviceAccountNumber,
    subscriberId: assignment.subscriberId,
    subscriberName: `${assignment.subscriberLastName}, ${assignment.subscriberFirstName}`,
    planName: assignment.planName,
    outstandingBalanceCentavos: assignment.outstandingBalanceCentavos,
    collectionResult: assignment.collectionResult,
    collectedAmountCentavos: assignment.collectedAmountCentavos,
    collectedMethod: assignment.collectedMethod,
    paymentId: assignment.paymentId,
    collectorNotes: assignment.collectorNotes,
    voidedAt: assignment.voidedAt,
    voidReason: assignment.voidReason,
  }));

  const collectedTotalCentavos = assignments.reduce(
    (runningTotal, assignment) => runningTotal + (assignment.collectedAmountCentavos ?? 0),
    0
  );
  const outstandingTotalCentavos = assignments.reduce(
    (runningTotal, assignment) => runningTotal + assignment.outstandingBalanceCentavos,
    0
  );

  return {
    ...toCollectorBatchSummary(
      row.batch,
      row.collectorName,
      assignments.length,
      assignments.filter((assignment) => assignment.collectedAmountCentavos !== null).length
    ),
    assignments,
    collectedTotalCentavos,
    outstandingTotalCentavos,
  };
}