-- WP1 §5b — one subscriber, many addresses (S1-9).
--
-- The subscriber's four address columns become rows in subscriber_addresses, and
-- every existing service account is pointed at its subscriber's primary address
-- as its installation address. The original columns are NOT dropped: they are the
-- denormalized record of what was entered when the account was opened, and the
-- printed documents still read them.
--
-- Both data statements are guarded (NOT EXISTS / IS NULL), so this migration
-- applies unchanged to a fresh database and to one that already has addresses.

CREATE TABLE "subscriber_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"label" varchar(50) DEFAULT 'Primary' NOT NULL,
	"address_line" text NOT NULL,
	"barangay" varchar(100),
	"municipality" varchar(100),
	"province" varchar(100),
	"area_id" uuid,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "service_accounts" ADD COLUMN "installation_address_id" uuid;--> statement-breakpoint
ALTER TABLE "subscriber_addresses" ADD CONSTRAINT "subscriber_addresses_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriber_addresses" ADD CONSTRAINT "subscriber_addresses_area_id_collection_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."collection_areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriber_addresses" ADD CONSTRAINT "subscriber_addresses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriber_addresses" ADD CONSTRAINT "subscriber_addresses_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subscriber_addresses_subscriber_idx" ON "subscriber_addresses" USING btree ("subscriber_id");--> statement-breakpoint
CREATE INDEX "subscriber_addresses_area_idx" ON "subscriber_addresses" USING btree ("area_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriber_addresses_primary_uq" ON "subscriber_addresses" USING btree ("subscriber_id") WHERE "subscriber_addresses"."is_primary";--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_installation_address_id_subscriber_addresses_id_fk" FOREIGN KEY ("installation_address_id") REFERENCES "public"."subscriber_addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Copy each subscriber's existing address into the new table as the primary one.
-- Guarded by NOT EXISTS so re-applying never duplicates an address.
INSERT INTO "subscriber_addresses" (
	"subscriber_id",
	"label",
	"address_line",
	"barangay",
	"municipality",
	"province",
	"is_primary",
	"created_at",
	"updated_at",
	"created_by"
)
SELECT
	subscriber."id",
	'Primary',
	subscriber."service_address",
	subscriber."service_barangay",
	subscriber."service_municipality",
	subscriber."service_province",
	true,
	subscriber."created_at",
	subscriber."updated_at",
	subscriber."created_by"
FROM "subscribers" AS subscriber
WHERE NOT EXISTS (
	SELECT 1
	FROM "subscriber_addresses" AS address
	WHERE address."subscriber_id" = subscriber."id"
		AND address."is_primary"
);
--> statement-breakpoint

-- Point every existing service account at its subscriber's primary address, so
-- the per-account installation address is populated from day one. Only rows that
-- have no installation address yet are touched.
UPDATE "service_accounts" AS account
SET "installation_address_id" = address."id"
FROM "subscriber_addresses" AS address
WHERE address."subscriber_id" = account."subscriber_id"
	AND address."is_primary"
	AND account."installation_address_id" IS NULL;
