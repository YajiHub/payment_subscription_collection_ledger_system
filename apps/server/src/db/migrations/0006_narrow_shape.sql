CREATE TYPE "public"."collected_method" AS ENUM('cash', 'gcash');--> statement-breakpoint
CREATE TYPE "public"."collection_result" AS ENUM('collected', 'partial', 'no_response', 'refused', 'promise');--> statement-breakpoint
CREATE TYPE "public"."collector_batch_status" AS ENUM('open', 'submitted', 'reconciled', 'cancelled');--> statement-breakpoint
CREATE TABLE "batch_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"service_account_id" uuid NOT NULL,
	"outstanding_balance_centavos" integer DEFAULT 0 NOT NULL,
	"collection_result" "collection_result",
	"collected_amount_centavos" integer,
	"collected_method" "collected_method",
	"payment_id" uuid,
	"collector_notes" text,
	"updated_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text
);
--> statement-breakpoint
CREATE TABLE "collector_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_number" varchar(30) NOT NULL,
	"collector_id" uuid NOT NULL,
	"status" "collector_batch_status" DEFAULT 'open' NOT NULL,
	"collection_date" date NOT NULL,
	"expected_remittance_centavos" integer DEFAULT 0 NOT NULL,
	"actual_remittance_centavos" integer,
	"variance_centavos" integer,
	"variance_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"reconciled_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"reconciled_by" uuid,
	"cancelled_by" uuid,
	"cancel_reason" text,
	CONSTRAINT "collector_batches_batch_number_unique" UNIQUE("batch_number")
);
--> statement-breakpoint
ALTER TABLE "batch_assignments" ADD CONSTRAINT "batch_assignments_batch_id_collector_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."collector_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_assignments" ADD CONSTRAINT "batch_assignments_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_assignments" ADD CONSTRAINT "batch_assignments_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_assignments" ADD CONSTRAINT "batch_assignments_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_batches" ADD CONSTRAINT "collector_batches_collector_id_users_id_fk" FOREIGN KEY ("collector_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_batches" ADD CONSTRAINT "collector_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_batches" ADD CONSTRAINT "collector_batches_reconciled_by_users_id_fk" FOREIGN KEY ("reconciled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_batches" ADD CONSTRAINT "collector_batches_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "batch_assignments_batch_idx" ON "batch_assignments" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "batch_assignments_service_account_idx" ON "batch_assignments" USING btree ("service_account_id");--> statement-breakpoint
CREATE INDEX "collector_batches_collector_idx" ON "collector_batches" USING btree ("collector_id");--> statement-breakpoint
CREATE INDEX "collector_batches_status_idx" ON "collector_batches" USING btree ("status");--> statement-breakpoint
CREATE INDEX "collector_batches_collection_date_idx" ON "collector_batches" USING btree ("collection_date");