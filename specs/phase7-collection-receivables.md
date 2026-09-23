# Phase 7 — Collection, Receivables, and AR Aging

> **Prompt template for AI-assisted implementation:**
> "I am building the BCIS Subscription Billing and Collection System (Electron + React, Fastify,
> PostgreSQL, Drizzle ORM). Implement Phase 7: Field Collection and Accounts Receivable. Create the
> Drizzle schema for collector batches and batch line items. Implement: collector batch creation,
> recording door-to-door collections in a batch, batch remittance to the office (with cash shortage
> or overage detection), reconciliation sign-off, AR aging computation (0-30, 31-60, 61-90, 90+ days),
> and overdue account listing. Use the spec at specs/phase7-collection-receivables.md."

---

## 1. Overview

**Field collection** is when a collector visits subscribers at their homes or businesses to
collect payment. The collector carries a batch of assigned subscribers, records what they
collected from each, then returns to the office to remit the total cash.

**Accounts Receivable (AR) Aging** shows management how long invoices have been outstanding.
"Aging" means categorizing unpaid invoices by how many days they have been overdue.

**Instructor checkpoint:** CP4 — Collections

---

## 2. Field Collection Workflow

```
[ADMIN/BILLING CLERK]                [COLLECTOR]                    [CASHIER/ADMIN]
       │                                  │                                │
       ▼                                  │                                │
Create batch for collector                │                                │
Assign subscriber service accounts        │                                │
       │                                  │                                │
       ▼                                  ▼                                │
Batch status: OPEN          Collector goes to field                        │
                            Records collections per subscriber             │
                            Each collection = amount + method              │
                                           │                                │
                                           ▼                                │
                            Collector returns to office                     │
                            Enters total cash in hand                       │
                            → status: SUBMITTED                            │
                                                                           │
                                           │                               ▼
                                           └──────────────────────► Cashier/Admin reviews
                                                                    Compares expected vs actual
                                                                    Shortage/Overage flagged
                                                                    Reconcile → CLOSED
```

---

## 3. Database Schema

```typescript
// apps/server/src/db/schema/collections.ts

import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  date,
  timestamp,
  pgEnum,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { serviceAccounts } from "./subscribers";
import { payments } from "./payments";
import { users } from "./users";

export const collectorBatchStatusEnum = pgEnum("collector_batch_status", [
  "open",       // Created, collector is in the field
  "submitted",  // Collector returned and submitted total cash
  "reconciled", // Office confirmed amounts and closed the batch
  "cancelled",  // Batch cancelled before any collections
]);

// ─── Collector Batches ────────────────────────────────────────────────────────
// A batch represents one collection run for one collector.
// A collector may have multiple batches (one per day, one per area, etc.)
export const collectorBatches = pgTable("collector_batches", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Human-readable batch reference number
  // Format: CB-YYYYMMDD-XXXX (Collection Batch)
  batchNumber: varchar("batch_number", { length: 30 }).notNull().unique(),

  collectorId: uuid("collector_id").notNull().references(() => users.id),

  status: collectorBatchStatusEnum("status").notNull().default("open"),

  // The date the collector went to the field
  collectionDate: date("collection_date").notNull(),

  // What the system expects the collector to remit
  // Computed: sum of all collection amounts in this batch
  expectedRemittanceCentavos: integer("expected_remittance_centavos").notNull().default(0),

  // What the collector actually handed in
  // Entered by the collector at remittance time
  actualRemittanceCentavos: integer("actual_remittance_centavos"),

  // Positive = collector collected more than expected (overage)
  // Negative = collector collected less than expected (shortage)
  // Null = not yet reconciled
  varianceCentavos: integer("variance_centavos"),

  // Notes on variance (required if variance != 0)
  varianceNotes: text("variance_notes"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  reconciledAt: timestamp("reconciled_at", { withTimezone: true }),

  createdBy: uuid("created_by").notNull().references(() => users.id),
  reconciledBy: uuid("reconciled_by").references(() => users.id),
});

// ─── Batch Assignments ────────────────────────────────────────────────────────
// Which service accounts are included in this batch.
// A service account can appear in only one OPEN batch at a time.
export const batchAssignments = pgTable("batch_assignments", {
  id: uuid("id").primaryKey().defaultRandom(),
  batchId: uuid("batch_id").notNull().references(() => collectorBatches.id),
  serviceAccountId: uuid("service_account_id").notNull().references(() => serviceAccounts.id),

  // Outstanding balance at the time of batch creation (informational)
  outstandingBalanceCentavos: integer("outstanding_balance_centavos").notNull(),

  // Filled in when the collector records the result of visiting this subscriber
  collectionResult: pgEnum("collection_result", [
    "collected",     // Subscriber paid
    "no_response",   // Nobody home
    "refused",       // Subscriber declined to pay
    "partial",       // Subscriber paid only part
    "promise",       // Subscriber promised to pay later
  ]),

  // If collected, the amount and method
  collectedAmountCentavos: integer("collected_amount_centavos"),
  collectedMethod: pgEnum("collected_method", ["cash", "gcash"]),

  // Once the collector records a collection, it becomes an official payment
  // This links back to the payment record created from this collection
  paymentId: uuid("payment_id").references(() => payments.id),

  collectorNotes: text("collector_notes"),

  updatedAt: timestamp("updated_at", { withTimezone: true }),
});

// ─── Relations ───────────────────────────────────────────────────────────────
export const collectorBatchesRelations = relations(collectorBatches, ({ one, many }) => ({
  collector: one(users, {
    fields: [collectorBatches.collectorId],
    references: [users.id],
  }),
  assignments: many(batchAssignments),
}));

export const batchAssignmentsRelations = relations(batchAssignments, ({ one }) => ({
  batch: one(collectorBatches, {
    fields: [batchAssignments.batchId],
    references: [collectorBatches.id],
  }),
  serviceAccount: one(serviceAccounts, {
    fields: [batchAssignments.serviceAccountId],
    references: [serviceAccounts.id],
  }),
  payment: one(payments, {
    fields: [batchAssignments.paymentId],
    references: [payments.id],
  }),
}));
```

---

## 4. AR Aging Computation

```typescript
// apps/server/src/modules/receivables/ar-aging.service.ts
// AR Aging classifies overdue invoices by how long they've been outstanding.
// Buckets are calculated based on days past the invoice due date.

export type AgingBucket = "current" | "1_to_30" | "31_to_60" | "61_to_90" | "over_90";

export interface AgingEntry {
  subscriberId: string;
  subscriberName: string;
  serviceAccountId: string;
  serviceAccountNumber: string;
  planName: string;
  currentCentavos: number;    // not yet due
  bucket_1_30_centavos: number;
  bucket_31_60_centavos: number;
  bucket_61_90_centavos: number;
  over_90_centavos: number;
  totalOutstandingCentavos: number;
}

function classifyInvoiceAge(dueDate: Date, asOfDate: Date): AgingBucket {
  const daysOverdue = Math.floor(
    (asOfDate.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24)
  );

  if (daysOverdue <= 0)  return "current";
  if (daysOverdue <= 30) return "1_to_30";
  if (daysOverdue <= 60) return "31_to_60";
  if (daysOverdue <= 90) return "61_to_90";
  return "over_90";
}

export async function computeArAging(asOfDate: Date): Promise<{
  entries: AgingEntry[];
  totals: {
    current: number;
    bucket_1_30: number;
    bucket_31_60: number;
    bucket_61_90: number;
    over_90: number;
    grandTotal: number;
  };
}> {
  // Get all unpaid or partially paid invoices
  const unpaidInvoices = await db
    .select({
      invoiceId: invoices.id,
      remainingBalance: invoices.remainingBalanceCentavos,
      dueDate: invoices.dueDate,
      serviceAccountId: invoices.serviceAccountId,
      subscriberId: subscribers.id,
      subscriberFirstName: subscribers.firstName,
      subscriberLastName: subscribers.lastName,
      serviceAccountNumber: serviceAccounts.serviceAccountNumber,
      planName: subscriptionPlans.name,
    })
    .from(invoices)
    .innerJoin(serviceAccounts, eq(invoices.serviceAccountId, serviceAccounts.id))
    .innerJoin(subscribers, eq(serviceAccounts.subscriberId, subscribers.id))
    .innerJoin(subscriptionPlans, eq(serviceAccounts.planId, subscriptionPlans.id))
    .where(
      and(
        inArray(invoices.status, ["posted", "partially_paid", "overdue"]),
        gt(invoices.remainingBalanceCentavos, 0),
      )
    );

  // Group by service account and bucket
  const agingMap = new Map<string, AgingEntry>();

  for (const inv of unpaidInvoices) {
    const bucket = classifyInvoiceAge(new Date(inv.dueDate), asOfDate);
    const key = inv.serviceAccountId;

    if (!agingMap.has(key)) {
      agingMap.set(key, {
        subscriberId: inv.subscriberId,
        subscriberName: `${inv.subscriberFirstName} ${inv.subscriberLastName}`,
        serviceAccountId: inv.serviceAccountId,
        serviceAccountNumber: inv.serviceAccountNumber,
        planName: inv.planName,
        currentCentavos: 0,
        bucket_1_30_centavos: 0,
        bucket_31_60_centavos: 0,
        bucket_61_90_centavos: 0,
        over_90_centavos: 0,
        totalOutstandingCentavos: 0,
      });
    }

    const entry = agingMap.get(key)!;
    entry.totalOutstandingCentavos += inv.remainingBalance;

    switch (bucket) {
      case "current":  entry.currentCentavos += inv.remainingBalance; break;
      case "1_to_30":  entry.bucket_1_30_centavos += inv.remainingBalance; break;
      case "31_to_60": entry.bucket_31_60_centavos += inv.remainingBalance; break;
      case "61_to_90": entry.bucket_61_90_centavos += inv.remainingBalance; break;
      case "over_90":  entry.over_90_centavos += inv.remainingBalance; break;
    }
  }

  const entries = Array.from(agingMap.values()).sort(
    (a, b) => b.totalOutstandingCentavos - a.totalOutstandingCentavos // highest balance first
  );

  const totals = entries.reduce(
    (acc, e) => ({
      current: acc.current + e.currentCentavos,
      bucket_1_30: acc.bucket_1_30 + e.bucket_1_30_centavos,
      bucket_31_60: acc.bucket_31_60 + e.bucket_31_60_centavos,
      bucket_61_90: acc.bucket_61_90 + e.bucket_61_90_centavos,
      over_90: acc.over_90 + e.over_90_centavos,
      grandTotal: acc.grandTotal + e.totalOutstandingCentavos,
    }),
    { current: 0, bucket_1_30: 0, bucket_31_60: 0, bucket_61_90: 0, over_90: 0, grandTotal: 0 }
  );

  return { entries, totals };
}
```

---

## 5. Batch Remittance and Reconciliation

```typescript
// Collector submits their cash total → creates a remittance record
// Office verifies → reconciles (closes the batch)

export async function submitBatchRemittance(
  batchId: string,
  actualRemittanceCentavos: number,
  collectorUserId: string
): Promise<{ variance: number; hasVariance: boolean }> {
  const batch = await getBatch(batchId);

  if (batch.status !== "open") {
    throw new ConflictError("Only open batches can be submitted for remittance");
  }

  // Compute variance: positive = overage, negative = shortage
  const variance = actualRemittanceCentavos - batch.expectedRemittanceCentavos;

  await db
    .update(collectorBatches)
    .set({
      status: "submitted",
      actualRemittanceCentavos,
      varianceCentavos: variance,
      submittedAt: new Date(),
    })
    .where(
      and(
        eq(collectorBatches.id, batchId),
        eq(collectorBatches.collectorId, collectorUserId), // collector can only submit own batches
      )
    );

  return { variance, hasVariance: variance !== 0 };
}

export async function reconcileBatch(
  batchId: string,
  varianceNotes: string | undefined,
  reconciledByUserId: string
): Promise<void> {
  const batch = await getBatch(batchId);

  if (batch.status !== "submitted") {
    throw new ConflictError("Only submitted batches can be reconciled");
  }

  if (batch.varianceCentavos !== 0 && !varianceNotes?.trim()) {
    throw new ValidationError(
      "Variance notes are required when actual remittance differs from expected"
    );
  }

  await db
    .update(collectorBatches)
    .set({
      status: "reconciled",
      varianceNotes,
      reconciledAt: new Date(),
      reconciledBy: reconciledByUserId,
    })
    .where(eq(collectorBatches.id, batchId));
}
```

---

## 6. API Endpoints

```
GET  /api/collector-batches                           → List batches (filter by collector, status, date)
POST /api/collector-batches                           → Create batch (Admin, Billing Clerk)
GET  /api/collector-batches/:id                       → Get batch with assignments
POST /api/collector-batches/:id/assignments           → Add service accounts to batch
PUT  /api/collector-batches/:id/assignments/:accountId → Record collection result
POST /api/collector-batches/:id/submit                → Submit remittance (Collector)
POST /api/collector-batches/:id/reconcile             → Reconcile batch (Admin, Cashier)
POST /api/collector-batches/:id/cancel                → Cancel open batch

GET  /api/receivables/ar-aging                        → AR aging report (as of today or custom date)
GET  /api/receivables/overdue                         → List of overdue service accounts
GET  /api/receivables/overdue-summary                 → Count and total by aging bucket
```

---

## 7. UI Screens

### Collector Batch List
- Filter: by collector name, status, date
- Table: Batch # | Collector | Date | Accounts | Expected | Actual | Variance | Status
- "Create Batch" button

### Batch Detail Page
- Batch header: number, collector, date, status badge
- Assignments table: Subscriber | Service | Outstanding | Collected | Method | Result | Notes
- "Record Collection" per row → modal with amount, method, result, notes
- Totals: Expected ₱X | Collected ₱X | Variance ₱X (color-coded)
- "Submit Remittance" button (Collector role) → enter actual cash in hand
- "Reconcile" button (Admin/Cashier) — requires variance notes if ≠ 0

### AR Aging Report
- "As of" date picker (default: today)
- Summary row: Current | 1-30 Days | 31-60 Days | 61-90 Days | 90+ Days | Total
- Detail table: Subscriber | Account # | Plan | Current | 1-30 | 31-60 | 61-90 | 90+ | Total
- Color coding: current = green, 1-30 = yellow, 31-60 = orange, 61-90 = red, 90+ = dark red
- "Export PDF/XLSX" button
- Verify: Grand total of AR aging = sum of all remaining_balance_centavos on outstanding invoices

### Overdue Accounts List
- List of service accounts with any overdue invoice
- Columns: Account # | Subscriber | Plan | Consecutive Overdue Months | Total Overdue | Collector | Last Payment Date
- Filters: no payment in X days, consecutive overdue months ≥ N
- "Suspend Selected" bulk action (Billing Clerk, Admin)

---

## 8. Acceptance Criteria

- [ ] Collector batch is created with assigned service accounts
- [ ] Collector can record collection result per assignment
- [ ] Recording a collection creates a payment record and a ledger entry
- [ ] A service account cannot be in two open batches simultaneously
- [ ] Batch submission records actual remittance amount
- [ ] Variance = actual - expected (positive = overage, negative = shortage)
- [ ] Reconciliation requires variance notes when variance ≠ 0
- [ ] Variance is visible and not silently zeroed out
- [ ] AR aging buckets: Current, 1-30, 31-60, 61-90, 90+ days past due
- [ ] AR aging grand total = sum of all outstanding invoice balances (verified by test)
- [ ] Overdue accounts list shows consecutive overdue months
- [ ] AR aging can be exported to PDF and XLSX
- [ ] Manager and Admin can view all batches; Collector can only see their own batches
