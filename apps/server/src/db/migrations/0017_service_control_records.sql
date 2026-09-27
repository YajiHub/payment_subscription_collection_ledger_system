-- WP1 §6b — suspension and reconnection paperwork (S1-7, section 3.10).
--
-- `service_status_history` records the status change; these two tables record the
-- operating detail the office needs: who approved it, which technician performed
-- it, when it was requested, when it completed, and any fee charged. The history
-- table keeps being written exactly as before.

CREATE TABLE "reconnection_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_account_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"effective_date" date NOT NULL,
	"approved_by" uuid NOT NULL,
	"fee_centavos" integer DEFAULT 0 NOT NULL,
	"technician_id" uuid,
	"request_date" date,
	"completion_date" date,
	"invoice_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "reconnection_records_fee_check" CHECK ("reconnection_records"."fee_centavos" >= 0)
);
--> statement-breakpoint
CREATE TABLE "suspension_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_account_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"effective_date" date NOT NULL,
	"approved_by" uuid NOT NULL,
	"fee_centavos" integer DEFAULT 0 NOT NULL,
	"technician_id" uuid,
	"request_date" date,
	"completion_date" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "suspension_records_fee_check" CHECK ("suspension_records"."fee_centavos" >= 0)
);
--> statement-breakpoint
ALTER TABLE "reconnection_records" ADD CONSTRAINT "reconnection_records_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconnection_records" ADD CONSTRAINT "reconnection_records_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconnection_records" ADD CONSTRAINT "reconnection_records_technician_id_users_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconnection_records" ADD CONSTRAINT "reconnection_records_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconnection_records" ADD CONSTRAINT "reconnection_records_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suspension_records" ADD CONSTRAINT "suspension_records_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suspension_records" ADD CONSTRAINT "suspension_records_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suspension_records" ADD CONSTRAINT "suspension_records_technician_id_users_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suspension_records" ADD CONSTRAINT "suspension_records_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reconnection_records_service_account_idx" ON "reconnection_records" USING btree ("service_account_id");--> statement-breakpoint
CREATE INDEX "reconnection_records_effective_date_idx" ON "reconnection_records" USING btree ("effective_date");--> statement-breakpoint
CREATE INDEX "reconnection_records_technician_idx" ON "reconnection_records" USING btree ("technician_id");--> statement-breakpoint
CREATE INDEX "suspension_records_service_account_idx" ON "suspension_records" USING btree ("service_account_id");--> statement-breakpoint
CREATE INDEX "suspension_records_effective_date_idx" ON "suspension_records" USING btree ("effective_date");--> statement-breakpoint
CREATE INDEX "suspension_records_technician_idx" ON "suspension_records" USING btree ("technician_id");