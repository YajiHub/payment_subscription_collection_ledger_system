-- WP1 §4 — trigram search indexes (S1-10, S12-4).
--
-- The subscriber list searches name, phone and account number with ILIKE '%…%'
-- (subscribers.service.ts), which no btree index can serve, and the receipt,
-- invoice and GCash reference lookups are substring searches too. pg_trgm turns
-- those into indexable trigram matches. Invoices' due-date index is a plain
-- btree and lives in 0010 next to the period key.
--
-- CREATE EXTENSION IF NOT EXISTS makes this safe on a fresh database (the
-- extension is not yet installed) and on one where it already is; the indexes
-- are created IF NOT EXISTS for the same reason. pg_trgm is a trusted extension
-- in PostgreSQL 13+, so the database owner can install it without superuser.
CREATE EXTENSION IF NOT EXISTS "pg_trgm";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_invoice_number_trgm_idx" ON "invoices" USING gin ("invoice_number" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gcash_payments_reference_trgm_idx" ON "gcash_payments" USING gin ("gcash_reference_number" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_receipt_number_trgm_idx" ON "payments" USING gin ("receipt_number" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscribers_first_name_trgm_idx" ON "subscribers" USING gin ("first_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscribers_last_name_trgm_idx" ON "subscribers" USING gin ("last_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscribers_middle_name_trgm_idx" ON "subscribers" USING gin ("middle_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscribers_account_number_trgm_idx" ON "subscribers" USING gin ("account_number" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscribers_primary_phone_trgm_idx" ON "subscribers" USING gin ("primary_phone" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscribers_secondary_phone_trgm_idx" ON "subscribers" USING gin ("secondary_phone" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscribers_email_address_trgm_idx" ON "subscribers" USING gin ("email_address" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscribers_service_address_trgm_idx" ON "subscribers" USING gin ("service_address" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscribers_service_barangay_trgm_idx" ON "subscribers" USING gin ("service_barangay" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscribers_service_municipality_trgm_idx" ON "subscribers" USING gin ("service_municipality" gin_trgm_ops);