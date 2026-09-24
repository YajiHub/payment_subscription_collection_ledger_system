CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" varchar(100) NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"entity_id" uuid NOT NULL,
	"previous_state" jsonb,
	"new_state" jsonb,
	"description" text NOT NULL,
	"performed_by" uuid,
	"performed_by_username" varchar(50),
	"client_ip_address" varchar(45),
	"performed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" varchar(100) PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"description" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_performed_by_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_logs_performed_by_idx" ON "audit_logs" USING btree ("performed_by");--> statement-breakpoint
CREATE INDEX "audit_logs_performed_at_idx" ON "audit_logs" USING btree ("performed_at");--> statement-breakpoint

-- Phase 9 §2: the audit trail is append-only. The service layer only ever
-- inserts, but a database trigger is the backstop that makes an UPDATE or a
-- DELETE fail even when it bypasses the application entirely.
CREATE OR REPLACE FUNCTION bcis_prevent_audit_log_mutation() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'audit_logs is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER audit_logs_append_only
	BEFORE UPDATE OR DELETE ON "audit_logs"
	FOR EACH ROW EXECUTE FUNCTION bcis_prevent_audit_log_mutation();--> statement-breakpoint

-- Phase 9 §8: seed the default business rules into a fresh database. Idempotent,
-- so re-running the migration never clobbers a value an administrator has changed.
INSERT INTO "system_settings" ("key", "value", "description") VALUES
	('late_fee_centavos', '5000', 'Late fee charged to an overdue invoice, in centavos (5000 = PHP 50.00)'),
	('invoice_due_day_of_month', '15', 'Day of the following month on which a monthly invoice falls due'),
	('suspension_after_days', '30', 'Days past due before an account may be auto-suspended'),
	('company_name', 'My ISP', 'Company name printed on receipts and reports'),
	('company_address', '...', 'Company address printed on receipts and reports'),
	('company_phone', '...', 'Company phone number printed on receipts'),
	('receipt_footer_text', 'Thank you for your payment!', 'Message printed at the bottom of an Official Receipt')
ON CONFLICT ("key") DO NOTHING;