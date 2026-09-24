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

import { relations } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

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
export const subscribers = pgTable("subscribers", {
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

  // Notes for internal use (installation notes, landmarks, …)
  internalNotes: text("internal_notes"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  updatedBy: uuid("updated_by").references(() => users.id),
});

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

    // The date service began (used to determine the first billing period)
    activationDate: date("activation_date"),

    // The date service was suspended or terminated (null if still active)
    suspensionDate: date("suspension_date"),
    terminationDate: date("termination_date"),

    // The field collector assigned to this account.
    // null = office payment only; not assigned to a collector
    assignedCollectorId: uuid("assigned_collector_id").references(() => users.id),

    // Overdue tracking: how many consecutive months unpaid
    consecutiveOverdueMonths: integer("consecutive_overdue_months").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    // Phase 8's dashboard counts active, suspended, and terminated accounts, and the
    // subscriber list filters by status; this index serves both.
    index("service_accounts_status_idx").on(table.status),
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
