-- WP1 §5c — per-account billing schedule (S1-11).
--
-- `billing_start_date` decides the first billable period for an account.
-- `billing_day` and `due_day` are nullable OVERRIDES of the global
-- `invoice_due_day_of_month` setting (seed data in 0008_smooth_magus.sql), so an
-- account with both null bills exactly as it does today. The billing engine reads
-- the account value first and falls back to the setting.
--
-- The 1..28 CHECK bounds keep an override usable in every month; a due day of 31
-- cannot be calculated in February and would silently move the due date.
-- All statements are additive, so a fresh database and a populated one apply the
-- same way.

ALTER TABLE "service_accounts" ADD COLUMN "billing_start_date" date;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD COLUMN "billing_day" integer;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD COLUMN "due_day" integer;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_billing_day_check" CHECK ("service_accounts"."billing_day" IS NULL OR ("service_accounts"."billing_day" BETWEEN 1 AND 28));--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_due_day_check" CHECK ("service_accounts"."due_day" IS NULL OR ("service_accounts"."due_day" BETWEEN 1 AND 28));