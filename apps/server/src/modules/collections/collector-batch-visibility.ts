// Who may SEE which collector batch — derived from the SAME authority as who may
// DO what.
//
// Batch reads used to be scoped by the legacy `users.role` carried in the JWT,
// while every route guard and the whole RBAC screen were driven by the resolved
// database grants. Those two disagree for any user whose stored role is not their
// legacy enum value — every demo collector holds `collection_supervisor`, so they
// were a supervisor for what they may DO and a collector for what they may SEE.
// The visible failure was a collector creating a batch for another collector and
// being refused the read back: the batch was created into a state its creator
// could not see.
//
// Visibility now asks the permission resolver the same questions the guards ask,
// so the two answers cannot drift apart again.

import type { UserRole } from "@bcis/shared";

import { callerHasPermission } from "../../shared/rbac/permission-resolver";

/**
 * Whether the caller may see and work on EVERY collector's batch.
 *
 * Fail closed, in three steps:
 *   1. Visibility needs `collector_batches:read`, the same permission the batch
 *      routes need. A caller without it sees nothing — not everything.
 *   2. A caller who may assemble a run for another collector
 *      (`collector_batches:create`) or reconcile one (`collector_batches:reconcile`)
 *      sees every batch: they are asked to act on batches that are not theirs.
 *   3. Otherwise they are a field collector if they hand in field money
 *      (`collector_batches:remit`) — scoped to their own batches. Read-only
 *      oversight that changes nothing sees every batch.
 *
 * Note the deliberate consequence: a COLLECTION SUPERVISOR now sees the batches
 * they can act on rather than only the ones that were labelled theirs. That is the
 * point — they are the same grants that let them create and reconcile any batch.
 */
export async function callerSeesEveryCollectorBatch(
  userId: string,
  legacyRole: UserRole
): Promise<boolean> {
  const mayReadBatches = await callerHasPermission(userId, legacyRole, "collector_batches:read");
  if (!mayReadBatches) {
    return false;
  }

  if (await callerHasPermission(userId, legacyRole, "collector_batches:create")) {
    return true;
  }

  if (await callerHasPermission(userId, legacyRole, "collector_batches:reconcile")) {
    return true;
  }

  const worksAFieldRun = await callerHasPermission(userId, legacyRole, "collector_batches:remit");
  return !worksAFieldRun;
}
