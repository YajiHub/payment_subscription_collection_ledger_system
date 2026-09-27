-- WP1 §2 — the invoice period key as a database invariant (S1-3, S12-2) and the
-- missing due-date index (S1-10).
--
-- A service account may hold at most one non-void invoice per billing period. The
-- guard used to live only in the billing service (a row lock plus a status-aware
-- re-check), so nothing stopped a raw duplicate insert. The partial unique index
-- closes AT-11 at the database level while still letting a voided invoice be
-- re-billed for the same period.
--
-- `invoices_service_account_period_idx` from 0003 is left in place: it is not
-- edited (applied migrations are immutable) and it still serves the service's
-- status-aware lookup before insert.

CREATE UNIQUE INDEX "invoices_service_account_period_uq" ON "invoices" USING btree ("service_account_id","billing_period_year","billing_period_month") WHERE "invoices"."status" <> 'void';--> statement-breakpoint
CREATE INDEX "invoices_due_date_idx" ON "invoices" USING btree ("due_date");