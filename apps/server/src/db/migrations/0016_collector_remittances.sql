-- WP1 §6a — a collector remittance as its own record (S1-6, S4-2).
--
-- `collector_batches.actual_remittance_centavos` allows exactly one hand-in per
-- batch. This table allows many: a collector may pay in instalments, and a
-- corrected remittance is a new row beside the old one, never an edit.
--
-- The batch-level total column is NOT dropped, so the existing remit and
-- reconcile logic keeps working until WP4 writes remittance rows.

CREATE TABLE "collector_remittances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"amount_centavos" integer NOT NULL,
	"cash_amount_centavos" integer DEFAULT 0 NOT NULL,
	"gcash_amount_centavos" integer DEFAULT 0 NOT NULL,
	"remitted_by" uuid NOT NULL,
	"remitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	CONSTRAINT "collector_remittances_split_check" CHECK ("collector_remittances"."amount_centavos" = "collector_remittances"."cash_amount_centavos" + "collector_remittances"."gcash_amount_centavos"),
	CONSTRAINT "collector_remittances_amount_check" CHECK ("collector_remittances"."amount_centavos" > 0)
);
--> statement-breakpoint
ALTER TABLE "collector_remittances" ADD CONSTRAINT "collector_remittances_batch_id_collector_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."collector_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_remittances" ADD CONSTRAINT "collector_remittances_remitted_by_users_id_fk" FOREIGN KEY ("remitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collector_remittances_batch_idx" ON "collector_remittances" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "collector_remittances_remitted_by_idx" ON "collector_remittances" USING btree ("remitted_by");