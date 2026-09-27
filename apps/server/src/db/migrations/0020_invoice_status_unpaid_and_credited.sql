-- WP2 §S2-1 — complete the invoice state set required by section 3.4.
--
-- The stored status `posted` is renamed to `unpaid` so the enum matches the
-- required state set exactly, and `credited` is added for an invoice that an
-- advance credit (not a payment) fully settles.
--
-- RENAME VALUE rewrites every existing row in place: an invoice that was `posted`
-- becomes `unpaid` and keeps its id, number, totals, ledger entries and
-- allocations. No row is inserted, deleted or re-created, so no invoice can be
-- lost. The rename touches the enum label only, never the data.
--
-- `posted` is still accepted on the API as an input alias for exactly one release
-- (see LEGACY_INVOICE_STATUS_ALIASES in packages/shared), but it is never stored.
ALTER TYPE "public"."invoice_status" RENAME VALUE 'posted' TO 'unpaid';--> statement-breakpoint
ALTER TYPE "public"."invoice_status" ADD VALUE IF NOT EXISTS 'credited';
