-- Phase 6 — ledger integrity.
--
-- Adds `sequence_number` to ledger_entries: the position of each entry in its
-- account's ledger chain, starting at 1. It turns "the running balance is an
-- unbroken chain" into something the database can enforce (unique index below)
-- and the app can verify (no gaps, no duplicates).
--
-- The backfill numbers any pre-existing entries per service account, oldest
-- first, so an already-populated ledger stays valid after this migration.
ALTER TABLE "ledger_entries" ADD COLUMN "sequence_number" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "ledger_entries" AS entry
SET "sequence_number" = ordered."row_number"
FROM (
  SELECT
    "id",
    row_number() OVER (PARTITION BY "service_account_id" ORDER BY "entry_date", "id") AS "row_number"
  FROM "ledger_entries"
) AS ordered
WHERE entry."id" = ordered."id";--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_account_sequence_uq" ON "ledger_entries" USING btree ("service_account_id","sequence_number");--> statement-breakpoint
CREATE INDEX "ledger_entries_service_account_idx" ON "ledger_entries" USING btree ("service_account_id");
