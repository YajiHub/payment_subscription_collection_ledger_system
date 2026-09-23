# Phase 3 — Subscriber and Service Account Management

> **Prompt template for AI-assisted implementation:**
> "I am building the BCIS Subscription Billing and Collection System (Electron + React, Fastify,
> PostgreSQL, Drizzle ORM). Implement Phase 3: Subscriber and Service Account Management.
> Create the Drizzle schema for subscribers, service types, subscription plans, and service accounts.
> Implement CRUD routes with Billing Clerk authorization. A subscriber can have multiple service
> accounts (Internet, Cable TV, or both). Service accounts track the plan, status, and dates
> for suspension and reconnection. Use the spec at specs/phase3-subscriber-management.md."

---

## 1. Overview

A **subscriber** is a person or household. A subscriber can have one or more **service accounts**
(one for Internet, one for Cable TV, etc.). The billing, ledger, and payment systems all attach
to service accounts — not to the subscriber directly.

This separation is important: a subscriber can have Internet paid up-to-date but Cable TV overdue.
Each service account has its own ledger, its own invoices, and its own balance.

**Instructor checkpoint:** CP2 — Core Data

---

## 2. Key Business Rules

1. **One subscriber → many service accounts** — A household subscribes to Internet and/or Cable TV separately.
2. **Service accounts are never deleted** — Only suspended or terminated. History must be preserved.
3. **Suspension** — An account is suspended when it is overdue (manually triggered by billing clerk or auto). Suspended accounts do not receive new monthly invoices but outstanding balance remains.
4. **Reconnection** — A reconnection fee may be charged when re-activating a suspended account. This creates an invoice entry.
5. **Plans are versioned** — If a plan price changes, existing subscribers are NOT automatically migrated. The new price applies only to new service accounts or explicit re-assignment.
6. **Subscriber names appear on all financial documents** — Even if subscriber data is later edited, receipts and statements must show the name at the time of transaction (handled in payment/receipt phase).

---

## 3. Database Schema

```typescript
// apps/server/src/db/schema/subscribers.ts

import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  boolean,
  date,
  timestamp,
  pgEnum,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { users } from "./users";

// ─── Service Types ────────────────────────────────────────────────────────────
// The types of services this ISP offers.
// Extensible: adding VoIP or IP cameras in the future means adding a value here.
export const serviceTypeEnum = pgEnum("service_type", [
  "internet",
  "cable_tv",
  "bundle",          // Internet + Cable TV sold as a package
]);

// ─── Account Status ───────────────────────────────────────────────────────────
// The lifecycle states of a service account.
export const serviceAccountStatusEnum = pgEnum("service_account_status", [
  "active",          // Receiving service, billing runs normally
  "suspended",       // Service cut; billing paused; balance still due
  "terminated",      // Permanently cancelled; no billing; balance may still be owed
  "pending",         // New account awaiting activation (installation not yet done)
]);

// ─── Subscription Plans ───────────────────────────────────────────────────────
// Plans define what service and at what price.
// Price changes create a new plan record — existing accounts keep their old plan.
export const subscriptionPlans = pgTable("subscription_plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 100 }).notNull(),  // e.g. "Fiber 25Mbps", "Cable Basic"
  serviceType: serviceTypeEnum("service_type").notNull(),

  // Speed tier for internet plans (null for cable-only plans)
  speedMbps: integer("speed_mbps"),

  // Channels/package description for cable plans (null for internet-only)
  cablePackageDescription: text("cable_package_description"),

  // Monthly charge stored in CENTAVOS (integers only — no floating point for money)
  // PHP 999.00 = 99900 centavos
  monthlyRateCentavos: integer("monthly_rate_centavos").notNull(),

  // Reconnection fee charged when a suspended account is reactivated
  reconnectionFeeCentavos: integer("reconnection_fee_centavos").notNull().default(0),

  isActive: boolean("is_active").notNull().default(true), // false = plan retired, no new signups

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").notNull().references(() => users.id),
});

// ─── Subscribers ──────────────────────────────────────────────────────────────
// A subscriber is a customer/household. They may have multiple service accounts.
export const subscribers = pgTable("subscribers", {
  id: uuid("id").primaryKey().defaultRandom(),

  // The subscriber's account number — shown on all documents and printed receipts
  // Format: SUB-YYYYMMDD-XXXXX (auto-generated, human-readable)
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

  // Notes for internal use (installation notes, landmarks, etc.)
  internalNotes: text("internal_notes"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  updatedBy: uuid("updated_by").references(() => users.id),
});

// ─── Service Accounts ─────────────────────────────────────────────────────────
// Each service account represents one service (Internet or Cable TV) for one subscriber.
// Billing, ledger entries, and payments are all tied to the service account.
export const serviceAccounts = pgTable("service_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Human-readable account number for this specific service
  // Format: SA-YYYYMMDD-XXXXX
  serviceAccountNumber: varchar("service_account_number", { length: 30 }).notNull().unique(),

  subscriberId: uuid("subscriber_id").notNull().references(() => subscribers.id),
  planId: uuid("plan_id").notNull().references(() => subscriptionPlans.id),

  status: serviceAccountStatusEnum("status").notNull().default("pending"),

  // The date service began (used to determine first billing period)
  activationDate: date("activation_date"),

  // The date service was suspended or terminated (null if still active)
  suspensionDate: date("suspension_date"),
  terminationDate: date("termination_date"),

  // Who is assigned as the field collector for this account
  // null = office payment only; not assigned to a collector
  assignedCollectorId: uuid("assigned_collector_id").references(() => users.id),

  // Overdue tracking: how many consecutive months unpaid
  consecutiveOverdueMonths: integer("consecutive_overdue_months").notNull().default(0),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by").notNull().references(() => users.id),
});

// ─── Suspension/Reconnection Log ─────────────────────────────────────────────
// Complete history of every suspension and reconnection. Needed for audit trail.
export const serviceStatusHistory = pgTable("service_status_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  serviceAccountId: uuid("service_account_id").notNull().references(() => serviceAccounts.id),
  previousStatus: serviceAccountStatusEnum("previous_status").notNull(),
  newStatus: serviceAccountStatusEnum("new_status").notNull(),
  reason: text("reason"),                   // Required for suspension/termination
  changedBy: uuid("changed_by").notNull().references(() => users.id),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Relations ───────────────────────────────────────────────────────────────
export const subscribersRelations = relations(subscribers, ({ many }) => ({
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
```

---

## 4. Account Number Generation

```typescript
// apps/server/src/modules/subscribers/account-number.service.ts
// Generates human-readable account numbers that are also sortable by date.

export function generateSubscriberAccountNumber(
  today: Date,
  sequenceNumber: number
): string {
  // Format: SUB-20250124-00042
  const dateStr = today.toISOString().slice(0, 10).replace(/-/g, "");
  const seq = String(sequenceNumber).padStart(5, "0");
  return `SUB-${dateStr}-${seq}`;
}

export function generateServiceAccountNumber(
  today: Date,
  sequenceNumber: number
): string {
  // Format: SA-20250124-00042
  const dateStr = today.toISOString().slice(0, 10).replace(/-/g, "");
  const seq = String(sequenceNumber).padStart(5, "0");
  return `SA-${dateStr}-${seq}`;
}
```

---

## 5. API Endpoints

### Subscription Plans
```
GET  /api/plans              → List active plans (filter by serviceType)
POST /api/plans              → Create plan (Billing Clerk, Admin)
GET  /api/plans/:id          → Get plan details
PUT  /api/plans/:id          → Update plan name/description (NOT price — create new plan for price changes)
PUT  /api/plans/:id/retire   → Deactivate plan (no new subscriptions)
```

### Subscribers
```
GET  /api/subscribers                    → List subscribers (paginated, searchable)
POST /api/subscribers                    → Create subscriber (Billing Clerk, Admin)
GET  /api/subscribers/:id               → Get subscriber with all service accounts
PUT  /api/subscribers/:id               → Update subscriber contact/address info
GET  /api/subscribers/:id/statement     → Statement of Account (all service accounts)
GET  /api/subscribers/search?q=         → Search by name, account number, phone
```

### Service Accounts
```
GET  /api/service-accounts/:id          → Get service account details + ledger summary
POST /api/subscribers/:id/service-accounts → Add service account to subscriber
PUT  /api/service-accounts/:id/suspend  → Suspend account (reason required)
PUT  /api/service-accounts/:id/reconnect → Reconnect account (creates reconnection fee invoice)
PUT  /api/service-accounts/:id/terminate → Terminate account
PUT  /api/service-accounts/:id/plan     → Change plan (creates adjustment entry)
PUT  /api/service-accounts/:id/collector → Assign/reassign collector
```

---

## 6. Key Validation Rules (Zod)

```typescript
// packages/shared/src/types/subscriber.types.ts

import { z } from "zod";

export const createSubscriberSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  middleName: z.string().max(100).optional(),
  primaryPhone: z.string().regex(/^[0-9+\-\s()]{7,20}$/, "Invalid phone number"),
  secondaryPhone: z.string().regex(/^[0-9+\-\s()]{7,20}$/).optional(),
  emailAddress: z.string().email().optional(),
  serviceAddress: z.string().min(5).max(500),
  serviceBarangay: z.string().min(1).max(100),
  serviceMunicipality: z.string().min(1).max(100),
  serviceProvince: z.string().min(1).max(100),
  internalNotes: z.string().max(1000).optional(),
});

export const createServiceAccountSchema = z.object({
  planId: z.string().uuid(),
  activationDate: z.string().date().optional(),  // defaults to today if not provided
  assignedCollectorId: z.string().uuid().optional(),
});

export const suspendServiceAccountSchema = z.object({
  reason: z.string().min(10, "Suspension reason must be at least 10 characters"),
});
```

---

## 7. UI Screens

### Subscriber List Page
- Search bar: search by name, account number, phone number
- Filter: by status (active, suspended, terminated), by municipality
- Table columns: Account # | Full Name | Phone | Services | Status | Actions
- "Add Subscriber" button (Billing Clerk, Admin only)
- Click row → Subscriber Detail page

### Subscriber Detail Page
- Header: Account Number, Full Name, Contact Info, Address
- "Edit" button (Billing Clerk, Admin)
- Service Accounts section — one card per service account:
  - Service type badge (Internet / Cable TV)
  - Plan name + monthly rate
  - Status badge (Active / Suspended / Terminated)
  - Current balance (from ledger — shown in Phase 6)
  - "Suspend" / "Reconnect" / "Terminate" buttons
- Recent Payment History (short list — links to full history)

### Add Subscriber Form
- Two-step form: Step 1 = subscriber info, Step 2 = first service account
- Cannot save without at least one service account
- Plan selection shows plan name, monthly rate, service type

### Plan Management Page (Admin, Billing Clerk)
- Table: Plan Name | Type | Speed/Package | Monthly Rate | Status | Actions
- "Add Plan" button
- "Retire" button per row

---

## 8. Acceptance Criteria

- [ ] Billing Clerk can create a subscriber with at least one service account
- [ ] Service account is created with status = "pending" until activation date is set
- [ ] Subscriber account number is unique and follows SUB-YYYYMMDD-XXXXX format
- [ ] Searching by partial name, account number, or phone number returns correct results
- [ ] Billing Clerk can suspend a service account (reason required)
- [ ] Suspension creates a record in `service_status_history`
- [ ] Reconnection changes status back to "active" and generates a reconnection fee entry
- [ ] Terminated accounts appear in history but cannot be reactivated
- [ ] Manager role can view all subscriber data but cannot create or edit
- [ ] Cashier role can view subscriber info but cannot create, edit, or suspend
- [ ] `pnpm typecheck` and `pnpm lint` pass
- [ ] At least one integration test: create subscriber → add service account → verify database state
