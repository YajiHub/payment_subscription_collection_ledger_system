CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'posted', 'partially_paid', 'paid', 'void', 'overdue');--> statement-breakpoint
CREATE TYPE "public"."invoice_type" AS ENUM('monthly_subscription', 'reconnection_fee', 'adjustment', 'late_fee');--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_type" AS ENUM('invoice_posted', 'late_fee', 'manual_debit', 'payment_reversal', 'payment_received', 'invoice_void', 'advance_credit', 'advance_credit_applied', 'manual_credit', 'write_off');--> statement-breakpoint
CREATE TABLE "billing_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"billing_period_year" integer NOT NULL,
	"billing_period_month" integer NOT NULL,
	"total_service_accounts_processed" integer NOT NULL,
	"total_invoices_generated" integer NOT NULL,
	"total_invoices_skipped" integer NOT NULL,
	"total_amount_billed_centavos" integer NOT NULL,
	"status" varchar(20) NOT NULL,
	"error_details" text,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ran_by" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"description" varchar(200) NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_amount_centavos" integer NOT NULL,
	"total_amount_centavos" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_number" varchar(30) NOT NULL,
	"service_account_id" uuid NOT NULL,
	"invoice_type" "invoice_type" NOT NULL,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"billing_period_year" integer,
	"billing_period_month" integer,
	"invoice_date" date NOT NULL,
	"due_date" date NOT NULL,
	"subtotal_centavos" integer NOT NULL,
	"late_fees_centavos" integer DEFAULT 0 NOT NULL,
	"total_amount_centavos" integer NOT NULL,
	"paid_amount_centavos" integer DEFAULT 0 NOT NULL,
	"remaining_balance_centavos" integer NOT NULL,
	"voided_by_transaction_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"posted_by" uuid,
	"voided_by" uuid,
	CONSTRAINT "invoices_invoice_number_unique" UNIQUE("invoice_number")
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_account_id" uuid NOT NULL,
	"entry_type" "ledger_entry_type" NOT NULL,
	"amount_centavos" integer NOT NULL,
	"running_balance_centavos" integer NOT NULL,
	"description" text NOT NULL,
	"invoice_id" uuid,
	"payment_id" uuid,
	"entry_date" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_runs" ADD CONSTRAINT "billing_runs_ran_by_users_id_fk" FOREIGN KEY ("ran_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoices_service_account_period_idx" ON "invoices" USING btree ("service_account_id","billing_period_year","billing_period_month");