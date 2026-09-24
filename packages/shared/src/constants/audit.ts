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
  "payment.posted",
  "payment.reversed",
  "billing_run.executed",

  // Subscriber and service control
  "subscriber.created",
  "subscriber.updated",
  "service_account.suspended",

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
] as const;

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

// Human-readable action labels for the audit page.
export const AUDIT_ACTION_LABELS = {
  "invoice.posted": "Invoice posted",
  "invoice.voided": "Invoice voided",
  "payment.posted": "Payment posted",
  "payment.reversed": "Payment reversed",
  "billing_run.executed": "Monthly billing run",
  "subscriber.created": "Subscriber created",
  "subscriber.updated": "Subscriber updated",
  "service_account.suspended": "Service account suspended",
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
