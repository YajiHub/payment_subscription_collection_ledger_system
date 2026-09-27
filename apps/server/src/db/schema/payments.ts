// Payments, receipts, and payment reversals. Amounts are integer centavos.
// Phase 5 implements this domain.
//
// Financial record rules that this schema enforces:
//   • A payment row is NEVER deleted. A mistake is corrected by a reversal:
//     the payment's status becomes "reversed" and a payment_reversals row is
//     created beside it, while a debit ledger entry cancels the original credit.
//   • Every monetary column is an integer number of centavos. JavaScript floats
//     are never used for money.
//   • Receipt numbers are unique and permanent. The unique constraints below are
//     the last line of defence; the services also check before inserting so the
//     caller gets a clean 409 instead of a raw database error.
//
// Invariant on every payment row:
//     allocatedCentavos + advanceCreditCentavos === amountCentavos
// The allocation service guarantees it, and the allocation invariant test pins it.

import { relations, sql } from "drizzle-orm";
import {
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

import { invoices } from "./billing";
import { serviceAccounts } from "./subscribers";
import { users } from "./users";

// ─── Payment Method ───────────────────────────────────────────────────────────
// Mirrors PAYMENT_METHODS in the shared package. All five methods section 3.6
// requires are postable: cash, GCash, bank transfer, cheque (`check` has been the
// stored spelling since migration 0004) and other.
export const paymentMethodEnum = pgEnum("payment_method", [
  "cash",
  "gcash",
  "check",
  "bank_transfer",
  "other",
]);

// ─── Payment Status ───────────────────────────────────────────────────────────
// Mirrors PAYMENT_STATUSES in the shared package.
//
//   pending_verification — a GCash payment recorded but not yet confirmed by a
//                          verifier. It has no allocations, no ledger entries and
//                          no invoice changes, so it cannot move a balance (S3-2).
//   posted               — the money is received. For GCash this is the state the
//                          verifier moves it to, and `gcash_payments.verified_at` /
//                          `verified_by` then record who confirmed it (S3-3).
//   reversed             — corrected by a reversal — see payment_reversals.
//   rejected             — a GCash payment a verifier refused, with a reason.
export const paymentStatusEnum = pgEnum("payment_status", [
  "pending_verification",
  "posted",
  "reversed",
  "rejected",
]);

// ─── Payments ─────────────────────────────────────────────────────────────────
// One row per payment transaction.
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Official Receipt number printed on the document given to the subscriber.
    // Format: OR-YYYY-XXXXXX. Unique, and never reused.
    receiptNumber: varchar("receipt_number", { length: 30 }).notNull().unique(),

    serviceAccountId: uuid("service_account_id")
      .notNull()
      .references(() => serviceAccounts.id),

    paymentMethod: paymentMethodEnum("payment_method").notNull(),
    status: paymentStatusEnum("status").notNull().default("posted"),

    // Amount received, in centavos.
    amountCentavos: integer("amount_centavos").notNull(),

    // How the amount was split between settling invoices and being held as an
    // advance credit for the next invoice.
    allocatedCentavos: integer("allocated_centavos").notNull().default(0),
    advanceCreditCentavos: integer("advance_credit_centavos").notNull().default(0),

    paymentDate: date("payment_date").notNull(),

    // Free-text memo, e.g. "Paid by family member".
    notes: text("notes"),

    postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
    postedBy: uuid("posted_by")
      .notNull()
      .references(() => users.id),

    // Populated when the payment is reversed; the row itself is kept.
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedBy: uuid("reversed_by").references(() => users.id),
  },
  (table) => [
    // The history screen filters by account and by date; both are cheap with this.
    index("payments_service_account_idx").on(table.serviceAccountId),
    index("payments_payment_date_idx").on(table.paymentDate),
    // S12-4: a receipt number read off a printed OR is searched as a substring.
    index("payments_receipt_number_trgm_idx").using(
      "gin",
      sql`${table.receiptNumber} gin_trgm_ops`
    ),
  ]
);

// ─── GCash Payment Details ────────────────────────────────────────────────────
// GCash-specific details. One row per GCash payment.
export const gcashPayments = pgTable(
  "gcash_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    paymentId: uuid("payment_id")
      .notNull()
      .unique()
      .references(() => payments.id),

    // The reference number from GCash. UNIQUE system-wide: this constraint is the
    // primary duplicate-detection mechanism, so the same reference can never be
    // posted twice even under concurrent requests.
    gcashReferenceNumber: varchar("gcash_reference_number", { length: 50 }).notNull().unique(),

    senderGcashNumber: varchar("sender_gcash_number", { length: 20 }),
    senderName: varchar("sender_name", { length: 100 }),

    // Path to the uploaded screenshot proof, relative to the uploads directory.
    // A screenshot is PROOF OF A CLAIM, never proof of payment: only a verifier's
    // confirmation moves the payment to `posted`, so an image alone can never mark
    // an account paid (section 3.7).
    screenshotFilePath: text("screenshot_file_path"),

    // Who confirmed the transfer, and when. Written by the verify step (S3-3), and
    // retained afterwards as history — a later reversal does not erase the fact
    // that this person verified it.
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedBy: uuid("verified_by").references(() => users.id),

    // Who refused the claim, and why. A rejection is final for this row; the
    // invoice is untouched because a pending GCash payment never touched it.
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectedBy: uuid("rejected_by").references(() => users.id),
    rejectionReason: text("rejection_reason"),
  },
  (table) => [
    // S12-4: verifiers search the queue by the reference number they were given
    // on the phone, which is a substring match on a unique btree key.
    index("gcash_payments_reference_trgm_idx").using(
      "gin",
      sql`${table.gcashReferenceNumber} gin_trgm_ops`
    ),
  ]
);

// ─── Payment Allocations ──────────────────────────────────────────────────────
// Exactly how a payment was spread across invoices. This is the bridge between
// payments and invoices, and it is the audit trail for the allocation algorithm.
//
// Invariant: for a posted payment, SUM(allocated_amount_centavos) across its
// allocation rows === payments.allocated_centavos. No centavo is lost or created.
export const paymentAllocations = pgTable(
  "payment_allocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id),

    // How much of this payment was applied to this specific invoice.
    allocatedAmountCentavos: integer("allocated_amount_centavos").notNull(),

    allocatedAt: timestamp("allocated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("payment_allocations_payment_idx").on(table.paymentId),
    index("payment_allocations_invoice_idx").on(table.invoiceId),
  ]
);

// ─── Payment Reversals ────────────────────────────────────────────────────────
// When a payment must be undone, a reversal record is created. The original
// payment row's status changes to "reversed" but the row is NEVER deleted.
export const paymentReversals = pgTable("payment_reversals", {
  id: uuid("id").primaryKey().defaultRandom(),
  originalPaymentId: uuid("original_payment_id")
    .notNull()
    .references(() => payments.id),

  // Why was this reversed? Required — no silent reversals.
  reason: text("reason").notNull(),

  // The reversing document's number, so it appears in the audit trail.
  // Format: RV-YYYY-XXXXXX. Unique and never reused.
  reversalReceiptNumber: varchar("reversal_receipt_number", { length: 30 }).notNull().unique(),

  reversedBy: uuid("reversed_by")
    .notNull()
    .references(() => users.id),
  reversedAt: timestamp("reversed_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Relations ───────────────────────────────────────────────────────────────
export const paymentsRelations = relations(payments, ({ one, many }) => ({
  serviceAccount: one(serviceAccounts, {
    fields: [payments.serviceAccountId],
    references: [serviceAccounts.id],
  }),
  postedByUser: one(users, {
    fields: [payments.postedBy],
    references: [users.id],
  }),
  gcashDetails: one(gcashPayments, {
    fields: [payments.id],
    references: [gcashPayments.paymentId],
  }),
  allocations: many(paymentAllocations),
}));

export const gcashPaymentsRelations = relations(gcashPayments, ({ one }) => ({
  payment: one(payments, {
    fields: [gcashPayments.paymentId],
    references: [payments.id],
  }),
}));

export const paymentAllocationsRelations = relations(paymentAllocations, ({ one }) => ({
  payment: one(payments, {
    fields: [paymentAllocations.paymentId],
    references: [payments.id],
  }),
  invoice: one(invoices, {
    fields: [paymentAllocations.invoiceId],
    references: [invoices.id],
  }),
}));

export const paymentReversalsRelations = relations(paymentReversals, ({ one }) => ({
  originalPayment: one(payments, {
    fields: [paymentReversals.originalPaymentId],
    references: [payments.id],
  }),
  reversedByUser: one(users, {
    fields: [paymentReversals.reversedBy],
    references: [users.id],
  }),
}));

export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
export type GcashPayment = typeof gcashPayments.$inferSelect;
export type NewGcashPayment = typeof gcashPayments.$inferInsert;
export type PaymentAllocation = typeof paymentAllocations.$inferSelect;
export type NewPaymentAllocation = typeof paymentAllocations.$inferInsert;
export type PaymentReversal = typeof paymentReversals.$inferSelect;
export type NewPaymentReversal = typeof paymentReversals.$inferInsert;
