// Field collection: collector batches and the service accounts assigned to them.
// Phase 7 implements this domain.
//
// A batch is one collection run for one collector. The collector records what they
// collected from each assigned subscriber in the field, then hands the cash in at
// the office. The office reconciles the batch against the money received.
//
// Financial-record rules this schema enforces:
//   • A batch, an assignment, and a recorded collection are NEVER deleted. A
//     mistake is corrected by VOIDING the collection (which reverses the payment
//     it created) or by cancelling the batch — both are status changes with an
//     audit trail, never a DELETE.
//   • Every monetary column is an integer number of centavos.
//   • `expectedRemittanceCentavos` is the sum of the batch's recorded collections.
//     It is recomputed inside the same transaction as every collection write, so
//     it can never drift from the assignments by a single centavo.
//   • Variance is `actual - expected`: positive means the collector handed in more
//     than they collected (overage); negative means less (shortage). It is stored,
//     never silently zeroed.

import { relations, sql } from "drizzle-orm";
import {
  check,
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

import { payments } from "./payments";
import { serviceAccounts } from "./subscribers";
import { users } from "./users";

// ─── Collector Batch Status ───────────────────────────────────────────────────
// Mirrors COLLECTOR_BATCH_STATUSES in the shared package (S4-1).
//
// The six-state lifecycle is OPEN → IN_PROGRESS → SUBMITTED → REMITTED →
// RECONCILED → CLOSED, plus CANCELLED from an open run. The three states that
// were missing (`in_progress`, `remitted`, `closed`) separate what used to be
// fused into `submitted`/`reconciled`:
//
//   open        → created, the collector has not started recording
//   in_progress → the collector is in the field recording collections
//   submitted   → the collector returned and declared the run finished
//   remitted    → the cash handed in has been recorded (one or more remittances)
//   reconciled  → the office confirmed the amounts against the ledger
//   closed      → the batch is finally signed off, after reconciliation
//   cancelled   → abandoned before any collection was recorded
//
// Migration mapping (0025): an old `submitted` row already carried the declared
// cash, so it maps to `remitted`; `open`, `reconciled` and `cancelled` keep their
// meaning unchanged.
export const collectorBatchStatusEnum = pgEnum("collector_batch_status", [
  "open",
  "in_progress",
  "submitted",
  "remitted",
  "reconciled",
  "closed",
  "cancelled",
]);

// ─── Collection Result ────────────────────────────────────────────────────────
// What happened when the collector visited a subscriber.
export const collectionResultEnum = pgEnum("collection_result", [
  "collected", // Subscriber paid in full
  "partial", // Subscriber paid only part
  "no_response", // Nobody home
  "refused", // Subscriber declined to pay
  "promise", // Subscriber promised to pay later
]);

// ─── Collected Method ─────────────────────────────────────────────────────────
// How the field money was received. Only cash and GCash are taken at the door.
export const collectedMethodEnum = pgEnum("collected_method", ["cash", "gcash"]);

// ─── Collector Batches ────────────────────────────────────────────────────────
export const collectorBatches = pgTable(
  "collector_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Human-readable batch reference. Format: CB-YYYYMMDD-XXXX (Collection Batch).
    // Unique, allocated atomically under an advisory lock, and never reused.
    batchNumber: varchar("batch_number", { length: 30 }).notNull().unique(),

    collectorId: uuid("collector_id")
      .notNull()
      .references(() => users.id),

    status: collectorBatchStatusEnum("status").notNull().default("open"),

    // The calendar date the collector went to the field.
    collectionDate: date("collection_date").notNull(),

    // What the system expects the collector to remit — the sum of the recorded
    // collections in this batch. Maintained by the service, always to the centavo.
    expectedRemittanceCentavos: integer("expected_remittance_centavos").notNull().default(0),

    // What the collector actually handed in, entered at remittance time.
    actualRemittanceCentavos: integer("actual_remittance_centavos"),

    // actual - expected. Positive = overage, negative = shortage, null = not yet
    // submitted. Stored so a variance is never silently absorbed.
    varianceCentavos: integer("variance_centavos"),

    // Why the cash handed in differed from what was collected. Required when
    // variance is not zero.
    varianceNotes: text("variance_notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),

    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    reconciledBy: uuid("reconciled_by").references(() => users.id),
    closedBy: uuid("closed_by").references(() => users.id),
    cancelledBy: uuid("cancelled_by").references(() => users.id),

    // Why an open batch was abandoned.
    cancelReason: text("cancel_reason"),
  },
  (table) => [
    // The list screen filters by collector, status, and date; each is served here.
    index("collector_batches_collector_idx").on(table.collectorId),
    index("collector_batches_status_idx").on(table.status),
    index("collector_batches_collection_date_idx").on(table.collectionDate),
  ]
);

// ─── Batch Assignments ────────────────────────────────────────────────────────
// Which service accounts belong to a batch, and what the collector found at each.
//
// A service account may appear in only one OPEN batch at a time. That rule is
// enforced in the service under an advisory lock keyed by the service account id,
// because a partial unique index cannot see the parent batch's status.
export const batchAssignments = pgTable(
  "batch_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => collectorBatches.id),
    serviceAccountId: uuid("service_account_id")
      .notNull()
      .references(() => serviceAccounts.id),

    // Outstanding balance when the batch was created (informational).
    outstandingBalanceCentavos: integer("outstanding_balance_centavos").notNull().default(0),

    // Filled in when the collector records the visit; null while still pending.
    collectionResult: collectionResultEnum("collection_result"),

    // If money was collected, the amount and the method.
    collectedAmountCentavos: integer("collected_amount_centavos"),
    collectedMethod: collectedMethodEnum("collected_method"),

    // The official payment created from this collection, if any. The payment is the
    // financial record; this link is how the batch points back at it.
    paymentId: uuid("payment_id").references(() => payments.id),

    collectorNotes: text("collector_notes"),

    updatedAt: timestamp("updated_at", { withTimezone: true }),

    // A voided collection keeps its row: the money it represented is reversed by a
    // payment reversal, and the void is recorded here for the audit trail.
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => users.id),
    voidReason: text("void_reason"),
  },
  (table) => [
    index("batch_assignments_batch_idx").on(table.batchId),
    index("batch_assignments_service_account_idx").on(table.serviceAccountId),
  ]
);

// ─── Collector Remittances ────────────────────────────────────────────────────
// S1-6: the cash a collector hands in, as its own record.
//
// A batch used to carry one `actual_remittance_centavos` column, so a partial
// hand-in or a corrected one had nowhere to go. A remittance is now a row: a
// batch may have several (paid in instalments) and the report lists them all.
// Nothing is deleted to correct a remittance — an offsetting row is added beside
// it, exactly like a payment reversal.
//
// Invariant, enforced by the CHECK below: amount = cash + gcash.
// `collector_batches.actualRemittanceCentavos` stays as the batch-level total
// that the reconciliation step compares against expected.
export const collectorRemittances = pgTable(
  "collector_remittances",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    batchId: uuid("batch_id")
      .notNull()
      .references(() => collectorBatches.id),

    // Total handed in, in centavos.
    amountCentavos: integer("amount_centavos").notNull(),

    // The method split, in centavos. Field collections are cash or GCash only
    // (see collected_method), so two methods are enough to describe the split.
    cashAmountCentavos: integer("cash_amount_centavos").notNull().default(0),
    gcashAmountCentavos: integer("gcash_amount_centavos").notNull().default(0),

    // Who handed the money in and when. This is the actor of the row, so there is
    // no separate `created_by`. `remitted_at` defaults to now but is settable, so
    // an office clerk can record a remittance that arrived earlier in the day.
    remittedBy: uuid("remitted_by")
      .notNull()
      .references(() => users.id),
    remittedAt: timestamp("remitted_at", { withTimezone: true }).notNull().defaultNow(),

    // Why this remittance was recorded or corrected.
    notes: text("notes"),
  },
  (table) => [
    index("collector_remittances_batch_idx").on(table.batchId),
    index("collector_remittances_remitted_by_idx").on(table.remittedBy),
    check(
      "collector_remittances_split_check",
      sql`${table.amountCentavos} = ${table.cashAmountCentavos} + ${table.gcashAmountCentavos}`
    ),
    // A correction is an offsetting row beside the one it fixes, so a remittance
    // amount is non-zero but may be negative. Nothing is edited or deleted, exactly
    // like a payment reversal. The signed total of a batch's remittances is what
    // the batch-level `actualRemittanceCentavos` stores.
    check("collector_remittances_amount_check", sql`${table.amountCentavos} <> 0`),
  ]
);

// ─── Relations ───────────────────────────────────────────────────────────────
export const collectorBatchesRelations = relations(collectorBatches, ({ one, many }) => ({
  collector: one(users, {
    fields: [collectorBatches.collectorId],
    references: [users.id],
  }),
  assignments: many(batchAssignments),
  remittances: many(collectorRemittances),
}));

export const collectorRemittancesRelations = relations(collectorRemittances, ({ one }) => ({
  batch: one(collectorBatches, {
    fields: [collectorRemittances.batchId],
    references: [collectorBatches.id],
  }),
  remittedByUser: one(users, {
    fields: [collectorRemittances.remittedBy],
    references: [users.id],
  }),
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

export type CollectorBatch = typeof collectorBatches.$inferSelect;
export type NewCollectorBatch = typeof collectorBatches.$inferInsert;
export type BatchAssignment = typeof batchAssignments.$inferSelect;
export type NewBatchAssignment = typeof batchAssignments.$inferInsert;
export type CollectorBatchStatus = (typeof collectorBatchStatusEnum.enumValues)[number];
export type CollectionResult = (typeof collectionResultEnum.enumValues)[number];
export type CollectedMethod = (typeof collectedMethodEnum.enumValues)[number];
export type CollectorRemittance = typeof collectorRemittances.$inferSelect;
export type NewCollectorRemittance = typeof collectorRemittances.$inferInsert;