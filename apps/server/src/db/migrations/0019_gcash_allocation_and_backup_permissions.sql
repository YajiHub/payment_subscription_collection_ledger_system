-- WP5 §1 — the permissions S5-2 adds on top of the 32 seeded by 0009 (S5-2, S12-9).
--
-- 0009 seeded the catalogue as it stood. This migration adds the GCash verification
-- (verify and reject), manual-allocation and split backup permissions so they can
-- actually be granted from `role_permissions`; without a row here, the
-- database-backed resolver (S12-9) would deny the routes that guard on them.
--
-- `system:backup` stays as the legacy combined permission and is untouched; the two
-- new backup permissions split it so producing an archive and overwriting the
-- database are separately grantable.
--
-- Least privilege: only owner and administrator hold the backup permissions; the
-- operational payment roles (owner, administrator, cashier) hold the three payment
-- permissions. A Technician and a Read-only Viewer gain nothing.
--
-- Guarded with ON CONFLICT DO NOTHING, so it applies unchanged to a fresh database
-- and to a populated one.

INSERT INTO "permissions" ("code", "description") VALUES
	('payments:verify_gcash', 'Verify a pending GCash payment so it posts'),
	('payments:reject_gcash', 'Reject a pending GCash payment with a reason'),
	('payments:allocate_manually', 'Direct a payment at chosen invoices (manual allocation)'),
	('backup:create', 'Create and verify a database backup'),
	('backup:restore', 'Restore the database from a verified backup')
ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT role_row."id", permission_row."id"
FROM (VALUES
	('owner', 'payments:verify_gcash'),
	('owner', 'payments:reject_gcash'),
	('owner', 'payments:allocate_manually'),
	('owner', 'backup:create'),
	('owner', 'backup:restore'),
	('administrator', 'payments:verify_gcash'),
	('administrator', 'payments:reject_gcash'),
	('administrator', 'payments:allocate_manually'),
	('administrator', 'backup:create'),
	('administrator', 'backup:restore'),
	('cashier', 'payments:verify_gcash'),
	('cashier', 'payments:reject_gcash'),
	('cashier', 'payments:allocate_manually')
) AS granted ("role_code", "permission_code")
JOIN "roles" AS role_row ON role_row."code" = granted."role_code"
JOIN "permissions" AS permission_row ON permission_row."code" = granted."permission_code"
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
