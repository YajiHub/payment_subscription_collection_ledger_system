// The audit-trail vocabulary shared by the client and the server.
//
// Audit actions use dot notation: `domain.verb`. That makes an action easy to
// filter either by its domain ("show me every payment event") or exactly
// ("show me every reversal"). The strings are the contract, so a route handler
// and the audit page can never disagree about what a row means.

export const AUDIT_ACTIONS = [
  // Financial events
  "invoice.posted",
  "invoice.voided",
  // S2-3: the two invoice adjustments an auditor asks about — a charged
  // installation fee and a discount applied to a draft invoice.
  "invoice.installation_fee_charged",
  "invoice.discount_applied",
  "payment.posted",
  "payment.reversed",
  // Recording a GCash claim (S3-1, S3-2) and attaching its proof are consequential
  // money-adjacent actions by a named user even though neither moves a balance. Both
  // are recorded as PENDING evidence, so an auditor never reads a claim as a receipt.
  "payment.gcash_claim_recorded",
  "payment.gcash_screenshot_uploaded",
  "payment.gcash_verified",
  "payment.gcash_rejected",
  "billing_run.executed",
  "ledger.manual_entry_posted",

  // Subscription plans (S5-6)
  "plan.created",
  "plan.updated",
  "plan.retired",

  // Field collection — the batch lifecycle (S5-6). `remitted` is the step that
  // declares the cash handed in; `reconciled` closes the batch at the office and
  // `closed` is the explicit final close confirmation.
  "collector_batch.created",
  "collector_batch.submitted",
  "collector_batch.remitted",
  "collector_batch.reconciled",
  "collector_batch.closed",
  "collector_batch.cancelled",

  // Subscriber and service control
  "subscriber.created",
  "subscriber.updated",
  "service_account.suspended",
  // S4-8: completing a reconnection (technician, request and completion dates
  // recorded beside the fee invoice).
  "service_account.reconnected",
  // Activating a pending account once installation is complete.
  "service_account.activated",

  // System configuration (S5-6)
  "system_setting.updated",
  "backup.created",
  "backup.verified",
  "backup.restored",

  // Security events
  "user.created",
  "user.role_changed",
  "user.password_changed",
  "user.deactivated",
  "auth.login_succeeded",
  "auth.login_failed",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

// What kind of record an audit entry points at. Kept as a small closed list so
// the audit page's entity filter is a dropdown, not free text.
export const AUDIT_ENTITY_TYPES = [
  "invoice",
  "payment",
  "subscriber",
  "service_account",
  "user",
  "billing_run",
  "session",
  "collector_batch",
  "ledger_entry",
  "plan",
  "system_setting",
  "backup",
] as const;

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

// Human-readable action labels for the audit page.
export const AUDIT_ACTION_LABELS = {
  "invoice.posted": "Invoice posted",
  "invoice.voided": "Invoice voided",
  "invoice.installation_fee_charged": "Installation fee charged",
  "invoice.discount_applied": "Discount applied",
  "payment.posted": "Payment posted",
  "payment.reversed": "Payment reversed",
  "payment.gcash_claim_recorded": "GCash claim recorded (pending)",
  "payment.gcash_screenshot_uploaded": "GCash proof screenshot uploaded",
  "payment.gcash_verified": "GCash payment verified",
  "payment.gcash_rejected": "GCash payment rejected",
  "billing_run.executed": "Monthly billing run",
  "ledger.manual_entry_posted": "Manual ledger entry posted",
  "plan.created": "Plan created",
  "plan.updated": "Plan updated",
  "plan.retired": "Plan retired",
  "collector_batch.created": "Collector batch created",
  "collector_batch.submitted": "Collector batch submitted",
  "collector_batch.remitted": "Collector batch remitted",
  "collector_batch.reconciled": "Collector batch reconciled",
  "collector_batch.closed": "Collector batch closed",
  "collector_batch.cancelled": "Collector batch cancelled",
  "subscriber.created": "Subscriber created",
  "subscriber.updated": "Subscriber updated",
  "service_account.suspended": "Service account suspended",
  "service_account.reconnected": "Service account reconnected",
  "service_account.activated": "Service account activated",
  "system_setting.updated": "System setting changed",
  "backup.created": "Backup created",
  "backup.verified": "Backup verified",
  "backup.restored": "Backup restored",
  "user.created": "User created",
  "user.role_changed": "User role changed",
  "user.password_changed": "User password changed",
  "user.deactivated": "User deactivated",
  "auth.login_succeeded": "Login succeeded",
  "auth.login_failed": "Login failed",
} as const satisfies Record<AuditAction, string>;

/**
 * The entity id written for an action that has no single affected row (a failed
 * login for an unknown username, an automatic billing run). The column is
 * NOT NULL so that every audit row points at something, and a nil UUID is the
 * conventional "no entity" value.
 */
export const AUDIT_NO_ENTITY_ID = "00000000-0000-0000-0000-000000000000";
