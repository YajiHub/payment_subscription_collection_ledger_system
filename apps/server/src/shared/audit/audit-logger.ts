// The audit logger — the single way an audit row is written.
//
// Call this from a route handler AFTER the operation has succeeded. Audit
// logging must NEVER abort the operation: the money has already moved, so a
// failed audit write is reported to the server console for the ops team and
// nothing else. That is why the function swallows its own errors.
//
// Snapshots are built explicitly per action. A snapshot must never contain a
// password hash, a token, or any other secret — the trail is readable by an
// administrator and may be exported.

import {
  AUDIT_NO_ENTITY_ID,
  type AuditAction,
  type AuditEntityType,
  type CollectorBatchStatus,
  type InvoiceStatus,
  type PaymentStatus,
} from "@bcis/shared";
import type { FastifyRequest } from "fastify";

import { db } from "../../db/connection";
import { auditLogs } from "../../db/schema/audit";

/** Who performed an action and from where. */
export interface AuditActor {
  /** The authenticated user's id, or null for a system-generated action. */
  userId: string | null;
  /** The username at the time of the action, when known. */
  username?: string | null;
  clientIpAddress?: string | null;
}

export interface AuditEntry {
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string;
  // JSON snapshots. `unknown` keeps every caller free to pass its own document
  // type; drizzle's jsonb column stores whatever JSON-serializable value it is.
  previousState?: unknown;
  newState?: unknown;
  description: string;
  performedBy?: string | null;
  performedByUsername?: string | null;
  clientIpAddress?: string | null;
}

/**
 * Writes one audit row. Never throws: a failure is logged and swallowed so the
 * main operation is never rolled back by the audit trail.
 */
export async function logAuditEntry(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      previousState: entry.previousState ?? null,
      newState: entry.newState ?? null,
      description: entry.description,
      performedBy: entry.performedBy ?? null,
      performedByUsername: entry.performedByUsername ?? null,
      clientIpAddress: entry.clientIpAddress ?? null,
    });
  } catch (error) {
    // Auditing must never crash the operation it is recording.
    console.error("[AUDIT] Failed to write audit log entry:", error);
    console.error("[AUDIT] Entry that failed:", JSON.stringify(entry));
  }
}

/** The fields every audited document carries. A spread of any row satisfies it. */
type AuditedDocument = { id: string } & Record<string, unknown>;

function actorFields(actor: AuditActor) {
  return {
    performedBy: actor.userId,
    performedByUsername: actor.username ?? null,
    clientIpAddress: actor.clientIpAddress ?? null,
  };
}

/** Builds an actor from an authenticated request. Never carries a credential. */
export function requestActor(request: FastifyRequest): AuditActor {
  return {
    userId: request.user?.id ?? null,
    clientIpAddress: request.ip,
  };
}

// ─── Named helpers for the actions the system records ────────────────────────
// Each helper fixes the action name, the entity type, and the description
// format, so two call sites cannot describe the same event differently.

export const audit = {
  invoicePosted(document: AuditedDocument, actor: AuditActor): Promise<void> {
    return logAuditEntry({
      action: "invoice.posted",
      entityType: "invoice",
      entityId: document.id,
      newState: document,
      description: `Invoice ${String(document.invoiceNumber)} posted to the ledger`,
      ...actorFields(actor),
    });
  },

  invoiceVoided(
    document: AuditedDocument,
    previousStatus: InvoiceStatus,
    reason: string,
    actor: AuditActor
  ): Promise<void> {
    return logAuditEntry({
      action: "invoice.voided",
      entityType: "invoice",
      entityId: document.id,
      // The status the invoice actually held is passed in, because the document
      // handed to this helper has already been voided. A literal here would
      // misreport what the void changed (and `posted` stopped existing when
      // migration 0020 renamed it to `unpaid`).
      previousState: { ...document, status: previousStatus },
      newState: { ...document, status: "void" },
      description: `Invoice ${String(document.invoiceNumber)} voided. Reason: ${reason}`,
      ...actorFields(actor),
    });
  },

  paymentPosted(document: AuditedDocument, actor: AuditActor): Promise<void> {
    return logAuditEntry({
      action: "payment.posted",
      entityType: "payment",
      entityId: document.id,
      newState: document,
      description: `Payment ${String(document.receiptNumber)} posted (${String(document.amountCentavos)} centavos)`,
      ...actorFields(actor),
    });
  },

  paymentReversed(
    paymentId: string,
    receiptNumber: string | null,
    // The status the payment actually held, passed in because the row handed to
    // this helper has already been moved to `reversed`. A literal here would
    // misreport what the reversal changed.
    previousStatus: PaymentStatus,
    reason: string,
    actor: AuditActor
  ): Promise<void> {
    return logAuditEntry({
      action: "payment.reversed",
      entityType: "payment",
      entityId: paymentId,
      previousState: { id: paymentId, receiptNumber, status: previousStatus },
      newState: { id: paymentId, receiptNumber, status: "reversed" },
      description: `Payment ${receiptNumber ?? paymentId} reversed. Reason: ${reason}`,
      ...actorFields(actor),
    });
  },

  subscriberCreated(document: AuditedDocument, actor: AuditActor): Promise<void> {
    return logAuditEntry({
      action: "subscriber.created",
      entityType: "subscriber",
      entityId: document.id,
      newState: document,
      description: `Subscriber ${String(document.accountNumber)} created`,
      ...actorFields(actor),
    });
  },

  subscriberUpdated(
    document: AuditedDocument,
    actor: AuditActor,
    previousState?: unknown
  ): Promise<void> {
    return logAuditEntry({
      action: "subscriber.updated",
      entityType: "subscriber",
      entityId: document.id,
      previousState: previousState ?? null,
      newState: document,
      description: `Subscriber ${String(document.accountNumber)} updated`,
      ...actorFields(actor),
    });
  },

  serviceAccountSuspended(
    document: AuditedDocument,
    reason: string,
    actor: AuditActor
  ): Promise<void> {
    return logAuditEntry({
      action: "service_account.suspended",
      entityType: "service_account",
      entityId: document.id,
      newState: document,
      description: `Service account ${String(document.serviceAccountNumber)} suspended. Reason: ${reason}`,
      ...actorFields(actor),
    });
  },

  userCreated(document: AuditedDocument, actor: AuditActor): Promise<void> {
    return logAuditEntry({
      action: "user.created",
      entityType: "user",
      entityId: document.id,
      newState: document,
      description: `User account ${String(document.username)} created with role ${String(document.role)}`,
      ...actorFields(actor),
    });
  },

  userRoleChanged(
    document: AuditedDocument,
    previousRole: string,
    newRole: string,
    actor: AuditActor
  ): Promise<void> {
    return logAuditEntry({
      action: "user.role_changed",
      entityType: "user",
      entityId: document.id,
      previousState: { id: document.id, username: document.username, role: previousRole },
      newState: { id: document.id, username: document.username, role: newRole },
      description: `User ${String(document.username)} role changed from ${previousRole} to ${newRole}`,
      ...actorFields(actor),
    });
  },

  userPasswordChanged(document: AuditedDocument, actor: AuditActor): Promise<void> {
    // The snapshot deliberately omits the hash: the audit trail never carries a
    // credential, even in hashed form.
    return logAuditEntry({
      action: "user.password_changed",
      entityType: "user",
      entityId: document.id,
      description: `Password changed for user ${String(document.username)}`,
      ...actorFields(actor),
    });
  },

  userDeactivated(document: AuditedDocument, actor: AuditActor): Promise<void> {
    return logAuditEntry({
      action: "user.deactivated",
      entityType: "user",
      entityId: document.id,
      newState: { id: document.id, username: document.username, isActive: false },
      description: `User account ${String(document.username)} deactivated`,
      ...actorFields(actor),
    });
  },

  billingRunExecuted(result: Record<string, unknown>, actor: AuditActor): Promise<void> {
    return logAuditEntry({
      action: "billing_run.executed",
      entityType: "billing_run",
      entityId: AUDIT_NO_ENTITY_ID,
      newState: result,
      description: `Monthly billing run for ${String(result.billingPeriodYear)}-${String(result.billingPeriodMonth)} generated ${String(result.totalInvoicesGenerated)} invoice(s)`,
      ...actorFields(actor),
    });
  },

  loginSucceeded(userId: string, username: string, clientIpAddress: string): Promise<void> {
    return logAuditEntry({
      action: "auth.login_succeeded",
      entityType: "session",
      entityId: userId,
      description: `Login succeeded for ${username}`,
      performedBy: userId,
      performedByUsername: username,
      clientIpAddress,
    });
  },

  loginFailed(
    username: string,
    clientIpAddress: string,
    reason: string
  ): Promise<void> {
    return logAuditEntry({
      action: "auth.login_failed",
      entityType: "session",
      entityId: AUDIT_NO_ENTITY_ID,
      description: `Login failed for ${username}. Reason: ${reason}`,
      performedBy: null,
      performedByUsername: username,
      clientIpAddress,
    });
  },

  // ─── GCash verification (S3-2, S5-6) ──────────────────────────────────────
  gcashPaymentVerified(
    paymentId: string,
    gcashReferenceNumber: string,
    // The status the payment actually held is passed in rather than assumed.
    previousStatus: PaymentStatus,
    actor: AuditActor
  ): Promise<void> {
    return logAuditEntry({
      action: "payment.gcash_verified",
      entityType: "payment",
      entityId: paymentId,
      previousState: { id: paymentId, gcashReferenceNumber, status: previousStatus },
      newState: { id: paymentId, gcashReferenceNumber, status: "posted" },
      description: `GCash payment ${gcashReferenceNumber} verified`,
      ...actorFields(actor),
    });
  },

  gcashPaymentRejected(
    paymentId: string,
    gcashReferenceNumber: string,
    previousStatus: PaymentStatus,
    reason: string,
    actor: AuditActor
  ): Promise<void> {
    return logAuditEntry({
      action: "payment.gcash_rejected",
      entityType: "payment",
      entityId: paymentId,
      previousState: { id: paymentId, gcashReferenceNumber, status: previousStatus },
      newState: { id: paymentId, gcashReferenceNumber, status: "rejected" },
      description: `GCash payment ${gcashReferenceNumber} rejected. Reason: ${reason}`,
      ...actorFields(actor),
    });
  },

  // ─── Manual ledger entry (S5-6) ──────────────────────────────────────────
  manualLedgerEntryPosted(
    document: { entryId: string; serviceAccountId: string; entryType: string; amountCentavos: number },
    reason: string,
    actor: AuditActor
  ): Promise<void> {
    return logAuditEntry({
      action: "ledger.manual_entry_posted",
      entityType: "ledger_entry",
      entityId: document.entryId,
      newState: document,
      description: `Manual ${document.entryType} entry of ${document.amountCentavos} centavos posted. Reason: ${reason}`,
      ...actorFields(actor),
    });
  },

  // ─── Plans (S5-6) ────────────────────────────────────────────────────────
  planCreated(document: AuditedDocument, actor: AuditActor): Promise<void> {
    return logAuditEntry({
      action: "plan.created",
      entityType: "plan",
      entityId: document.id,
      newState: document,
      description: `Plan ${String(document.name)} created`,
      ...actorFields(actor),
    });
  },

  planUpdated(
    document: AuditedDocument,
    previousState: unknown,
    actor: AuditActor
  ): Promise<void> {
    return logAuditEntry({
      action: "plan.updated",
      entityType: "plan",
      entityId: document.id,
      previousState: previousState ?? null,
      newState: document,
      description: `Plan ${String(document.name)} updated`,
      ...actorFields(actor),
    });
  },

  planRetired(
    document: AuditedDocument,
    // The active flag the plan actually held, passed in because `retirePlan`
    // records no prior state and a plan may be retired more than once.
    previousIsActive: boolean,
    actor: AuditActor
  ): Promise<void> {
    return logAuditEntry({
      action: "plan.retired",
      entityType: "plan",
      entityId: document.id,
      previousState: { id: document.id, name: document.name, isActive: previousIsActive },
      newState: { id: document.id, name: document.name, isActive: false },
      description: `Plan ${String(document.name)} retired`,
      ...actorFields(actor),
    });
  },

  // ─── Collector batches (S5-6) ────────────────────────────────────────────
  collectorBatchCreated(
    document: AuditedDocument,
    assignmentCount: number,
    actor: AuditActor
  ): Promise<void> {
    return logAuditEntry({
      action: "collector_batch.created",
      entityType: "collector_batch",
      entityId: document.id,
      newState: document,
      description: `Collector batch ${String(document.batchNumber)} created with ${assignmentCount} account(s)`,
      ...actorFields(actor),
    });
  },

  collectorBatchSubmitted(
    document: { batchId: string; expectedRemittanceCentavos: number; actualRemittanceCentavos: number; varianceCentavos: number },
    // The status the batch actually held: submitting is allowed from `open` (nothing
    // collected) or `in_progress`, so only the caller knows which.
    previousStatus: CollectorBatchStatus,
    actor: AuditActor
  ): Promise<void> {
    return logAuditEntry({
      action: "collector_batch.submitted",
      entityType: "collector_batch",
      entityId: document.batchId,
      previousState: { status: previousStatus, expectedRemittanceCentavos: document.expectedRemittanceCentavos },
      newState: { status: "submitted", actualRemittanceCentavos: document.actualRemittanceCentavos, varianceCentavos: document.varianceCentavos },
      description: `Collector batch submitted with ${document.actualRemittanceCentavos} centavos declared against ${document.expectedRemittanceCentavos} expected (variance ${document.varianceCentavos})`,
      ...actorFields(actor),
    });
  },

  collectorBatchRemitted(
    document: { batchId: string; expectedRemittanceCentavos: number; actualRemittanceCentavos: number; varianceCentavos: number },
    // Remittance happens AFTER submission: the batch really moves from `submitted`
    // (first instalment) or `remitted` (a later instalment or a correction) to
    // `remitted`, never from `open` to `submitted`.
    previousStatus: CollectorBatchStatus,
    actor: AuditActor
  ): Promise<void> {
    return logAuditEntry({
      action: "collector_batch.remitted",
      entityType: "collector_batch",
      entityId: document.batchId,
      previousState: { status: previousStatus, expectedRemittanceCentavos: document.expectedRemittanceCentavos },
      newState: { status: "remitted", actualRemittanceCentavos: document.actualRemittanceCentavos, varianceCentavos: document.varianceCentavos },
      description: `Collector batch remitted ${document.actualRemittanceCentavos} centavos against ${document.expectedRemittanceCentavos} expected (variance ${document.varianceCentavos})`,
      ...actorFields(actor),
    });
  },

  collectorBatchReconciled(
    document: { batchId: string; expectedRemittanceCentavos: number; actualRemittanceCentavos: number; varianceCentavos: number },
    // Reconciliation follows remittance, so the real prior status is `remitted`.
    previousStatus: CollectorBatchStatus,
    varianceNotes: string | undefined,
    actor: AuditActor
  ): Promise<void> {
    return logAuditEntry({
      action: "collector_batch.reconciled",
      entityType: "collector_batch",
      entityId: document.batchId,
      previousState: { status: previousStatus, varianceCentavos: document.varianceCentavos },
      newState: { status: "reconciled" },
      description: `Collector batch reconciled (variance ${document.varianceCentavos})${
        varianceNotes !== undefined && varianceNotes.trim().length > 0
          ? `. Notes: ${varianceNotes.trim()}`
          : ""
      }`,
      ...actorFields(actor),
    });
  },

  collectorBatchClosed(
    document: { batchId: string; batchNumber?: string },
    previousStatus: CollectorBatchStatus,
    actor: AuditActor
  ): Promise<void> {
    return logAuditEntry({
      action: "collector_batch.closed",
      entityType: "collector_batch",
      entityId: document.batchId,
      previousState: { status: previousStatus },
      newState: { status: "closed" },
      description: `Collector batch ${document.batchNumber ?? document.batchId} closed`,
      ...actorFields(actor),
    });
  },

  collectorBatchCancelled(
    document: AuditedDocument,
    reason: string | undefined,
    actor: AuditActor
  ): Promise<void> {
    return logAuditEntry({
      action: "collector_batch.cancelled",
      entityType: "collector_batch",
      entityId: document.id,
      // `cancelBatch` refuses any batch that is not `open`, so the real prior status
      // is `open` by construction; the new status is read off the cancelled row.
      previousState: { id: document.id, batchNumber: document.batchNumber, status: "open" },
      newState: { id: document.id, batchNumber: document.batchNumber, status: "cancelled" },
      description: `Collector batch ${String(document.batchNumber)} cancelled${
        reason !== undefined && reason.trim().length > 0 ? `. Reason: ${reason.trim()}` : ""
      }`,
      ...actorFields(actor),
    });
  },

  // ─── System settings (S5-6) ──────────────────────────────────────────────
  systemSettingUpdated(
    key: string,
    previousValue: string | null,
    newValue: string,
    actor: AuditActor
  ): Promise<void> {
    return logAuditEntry({
      action: "system_setting.updated",
      entityType: "system_setting",
      entityId: AUDIT_NO_ENTITY_ID,
      previousState: { key, value: previousValue },
      newState: { key, value: newValue },
      description: `System setting ${key} changed from ${previousValue ?? "(unset)"} to ${newValue}`,
      ...actorFields(actor),
    });
  },

  // ─── Backups (S5-3) ──────────────────────────────────────────────────────
  backupCreated(document: AuditedDocument, actor: AuditActor): Promise<void> {
    return logAuditEntry({
      action: "backup.created",
      entityType: "backup",
      entityId: document.id,
      newState: document,
      description: `Backup ${String(document.filename)} created and verified (${String(document.sizeBytes)} bytes)`,
      ...actorFields(actor),
    });
  },

  backupVerified(document: AuditedDocument, actor: AuditActor): Promise<void> {
    return logAuditEntry({
      action: "backup.verified",
      entityType: "backup",
      entityId: document.id,
      newState: document,
      description: `Backup ${String(document.filename)} verified`,
      ...actorFields(actor),
    });
  },

  backupRestored(document: AuditedDocument, actor: AuditActor): Promise<void> {
    return logAuditEntry({
      action: "backup.restored",
      entityType: "backup",
      entityId: document.id,
      newState: document,
      description: `Database restored from backup ${String(document.filename)}`,
      ...actorFields(actor),
    });
  },
};
