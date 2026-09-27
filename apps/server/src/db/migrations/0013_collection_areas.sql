-- WP1 §5a — collection areas as entities (S1-5, section 3.8).
--
-- Adds the area table and references it from subscribers and from service
-- accounts. Both columns are nullable, so every existing row keeps working with a
-- null area, and `subscribers.service_barangay` stays as denormalized data.
-- No area is seeded: CRUD is the runtime path (WP4), and inventing an area here
-- would be data the office never entered.

CREATE TABLE "collection_areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(30) NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "collection_areas_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "service_accounts" ADD COLUMN "area_id" uuid;--> statement-breakpoint
ALTER TABLE "subscribers" ADD COLUMN "area_id" uuid;--> statement-breakpoint
ALTER TABLE "collection_areas" ADD CONSTRAINT "collection_areas_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collection_areas_is_active_idx" ON "collection_areas" USING btree ("is_active");--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_area_id_collection_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."collection_areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscribers" ADD CONSTRAINT "subscribers_area_id_collection_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."collection_areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_accounts_area_idx" ON "service_accounts" USING btree ("area_id");--> statement-breakpoint
CREATE INDEX "subscribers_area_idx" ON "subscribers" USING btree ("area_id");