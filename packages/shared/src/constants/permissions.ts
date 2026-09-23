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
  // Collector operations
  | "collector_batches:create"
  | "collector_batches:read"
  | "collector_batches:remit"
  | "collector_batches:reconcile"
  // Reports
  | "reports:view"
  | "reports:export"
  // System
  | "system:backup"
  | "system:settings";

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
    "collector_batches:create",
    "collector_batches:read",
    "collector_batches:remit",
    "collector_batches:reconcile",
    "reports:view",
    "reports:export",
    "system:backup",
    "system:settings",
  ],

  billing_clerk: [
    "subscribers:create",
    "subscribers:read",
    "subscribers:update",
    "subscribers:suspend",
    "subscribers:reconnect",
    "plans:read",
    "invoices:generate",
    "invoices:read",
    "payments:read",
    "receipts:print",
    "reports:view",
  ],

  cashier: [
    "subscribers:read",
    "invoices:read",
    "payments:post",
    "payments:read",
    "receipts:print",
    "reports:view",
  ],

  collector: [
    "subscribers:read",
    "invoices:read",
    "payments:read",
    "collector_batches:create",
    "collector_batches:read",
    "collector_batches:remit",
    "reports:view",
  ],

  manager: [
    "subscribers:read",
    "plans:read",
    "invoices:read",
    "payments:read",
    "collector_batches:read",
    "reports:view",
    "reports:export",
  ],
};

// Utility: check if a role has a specific permission.
// Kept intentionally simple — it is a pure lookup with no side effects.
export function roleHasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
