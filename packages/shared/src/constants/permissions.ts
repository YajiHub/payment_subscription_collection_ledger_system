// The source of truth for what each role can do.
//
// Any change to permissions requires updating ONLY this file.
// The server middleware reads from here — no permission logic is scattered in
// route handlers, and the client uses the same function to hide UI it cannot use.
// The server remains the authority: hiding a button is only a UX hint.

import type { UserRole } from "./roles";

// Every permission in the system has a name.
// Routes declare which permission they require.
// The auth middleware checks whether the user's role has that permission.
export type Permission =
  // User management
  | "users:create"
  | "users:read"
  | "users:update"
  | "users:deactivate"
  // Subscriber management
  | "subscribers:create"
  | "subscribers:read"
  | "subscribers:update"
  | "subscribers:suspend"
  | "subscribers:reconnect"
  // Plans and packages
  | "plans:create"
  | "plans:read"
  | "plans:update"
  // Billing
  | "invoices:generate"
  | "invoices:read"
  | "invoices:void"
  // Payments
  | "payments:post"
  | "payments:read"
  | "payments:reverse"
  | "receipts:print"
  // Ledger and statement of account
  | "ledger:read"
  | "ledger:verify"
  | "ledger:adjust"
  // Collector operations
  | "collector_batches:create"
  | "collector_batches:read"
  | "collector_batches:remit"
  | "collector_batches:reconcile"
  // Reports
  | "reports:view"
  | "reports:management_view"
  | "reports:export"
  // System
  | "system:backup"
  | "system:settings"
  // Audit trail
  | "audit:read";

// The permission matrix: what each role is allowed to do.
// If a permission is not listed for a role, access is denied.
export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  admin: [
    "users:create",
    "users:read",
    "users:update",
    "users:deactivate",
    "subscribers:create",
    "subscribers:read",
    "subscribers:update",
    "subscribers:suspend",
    "subscribers:reconnect",
    "plans:create",
    "plans:read",
    "plans:update",
    "invoices:generate",
    "invoices:read",
    "invoices:void",
    "payments:post",
    "payments:read",
    "payments:reverse",
    "receipts:print",
    "ledger:read",
    "ledger:verify",
    "ledger:adjust",
    "collector_batches:create",
    "collector_batches:read",
    "collector_batches:remit",
    "collector_batches:reconcile",
    "reports:view",
    "reports:management_view",
    "reports:export",
    "system:backup",
    "system:settings",
    // Phase 9 §7: only the Administrator may read the audit trail.
    "audit:read",
  ],

  billing_clerk: [
    "subscribers:create",
    "subscribers:read",
    "subscribers:update",
    "subscribers:suspend",
    "subscribers:reconnect",
    // Phase 3 §5 and §7 give the Billing Clerk the Plan Management page, so the
    // clerk may add plans and retire them. Price changes are still a new plan.
    "plans:create",
    "plans:read",
    "plans:update",
    "invoices:generate",
    "invoices:read",
    "payments:read",
    "receipts:print",
    "ledger:read",
    // Phase 7 §2: the Billing Clerk creates collector batches and assigns accounts.
    "collector_batches:create",
    "reports:view",
    // Phase 8 §9: the monthly billing and receivables reports are management views.
    "reports:management_view",
  ],

  cashier: [
    "subscribers:read",
    "invoices:read",
    "payments:post",
    "payments:read",
    "receipts:print",
    "ledger:read",
    // Phase 7 §2: the Cashier reviews and reconciles submitted batches, but may
    // never create or remit a collector batch — that is the field side.
    "collector_batches:read",
    "collector_batches:reconcile",
    "reports:view",
  ],

  collector: [
    "subscribers:read",
    "invoices:read",
    "payments:read",
    // Phase 7 §6: office staff assemble a batch and assign accounts to it. A
    // collector works the batches assigned to them and remits the cash, but
    // does not create batches — that would let field staff invent assignments.
    "collector_batches:read",
    "collector_batches:remit",
    "reports:view",
  ],

  manager: [
    "subscribers:read",
    "plans:read",
    "invoices:read",
    "payments:read",
    "ledger:read",
    "collector_batches:read",
    "reports:view",
    "reports:management_view",
    "reports:export",
  ],
};

// Utility: check if a role has a specific permission.
// Kept intentionally simple — it is a pure lookup with no side effects.
//
// An unknown role has NO permissions. A role can only reach here from a verified
// JWT, so an unknown one means a token minted by an older build; denying it is the
// safe answer, and it must be a denial rather than a crash while reading the matrix.
export function roleHasPermission(role: UserRole, permission: Permission): boolean {
  const grantedPermissions: readonly Permission[] | undefined = ROLE_PERMISSIONS[role];
  return grantedPermissions !== undefined && grantedPermissions.includes(permission);
}
