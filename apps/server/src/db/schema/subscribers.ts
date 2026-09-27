// Subscriber (customer) accounts: plans, service accounts, and connection status.
// Phase 3 implements this domain.
//
// A subscriber is a person or household. A subscriber may hold several service
// accounts (one for Internet, one for Cable TV, …). Billing, ledger entries, and
// payments all attach to the service account, never to the subscriber directly.
// That is why a household can have Internet paid up to date while Cable TV is overdue.
//
// Service accounts are NEVER deleted. They move through the statuses below and
// every move is written to service_status_history so the audit trail survives.

import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { collectionAreas } from "./areas";
import { users } from "./users";

// ─── Service Types ────────────────────────────────────────────────────────────
// The types of service this ISP offers. Extensible: adding VoIP or IP cameras
// later means adding a value here.
export const serviceTypeEnum = pgEnum("service_type", ["internet", "cable_tv", "bundle"]);

// ─── Service Account Status ───────────────────────────────────────────────────
// The lifecycle states of a service account.
export const serviceAccountStatusEnum = pgEnum("service_account_status", [
  "active", // Receiving service, billing runs normally
  "suspended", // Service cut; billing paused; balance still due
  "terminated", // Permanently cancelled; no billing; balance may still be owed
  "pending", // New account awaiting activation (installation not yet done)
]);

// ─── Subscription Plans ───────────────────────────────────────────────────────
// Plans define what service is sold and at what price.
// A price change creates a NEW plan record — existing accounts keep their old plan,
// so history is never rewritten and no subscriber is silently re-priced.
export const subscriptionPlans = pgTable("subscription_plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 100 }).notNull(), // e.g. "Fiber 25Mbps", "Cable Basic"
  serviceType: serviceTypeEnum("service_type").notNull(),

  // Speed tier for internet plans (null for cable-only plans)
  speedMbps: integer("speed_mbps"),

  // Channels/package description for cable plans (null for internet-only)
  cablePackageDescription: text("cable_package_description"),

  // Monthly charge stored in CENTAVOS (integers only — never floating point for money).
  // PHP 999.00 = 99900 centavos
  monthlyRateCentavos: integer("monthly_rate_centavos").notNull(),

  // Reconnection fee charged when a suspended account is reactivated
  reconnectionFeeCentavos: integer("reconnection_fee_centavos").notNull().default(0),

  // false = plan retired; it still exists for old accounts but takes no new signups
  isActive: boolean("is_active").notNull().default(true),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
});

// ─── Subscribers ──────────────────────────────────────────────────────────────
// A subscriber is a customer/household. They may have multiple service accounts.
export const subscribers = pgTable(
  "subscribers",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // The subscriber's account number — shown on every document and printed receipt.
    // Format: SUB-YYYYMMDD-XXXXX (auto-generated, human-readable, sortable by date)
    accountNumber: varchar("account_number", { length: 30 }).notNull().unique(),

    firstName: varchar("first_name", { length: 100 }).notNull(),
    lastName: varchar("last_name", { length: 100 }).notNull(),
    middleName: varchar("middle_name", { length: 100 }),

    // Contact information
    primaryPhone: varchar("primary_phone", { length: 20 }).notNull(),
    secondaryPhone: varchar("secondary_phone", { length: 20 }),
    emailAddress: varchar("email_address", { length: 150 }),

    // Service address (where equipment is installed — may differ from billing address)
    serviceAddress: text("service_address").notNull(),
    serviceBarangay: varchar("service_barangay", { length: 100 }).notNull(),
    serviceMunicipality: varchar("service_municipality", { length: 100 }).notNull(),
    serviceProvince: varchar("service_province", { length: 100 }).notNull(),

    // S1-5: the collection area (route) this subscriber belongs to. The
    // `service_barangay` string above stays as denormalized data — it is what was
    // recorded when the account was opened and it is printed on documents.
    areaId: uuid("area_id").references(() => collectionAreas.id),

    // Notes for internal use (installation notes, landmarks, …)
    internalNotes: text("internal_notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    updatedBy: uuid("updated_by").references(() => users.id),
  },
  (table) => [
    // S1-5: the area list and the route-sheet picker read subscribers by area.
    index("subscribers_area_idx").on(table.areaId),
    // S1-10 / S12-4: the subscriber list searches every one of these columns with
    // ILIKE '%…%', which a btree index cannot serve. A pg_trgm GIN index turns
    // each one into an indexable trigram match instead of a sequential scan, which
    // is what holds at the section 4.5 target of 20,000 subscribers.
    // One index per column because the service ORs conditions on separate columns.
    index("subscribers_first_name_trgm_idx").using("gin", sql`${table.firstName} gin_trgm_ops`),
    index("subscribers_last_name_trgm_idx").using("gin", sql`${table.lastName} gin_trgm_ops`),
    index("subscribers_middle_name_trgm_idx").using("gin", sql`${table.middleName} gin_trgm_ops`),
    index("subscribers_account_number_trgm_idx").using(
      "gin",
      sql`${table.accountNumber} gin_trgm_ops`
    ),
    index("subscribers_primary_phone_trgm_idx").using(
      "gin",
      sql`${table.primaryPhone} gin_trgm_ops`
    ),
    index("subscribers_secondary_phone_trgm_idx").using(
      "gin",
      sql`${table.secondaryPhone} gin_trgm_ops`
    ),
    index("subscribers_email_address_trgm_idx").using(
      "gin",
      sql`${table.emailAddress} gin_trgm_ops`
    ),
    index("subscribers_service_address_trgm_idx").using(
      "gin",
      sql`${table.serviceAddress} gin_trgm_ops`
    ),
    index("subscribers_service_barangay_trgm_idx").using(
      "gin",
      sql`${table.serviceBarangay} gin_trgm_ops`
    ),
    index("subscribers_service_municipality_trgm_idx").using(
      "gin",
      sql`${table.serviceMunicipality} gin_trgm_ops`
    ),
  ]
);

// ─── Subscriber Addresses ─────────────────────────────────────────────────────
// S1-9: one subscriber may hold several addresses (home, billing, a second
// installation), so an address is a row rather than four columns on the
// subscriber. The subscriber's original columns stay as denormalized data — the
// migration moves a copy of them here and nothing is deleted.
export const subscriberAddresses = pgTable(
  "subscriber_addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    subscriberId: uuid("subscriber_id")
      .notNull()
      .references(() => subscribers.id),

    // Free label the office recognises, e.g. "Home", "Store", "Billing address".
    label: varchar("label", { length: 50 }).notNull().default("Primary"),

    addressLine: text("address_line").notNull(),
    barangay: varchar("barangay", { length: 100 }),
    municipality: varchar("municipality", { length: 100 }),
    province: varchar("province", { length: 100 }),

    // S1-5: an address can sit in a collection area, so a route sheet can be
    // built from addresses rather than from the subscriber's single barangay.
    areaId: uuid("area_id").references(() => collectionAreas.id),

    // Exactly one address per subscriber is primary (partial unique index below);
    // it is the one the migration derived from the old subscriber columns.
    isPrimary: boolean("is_primary").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    updatedBy: uuid("updated_by").references(() => users.id),
  },
  (table) => [
    index("subscriber_addresses_subscriber_idx").on(table.subscriberId),
    index("subscriber_addresses_area_idx").on(table.areaId),
    // At most one primary address per subscriber, and any number of others.
    uniqueIndex("subscriber_addresses_primary_uq")
      .on(table.subscriberId)
      .where(sql`${table.isPrimary}`),
  ]
);

// ─── Service Accounts ─────────────────────────────────────────────────────────
// Each service account represents one service (Internet or Cable TV) for one subscriber.
// Billing, ledger entries, and payments are all tied to the service account.
export const serviceAccounts = pgTable(
  "service_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Human-readable account number for this specific service. Format: SA-YYYYMMDD-XXXXX
    serviceAccountNumber: varchar("service_account_number", { length: 30 }).notNull().unique(),

    subscriberId: uuid("subscriber_id")
      .notNull()
      .references(() => subscribers.id),
    planId: uuid("plan_id")
      .notNull()
      .references(() => subscriptionPlans.id),

    status: serviceAccountStatusEnum("status").notNull().default("pending"),

    // S1-9: where this service is actually installed. Nullable: an account may
    // bill without an installation record. Points at one of the subscriber's
    // addresses, so two services can install at two different addresses.
    installationAddressId: uuid("installation_address_id").references(() => subscriberAddresses.id),

    // The date service began (used to determine the first billing period)
    activationDate: date("activation_date"),

    // S1-11: per-account billing schedule. `billing_start_date` is the first day
    // this account may be billed for; the two day-of-month columns are OVERRIDES
    // of the global `invoice_due_day_of_month` setting. When either is null the
    // billing engine falls back to the system setting, so an account only carries
    // a value when somebody deliberately moved its bill off the office default.
    billingStartDate: date("billing_start_date"),
    billingDay: integer("billing_day"),
    dueDay: integer("due_day"),

    // The date service was suspended or terminated (null if still active)
    suspensionDate: date("suspension_date"),
    terminationDate: date("termination_date"),

    // The field collector assigned to this account.
    // null = office payment only; not assigned to a collector
    assignedCollectorId: uuid("assigned_collector_id").references(() => users.id),

    // S1-5: the collection area for this specific service. Nullable because an
    // account may predate areas, and it may differ from the subscriber's area.
    areaId: uuid("area_id").references(() => collectionAreas.id),

    // Overdue tracking: how many consecutive months unpaid
    consecutiveOverdueMonths: integer("consecutive_overdue_months").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    // S1-5: the route sheet and the by-area reports read accounts by area.
    index("service_accounts_area_idx").on(table.areaId),
    // Phase 8's dashboard counts active, suspended, and terminated accounts, and the
    // subscriber list filters by status; this index serves both.
    index("service_accounts_status_idx").on(table.status),
    // S1-11: a day-of-month override must be a real billing day. Days 29-31 are
    // excluded on purpose — every month has 28, and a bill that falls due on the
    // 31st cannot be calculated in February.
    check(
      "service_accounts_billing_day_check",
      sql`${table.billingDay} IS NULL OR (${table.billingDay} BETWEEN 1 AND 28)`
    ),
    check(
      "service_accounts_due_day_check",
      sql`${table.dueDay} IS NULL OR (${table.dueDay} BETWEEN 1 AND 28)`
    ),
  ]
);

// ─── Suspension/Reconnection Log ─────────────────────────────────────────────
// Complete history of every status change. Needed for the audit trail: an account
// is never deleted, so "why is this cut off?" must always be answerable.
export const serviceStatusHistory = pgTable("service_status_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  serviceAccountId: uuid("service_account_id")
    .notNull()
    .references(() => serviceAccounts.id),
  previousStatus: serviceAccountStatusEnum("previous_status").notNull(),
  newStatus: serviceAccountStatusEnum("new_status").notNull(),
  reason: text("reason"), // Required for suspension/termination
  changedBy: uuid("changed_by")
    .notNull()
    .references(() => users.id),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Relations ───────────────────────────────────────────────────────────────
export const subscribersRelations = relations(subscribers, ({ many }) => ({
  serviceAccounts: many(serviceAccounts),
  addresses: many(subscriberAddresses),
}));

export const subscriberAddressesRelations = relations(subscriberAddresses, ({ one }) => ({
  subscriber: one(subscribers, {
    fields: [subscriberAddresses.subscriberId],
    references: [subscribers.id],
  }),
  area: one(collectionAreas, {
    fields: [subscriberAddresses.areaId],
    references: [collectionAreas.id],
  }),
}));

export const subscriptionPlansRelations = relations(subscriptionPlans, ({ many }) => ({
  serviceAccounts: many(serviceAccounts),
}));

export const serviceAccountsRelations = relations(serviceAccounts, ({ one, many }) => ({
  subscriber: one(subscribers, {
    fields: [serviceAccounts.subscriberId],
    references: [subscribers.id],
  }),
  plan: one(subscriptionPlans, {
    fields: [serviceAccounts.planId],
    references: [subscriptionPlans.id],
  }),
  installationAddress: one(subscriberAddresses, {
    fields: [serviceAccounts.installationAddressId],
    references: [subscriberAddresses.id],
  }),
  statusHistory: many(serviceStatusHistory),
}));

export const serviceStatusHistoryRelations = relations(serviceStatusHistory, ({ one }) => ({
  serviceAccount: one(serviceAccounts, {
    fields: [serviceStatusHistory.serviceAccountId],
    references: [serviceAccounts.id],
  }),
}));

export type Subscriber = typeof subscribers.$inferSelect;
export type NewSubscriber = typeof subscribers.$inferInsert;
export type SubscriptionPlan = typeof subscriptionPlans.$inferSelect;
export type NewSubscriptionPlan = typeof subscriptionPlans.$inferInsert;
export type ServiceAccount = typeof serviceAccounts.$inferSelect;
export type NewServiceAccount = typeof serviceAccounts.$inferInsert;
export type ServiceStatusHistoryEntry = typeof serviceStatusHistory.$inferSelect;
export type NewServiceStatusHistoryEntry = typeof serviceStatusHistory.$inferInsert;
export type SubscriberAddress = typeof subscriberAddresses.$inferSelect;
export type NewSubscriberAddress = typeof subscriberAddresses.$inferInsert;
