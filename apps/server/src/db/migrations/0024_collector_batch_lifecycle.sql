-- WP4 §S4-1/S4-2 — the six-state collector batch lifecycle, a correctable remittance
-- and the final close columns.
--
-- The status enum had four values. `submitted` fused "the collector finished" with
-- "the cash was handed in", and `reconciled` fused "the office checked the money"
-- against the ledger with "the batch is finally closed", so a shortage could be
-- reconciled and closed in the same call and the lifecycle the activity requires
-- could not be expressed.
--
-- The enum now holds the full lifecycle plus the cancellation exit:
--   open → in_progress → submitted → remitted → reconciled → closed, or cancelled
--
-- `in_progress` lets a run be started before it is declared finished; `remitted`
-- records the cash hand-in as its own step; `closed` is the supervisor's final
-- sign-off, a separate action from reconciliation.
--
-- The type is RECREATED rather than grown with ADD VALUE. drizzle-kit applies every
-- pending migration in one transaction, and PostgreSQL refuses to use an enum label
-- in the transaction that adds it, so the data mapping could not follow an ADD VALUE.
-- The column is rewritten in place with a CASE that maps the old `submitted` to
-- `remitted`; `open`, `reconciled` and `cancelled` keep their meaning exactly, and no
-- monetary column is touched.
--
-- Evidence for the mapping. The old submit path (the ONLY writer of status
-- `submitted`) set `status` and `actual_remittance_centavos` in the SAME UPDATE from a
-- required non-negative integer, so a historical `submitted` row always carries the
-- declared hand-in — that is exactly what `remitted` means now. The CASE still guards
-- `actual_remittance_centavos IS NOT NULL`: a row that somehow has no declared amount
-- (impossible through the application, e.g. a hand-inserted row) stays `submitted`,
-- which now reads as "finished, nothing remitted yet", rather than claiming a hand-in
-- that never happened.
--
-- `collector_remittances.amount_centavos` moves from `> 0` to `<> 0` so a correction
-- is an offsetting row beside the one it fixes, never an edit and never a delete.
-- The split check (amount = cash + gcash) is unchanged.
--
-- `closed_at`/`closed_by` make the close step answerable to an auditor, exactly as
-- `reconciled_at`/`reconciled_by` already do for reconciliation.

ALTER TABLE "collector_batches" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TYPE "public"."collector_batch_status" RENAME TO "collector_batch_status_old";--> statement-breakpoint
CREATE TYPE "public"."collector_batch_status" AS ENUM('open', 'in_progress', 'submitted', 'remitted', 'reconciled', 'closed', 'cancelled');--> statement-breakpoint
ALTER TABLE "collector_batches" ALTER COLUMN "status" TYPE "public"."collector_batch_status" USING (CASE WHEN "status"::text = 'submitted' AND "actual_remittance_centavos" IS NOT NULL THEN 'remitted' ELSE "status"::text END)::"public"."collector_batch_status";--> statement-breakpoint
ALTER TABLE "collector_batches" ALTER COLUMN "status" SET DEFAULT 'open';--> statement-breakpoint
DROP TYPE "public"."collector_batch_status_old";--> statement-breakpoint
ALTER TABLE "collector_remittances" DROP CONSTRAINT "collector_remittances_amount_check";--> statement-breakpoint
ALTER TABLE "collector_batches" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "collector_batches" ADD COLUMN "closed_by" uuid;--> statement-breakpoint
ALTER TABLE "collector_batches" ADD CONSTRAINT "collector_batches_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_remittances" ADD CONSTRAINT "collector_remittances_amount_check" CHECK ("collector_remittances"."amount_centavos" <> 0);
