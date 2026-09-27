-- WP3 §S3-1/S3-2/S3-3 (S12-7) — five postable payment methods and the GCash
-- verification lifecycle.
--
-- Payment methods: the enum gains `other`, so the stored set is the five values
-- section 3.6 requires and matches PAYMENT_METHODS in packages/shared. `check`
-- keeps its stored spelling and is labelled "Cheque" in the interface. The shared
-- POSTABLE_PAYMENT_METHODS restriction that blocked bank transfer and cheque is
-- gone, so this is the last piece that stopped them from being recorded.
--
-- Payment status: `pending_verification` is a GCash payment whose reference a
-- verifier has not confirmed yet. It holds no allocations and no ledger entries,
-- so it cannot move a balance, and every report that counts only `posted` payments
-- excludes it without further change. `rejected` is a payment a verifier refused
-- with a mandatory reason; the invoice it was aimed at stays untouched.
--
-- GCash verification detail: the three columns below record who refused a claim
-- and why, beside the pre-existing `verified_at`/`verified_by` that the verify
-- step now actually writes (they existed since 0004 and were never written).
--
-- Purely additive: no column is dropped, no row is rewritten, and no enum label is
-- removed, so it applies unchanged to a fresh database and to a populated one.
ALTER TYPE "public"."payment_method" ADD VALUE 'other';--> statement-breakpoint
ALTER TYPE "public"."payment_status" ADD VALUE 'pending_verification' BEFORE 'posted';--> statement-breakpoint
ALTER TYPE "public"."payment_status" ADD VALUE 'rejected';--> statement-breakpoint
ALTER TABLE "gcash_payments" ADD COLUMN "rejected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gcash_payments" ADD COLUMN "rejected_by" uuid;--> statement-breakpoint
ALTER TABLE "gcash_payments" ADD COLUMN "rejection_reason" text;--> statement-breakpoint
ALTER TABLE "gcash_payments" ADD CONSTRAINT "gcash_payments_rejected_by_users_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
