-- WP1 §6c — backup history (S1-8, S5-3).
--
-- One row per backup the application creates, with its size, checksum and the
-- timestamps of a successful verification and a rehearsed restore. This is what
-- makes "which archive is safe to restore?" answerable from inside the system.

CREATE TABLE "backup_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"filename" varchar(255) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"checksum" varchar(128) NOT NULL,
	"checksum_algorithm" varchar(20) DEFAULT 'sha256' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"restore_tested_at" timestamp with time zone,
	"notes" text
);
--> statement-breakpoint
ALTER TABLE "backup_history" ADD CONSTRAINT "backup_history_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backup_history_created_at_idx" ON "backup_history" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "backup_history_filename_idx" ON "backup_history" USING btree ("filename");