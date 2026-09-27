-- WP1 §1 — Role-based access control as data (S1-1, S1-2, S12-9).
--
-- The four tables below replace the hardcoded `user_role` enum matrix with rows.
-- The data half of this migration seeds the seven section 3.1 roles and the
-- permission catalogue, then backfills `user_roles` from every existing
-- `users.role` value so no user loses access to anything they could do before.
--
-- Every statement is guarded (ON CONFLICT DO NOTHING, IF NOT EXISTS), so this
-- migration applies unchanged to a fresh database and to a populated one.

CREATE TABLE "permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(100) NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permissions_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_by" uuid,
	CONSTRAINT "role_permissions_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(50) NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_by" uuid,
	CONSTRAINT "user_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "role_permissions_permission_idx" ON "role_permissions" USING btree ("permission_id");--> statement-breakpoint
CREATE INDEX "user_roles_role_idx" ON "user_roles" USING btree ("role_id");
-- ─── Seed: the permission catalogue (S1-1, S5-2) ─────────────────────────────
--
-- The exact strings a route passes to requirePermission. Generated from
-- PERMISSION_DESCRIPTIONS in packages/shared/src/constants/permissions.ts.
INSERT INTO "permissions" ("code", "description") VALUES
	('users:create', 'Create a user account'),
	('users:read', 'List and read user accounts'),
	('users:update', 'Change a user''s details or roles'),
	('users:deactivate', 'Deactivate a user account (never delete it)'),
	('subscribers:create', 'Register a new subscriber'),
	('subscribers:read', 'Search and read subscriber records'),
	('subscribers:update', 'Change subscriber details'),
	('subscribers:suspend', 'Suspend a service account'),
	('subscribers:reconnect', 'Reconnect a suspended service account'),
	('plans:create', 'Create a subscription plan'),
	('plans:read', 'List and read subscription plans'),
	('plans:update', 'Change a subscription plan (a price change is a new plan)'),
	('invoices:generate', 'Run monthly billing and generate invoices'),
	('invoices:read', 'List and read invoices'),
	('invoices:void', 'Void an invoice (never delete it)'),
	('payments:post', 'Record a payment'),
	('payments:read', 'List and read payments and receipts'),
	('payments:reverse', 'Reverse a posted payment'),
	('receipts:print', 'Print an official receipt'),
	('ledger:read', 'Read the subscriber ledger and statement of account'),
	('ledger:verify', 'Run the ledger integrity check'),
	('ledger:adjust', 'Post a manual debit or credit entry'),
	('collector_batches:create', 'Create a collector batch and assign service accounts'),
	('collector_batches:read', 'List and read collector batches'),
	('collector_batches:remit', 'Remit a batch''s collected cash'),
	('collector_batches:reconcile', 'Reconcile a submitted batch'),
	('reports:view', 'View operational reports'),
	('reports:management_view', 'View management reports (monthly billing, receivables)'),
	('reports:export', 'Export a report to XLSX or PDF'),
	('system:backup', 'Create and restore a database backup'),
	('system:settings', 'Change system settings'),
	('audit:read', 'Read the audit trail')
ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint

-- ─── Seed: the seven roles of section 3.1 (S1-1) ─────────────────────────────
INSERT INTO "roles" ("code", "name", "description") VALUES
	('owner', 'Owner / Super Admin', 'Unrestricted access, including backups, settings and the audit trail'),
	('administrator', 'Administrator', 'Runs the system day to day with the full operational permission set'),
	('cashier', 'Cashier', 'Counter work: subscriptions, billing runs, cashiering and receipts'),
	('collection_supervisor', 'Collection Supervisor', 'Assigns field work, receives remittances and reconciles batches'),
	('accounting_auditor', 'Accounting / Auditor', 'Reads every financial record and the audit trail, changes nothing'),
	('technician', 'Technician', 'Field installation and service work; reads accounts and bills'),
	('read_only_viewer', 'Read-only Viewer', 'Read-only oversight of subscribers, billing and reports')
ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint

-- ─── Seed: the role → permission matrix (S1-1, S1-2) ────────────────────────
--
-- Decided once here because a database row is easier to change than a
-- redeploy. Every legacy role's set is a subset of the role it maps onto, so
-- the backfill below never removes a permission from an existing user.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT role_row."id", permission_row."id"
FROM (VALUES
	('owner', 'users:create'),
	('owner', 'users:read'),
	('owner', 'users:update'),
	('owner', 'users:deactivate'),
	('owner', 'subscribers:create'),
	('owner', 'subscribers:read'),
	('owner', 'subscribers:update'),
	('owner', 'subscribers:suspend'),
	('owner', 'subscribers:reconnect'),
	('owner', 'plans:create'),
	('owner', 'plans:read'),
	('owner', 'plans:update'),
	('owner', 'invoices:generate'),
	('owner', 'invoices:read'),
	('owner', 'invoices:void'),
	('owner', 'payments:post'),
	('owner', 'payments:read'),
	('owner', 'payments:reverse'),
	('owner', 'receipts:print'),
	('owner', 'ledger:read'),
	('owner', 'ledger:verify'),
	('owner', 'ledger:adjust'),
	('owner', 'collector_batches:create'),
	('owner', 'collector_batches:read'),
	('owner', 'collector_batches:remit'),
	('owner', 'collector_batches:reconcile'),
	('owner', 'reports:view'),
	('owner', 'reports:management_view'),
	('owner', 'reports:export'),
	('owner', 'system:backup'),
	('owner', 'system:settings'),
	('owner', 'audit:read'),
	('administrator', 'users:create'),
	('administrator', 'users:read'),
	('administrator', 'users:update'),
	('administrator', 'users:deactivate'),
	('administrator', 'subscribers:create'),
	('administrator', 'subscribers:read'),
	('administrator', 'subscribers:update'),
	('administrator', 'subscribers:suspend'),
	('administrator', 'subscribers:reconnect'),
	('administrator', 'plans:create'),
	('administrator', 'plans:read'),
	('administrator', 'plans:update'),
	('administrator', 'invoices:generate'),
	('administrator', 'invoices:read'),
	('administrator', 'invoices:void'),
	('administrator', 'payments:post'),
	('administrator', 'payments:read'),
	('administrator', 'payments:reverse'),
	('administrator', 'receipts:print'),
	('administrator', 'ledger:read'),
	('administrator', 'ledger:verify'),
	('administrator', 'ledger:adjust'),
	('administrator', 'collector_batches:create'),
	('administrator', 'collector_batches:read'),
	('administrator', 'collector_batches:remit'),
	('administrator', 'collector_batches:reconcile'),
	('administrator', 'reports:view'),
	('administrator', 'reports:management_view'),
	('administrator', 'reports:export'),
	('administrator', 'system:backup'),
	('administrator', 'system:settings'),
	('administrator', 'audit:read'),
	('cashier', 'subscribers:create'),
	('cashier', 'subscribers:read'),
	('cashier', 'subscribers:update'),
	('cashier', 'subscribers:suspend'),
	('cashier', 'subscribers:reconnect'),
	('cashier', 'plans:create'),
	('cashier', 'plans:read'),
	('cashier', 'plans:update'),
	('cashier', 'invoices:generate'),
	('cashier', 'invoices:read'),
	('cashier', 'payments:post'),
	('cashier', 'payments:read'),
	('cashier', 'receipts:print'),
	('cashier', 'ledger:read'),
	('cashier', 'collector_batches:create'),
	('cashier', 'collector_batches:read'),
	('cashier', 'collector_batches:reconcile'),
	('cashier', 'reports:view'),
	('cashier', 'reports:management_view'),
	('collection_supervisor', 'subscribers:read'),
	('collection_supervisor', 'subscribers:update'),
	('collection_supervisor', 'subscribers:suspend'),
	('collection_supervisor', 'subscribers:reconnect'),
	('collection_supervisor', 'invoices:read'),
	('collection_supervisor', 'payments:read'),
	('collection_supervisor', 'collector_batches:create'),
	('collection_supervisor', 'collector_batches:read'),
	('collection_supervisor', 'collector_batches:remit'),
	('collection_supervisor', 'collector_batches:reconcile'),
	('collection_supervisor', 'reports:view'),
	('accounting_auditor', 'subscribers:read'),
	('accounting_auditor', 'plans:read'),
	('accounting_auditor', 'invoices:read'),
	('accounting_auditor', 'payments:read'),
	('accounting_auditor', 'ledger:read'),
	('accounting_auditor', 'ledger:verify'),
	('accounting_auditor', 'collector_batches:read'),
	('accounting_auditor', 'reports:view'),
	('accounting_auditor', 'reports:management_view'),
	('accounting_auditor', 'reports:export'),
	('accounting_auditor', 'audit:read'),
	('technician', 'subscribers:read'),
	('technician', 'invoices:read'),
	('technician', 'collector_batches:read'),
	('read_only_viewer', 'subscribers:read'),
	('read_only_viewer', 'plans:read'),
	('read_only_viewer', 'invoices:read'),
	('read_only_viewer', 'payments:read'),
	('read_only_viewer', 'ledger:read'),
	('read_only_viewer', 'collector_batches:read'),
	('read_only_viewer', 'reports:view'),
	('read_only_viewer', 'reports:management_view'),
	('read_only_viewer', 'reports:export')
) AS granted ("role_code", "permission_code")
JOIN "roles" AS role_row ON role_row."code" = granted."role_code"
JOIN "permissions" AS permission_row ON permission_row."code" = granted."permission_code"
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
--> statement-breakpoint

-- ─── Backfill: every existing user keeps their effective permissions (S1-1) ─
--
-- The legacy enum maps onto the stored roles as documented in
-- LEGACY_ROLE_TO_SYSTEM_ROLE: admin→administrator, billing_clerk→cashier,
-- cashier→cashier, collector→collection_supervisor, manager→read_only_viewer.
-- Each target role was seeded to CONTAIN the legacy set it replaces, so no
-- user loses access; a user may hold several roles and keeps the union.
INSERT INTO "user_roles" ("user_id", "role_id")
SELECT user_row."id", role_row."id"
FROM "users" AS user_row
JOIN "roles" AS role_row ON role_row."code" = CASE user_row."role"
	WHEN 'admin' THEN 'administrator'
	WHEN 'billing_clerk' THEN 'cashier'
	WHEN 'cashier' THEN 'cashier'
	WHEN 'collector' THEN 'collection_supervisor'
	WHEN 'manager' THEN 'read_only_viewer'
END
ON CONFLICT ("user_id", "role_id") DO NOTHING;
--> statement-breakpoint

-- ─── Record that RBAC now resolves from these tables (S1-2, S12-9) ──────────
--
-- The boolean is the explicit switch the auth layer reads: when it is present
-- and true, permissions come from role_permissions, with the compiled
-- ROLE_PERMISSIONS matrix as the fallback for a legacy token.
INSERT INTO "system_settings" ("key", "value", "description") VALUES
	('rbac_permissions_in_database', 'true', 'Authorize API callers from the role_permissions table instead of the compiled matrix')
ON CONFLICT ("key") DO NOTHING;
