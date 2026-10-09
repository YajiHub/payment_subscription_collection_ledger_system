// The source of truth for what each role can do.
//
// Any change to permissions requires updating ONLY this file.
// The server middleware reads from here — no permission logic is scattered in
// route handlers, and the client uses the same function to hide UI it cannot use.
// The server remains the authority: hiding a button is only a UX hint.

import type { SystemRole, UserRole } from "./roles";

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
  // GCash verification (S3-2, S5-2) — a verifier confirms or rejects a pending
  // GCash payment. Separate from posting so the verifier can be a different
  // person from the one who recorded the payment.
  | "payments:verify_gcash"
  | "payments:reject_gcash"
  // Manual allocation (S3-5, S5-2) — directs a posted payment at chosen invoices
  // instead of the oldest-first default.
  | "payments:allocate_manually"
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
  // Backup as an application feature (S5-3, S12-9). `system:backup` remains the
  // legacy combined permission; `backup:create` and `backup:restore` split it so
  // producing an archive and overwriting the database are separately grantable.
  | "backup:create"
  | "backup:restore"
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
    "payments:verify_gcash",
    "payments:reject_gcash",
    "payments:allocate_manually",
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
    "backup:create",
    "backup:restore",
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
    // S5-8: listing the assignable collectors is a READ, so the clerk needs the read
    // permission too — a clerk who may create a batch must be able to pick one.
    "collector_batches:create",
    "collector_batches:read",
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
    // S3-2 / S3-5: the counter operator verifies GCash proofs and may direct a
    // payment at particular invoices when the automatic oldest-first rule is wrong.
    "payments:verify_gcash",
    "payments:reject_gcash",
    "payments:allocate_manually",
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
export function roleHasPermission(role: string, permission: Permission): boolean {
  if (role in SYSTEM_ROLE_PERMISSIONS) {
    const systemGranted = SYSTEM_ROLE_PERMISSIONS[role as SystemRole];
    if (systemGranted !== undefined && systemGranted.includes(permission)) {
      return true;
    }
  }
  const grantedPermissions: readonly Permission[] | undefined = ROLE_PERMISSIONS[role as UserRole];
  return grantedPermissions !== undefined && grantedPermissions.includes(permission);
}

// ─── Permission catalogue as data (S1-1, S1-2, S5-2) ─────────────────────────
//
// The rows the RBAC migration seeds into `permissions`. `code` must equal the
// string a route passes to `requirePermission`, so this map is the single
// spelling authority for the catalogue.
export const PERMISSION_DESCRIPTIONS = {
  // User management
  "users:create": "Create a user account",
  "users:read": "List and read user accounts",
  "users:update": "Change a user's details or roles",
  "users:deactivate": "Deactivate a user account (never delete it)",
  // Subscriber management
  "subscribers:create": "Register a new subscriber",
  "subscribers:read": "Search and read subscriber records",
  "subscribers:update": "Change subscriber details",
  "subscribers:suspend": "Suspend a service account",
  "subscribers:reconnect": "Reconnect a suspended service account",
  // Plans and packages
  "plans:create": "Create a subscription plan",
  "plans:read": "List and read subscription plans",
  "plans:update": "Change a subscription plan (a price change is a new plan)",
  // Billing
  "invoices:generate": "Run monthly billing and generate invoices",
  "invoices:read": "List and read invoices",
  "invoices:void": "Void an invoice (never delete it)",
  // Payments
  "payments:post": "Record a payment",
  "payments:read": "List and read payments and receipts",
  "payments:reverse": "Reverse a posted payment",
  "receipts:print": "Print an official receipt",
  "payments:verify_gcash": "Verify a pending GCash payment so it posts",
  "payments:reject_gcash": "Reject a pending GCash payment with a reason",
  "payments:allocate_manually": "Direct a payment at chosen invoices (manual allocation)",
  // Ledger and statement of account
  "ledger:read": "Read the subscriber ledger and statement of account",
  "ledger:verify": "Run the ledger integrity check",
  "ledger:adjust": "Post a manual debit or credit entry",
  // Collector operations
  "collector_batches:create": "Create a collector batch and assign service accounts",
  "collector_batches:read": "List and read collector batches",
  "collector_batches:remit": "Remit a batch's collected cash",
  "collector_batches:reconcile": "Reconcile a submitted batch",
  // Reports
  "reports:view": "View operational reports",
  "reports:management_view": "View management reports (monthly billing, receivables)",
  "reports:export": "Export a report to XLSX or PDF",
  // System
  "system:backup": "Create and restore a database backup (legacy combined permission)",
  "system:settings": "Change system settings",
  "backup:create": "Create and verify a database backup",
  "backup:restore": "Restore the database from a verified backup",
  // Audit trail
  "audit:read": "Read the audit trail",
} as const satisfies Record<Permission, string>;

// ─── Spec-name → repository-spelling equivalence (S5-2) ──────────────────────
//
// The lab specification names some permissions in `domain.verb` form. This
// repository uses `domain:verb`. The equivalent is NOT renamed — every live route
// guard keeps working — and the mapping is documented here and in
// docs/technical/README.md:
//
//   subscriber.view      ≡ subscribers:read
//   billing.generate     ≡ invoices:generate
//   payment.create       ≡ payments:post
//   payment.reverse      ≡ payments:reverse
//   collection.reconcile ≡ collector_batches:reconcile
//   report.export        ≡ reports:export
//   user.manage          ≡ users:create / users:update / users:deactivate
//   backup.restore       ≡ backup:restore (legacy: system:backup)
//   backup.create        ≡ backup:create  (legacy: system:backup)
//
// GCash verification and manual allocation had no equivalent, so they are new
// permissions: payments:verify_gcash, payments:reject_gcash and
// payments:allocate_manually.

// The permission matrix for the SEVEN stored roles (section 3.1), seeded into
// `roles` / `permissions` / `role_permissions` by the RBAC migration.
//
// Relationship to ROLE_PERMISSIONS above:
//   • ROLE_PERMISSIONS is the compiled FALLBACK for the legacy `users.role`
//     enum, kept until the auth middleware resolves permissions from the tables.
//   • SYSTEM_ROLE_PERMISSIONS is a documentation copy of what the migration
//     seeds. The database is the authority.
//
// Every legacy role's permission set is a SUBSET of the stored role it maps onto
// (see LEGACY_ROLE_TO_SYSTEM_ROLE), so migrating users never removes access:
//   admin          → administrator      (both hold the full catalogue)
//   billing_clerk  → cashier            (cashier = union of billing_clerk and cashier)
//   cashier        → cashier            (subset)
//   collector      → collection_supervisor (supervisor ⊇ collector)
//   manager        → read_only_viewer   (identical set)
export const SYSTEM_ROLE_PERMISSIONS: Record<SystemRole, readonly Permission[]> = {
  owner: Object.keys(PERMISSION_DESCRIPTIONS) as readonly Permission[],

  administrator: Object.keys(PERMISSION_DESCRIPTIONS) as readonly Permission[],

  // Section 3.1 Cashier: counter payments, GCash verification, OR printing,
  // daily collection report, view subscriber/invoice records, reconcile batches.
  // Explicitly cannot generate billing, cannot reverse payments without authorization,
  // cannot access audit logs.
  cashier: [
    "subscribers:read",
    "invoices:read",
    "payments:post",
    "payments:read",
    "receipts:print",
    "payments:verify_gcash",
    "payments:reject_gcash",
    "payments:allocate_manually",
    "ledger:read",
    "collector_batches:read",
    "collector_batches:reconcile",
    "reports:view",
  ],

  // Superset of the legacy `collector` set: the supervisor can also assemble a
  // batch and reconcile it, and can suspend/reconnect the accounts they cover.
  collection_supervisor: [
    "subscribers:read",
    "subscribers:update",
    "subscribers:suspend",
    "subscribers:reconnect",
    "invoices:read",
    "payments:read",
    "collector_batches:create",
    "collector_batches:read",
    "collector_batches:remit",
    "collector_batches:reconcile",
    "reports:view",
  ],

  accounting_auditor: [
    "subscribers:read",
    "plans:read",
    "invoices:read",
    "payments:read",
    "ledger:read",
    "ledger:verify",
    "collector_batches:read",
    "reports:view",
    "reports:management_view",
    "reports:export",
    "audit:read",
  ],

  technician: [
    "subscribers:read",
    "subscribers:suspend",
    "subscribers:reconnect",
  ],

  // Identical to the legacy `manager` set.
  read_only_viewer: [
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
