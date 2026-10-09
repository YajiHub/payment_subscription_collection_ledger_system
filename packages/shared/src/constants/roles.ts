// The five roles defined by the lab specification.
// Adding a role requires updating this list and the Phase 2 permission matrix.

export const USER_ROLES = ["admin", "billing_clerk", "cashier", "collector", "manager"] as const;

export type UserRole = (typeof USER_ROLES)[number];

/** Human-readable names for each role, used in the UI and on printed documents. */
export const USER_ROLE_LABELS = {
  admin: "Administrator",
  billing_clerk: "Billing Clerk",
  cashier: "Cashier",
  collector: "Collector",
  manager: "Manager",
} as const satisfies Record<UserRole, string>;

// ─── Roles stored in the database (S1-1, section 3.1) ────────────────────────
//
// The five roles above are the legacy `users.role` enum. Section 3.1 asks for
// seven roles, so the system now stores roles as rows in the `roles` table and
// grants them through `user_roles`. These codes are the stable machine names;
// they must match the rows the RBAC migration seeds.
//
// A user may hold several of these at once — effective permissions are the union.
export const SYSTEM_ROLES = [
  "owner",
  "administrator",
  "cashier",
  "collection_supervisor",
  "accounting_auditor",
  "technician",
  "read_only_viewer",
] as const;

export type SystemRole = (typeof SYSTEM_ROLES)[number];

/** Human-readable names for the seven stored roles. */
export const SYSTEM_ROLE_LABELS = {
  owner: "Owner / Super Admin",
  administrator: "Administrator",
  cashier: "Cashier",
  collection_supervisor: "Collection Supervisor",
  accounting_auditor: "Accounting / Auditor",
  technician: "Technician",
  read_only_viewer: "Read-only Viewer",
} as const satisfies Record<SystemRole, string>;

/** Helper to get human readable label for any role (SystemRole or UserRole). */
export function getRoleLabel(role: string): string {
  if (role in SYSTEM_ROLE_LABELS) {
    return SYSTEM_ROLE_LABELS[role as SystemRole];
  }
  if (role in USER_ROLE_LABELS) {
    return USER_ROLE_LABELS[role as UserRole];
  }
  return role.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

/** One-line description of what each stored role is for; printed on the roles screen. */
export const SYSTEM_ROLE_DESCRIPTIONS = {
  owner: "Unrestricted access, including backups, settings and the audit trail",
  administrator: "Runs the system day to day with the full operational permission set",
  cashier: "Counter work: subscriptions, billing runs, cashiering and receipts",
  collection_supervisor: "Assigns field work, receives remittances and reconciles batches",
  accounting_auditor: "Reads every financial record and the audit trail, changes nothing",
  technician: "Field installation and service work; reads accounts and bills",
  read_only_viewer: "Read-only oversight of subscribers, billing and reports",
} as const satisfies Record<SystemRole, string>;

// How the migration maps each existing `users.role` value onto a stored role.
// The mapping is deliberately conservative: no legacy user loses a permission.
// Where a legacy role maps onto a broader new role, the new role carries the
// union of every legacy role that maps onto it (see SYSTEM_ROLE_PERMISSIONS).
export const LEGACY_ROLE_TO_SYSTEM_ROLE = {
  admin: "administrator",
  billing_clerk: "administrator",
  cashier: "cashier",
  collector: "collection_supervisor",
  manager: "read_only_viewer",
} as const satisfies Record<UserRole, SystemRole>;