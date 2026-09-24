// Subscriber ledger: every financial event, in order, in one place.
// Phase 6 implements this domain; Phase 4 writes the first entries into it.
//
//   Ledger balance = SUM(debits) - SUM(credits)
//
// Ledger entries are immutable: once written they are NEVER updated or deleted.
// A correction is a new, offsetting entry.
//
// Amounts are always POSITIVE; `entryType` decides whether the entry is a debit
// (increases what the subscriber owes) or a credit (decreases it). Using signed
// amounts here would make every query more complex and easier to get wrong.
//
// `runningBalanceCentavos` is a convenience cache of the balance after this entry;
// the balance can always be recomputed from the entries themselves.

import { relations } from "drizzle-orm";
import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { invoices } from "./billing";
import { payments } from "./payments";
import { serviceAccounts } from "./subscribers";
import { users } from "./users";

export const ledgerEntryTypeEnum = pgEnum("ledger_entry_type", [
  // Debits — money owed to the company
  "invoice_posted", // monthly subscription or reconnection fee invoice
  "late_fee", // penalty added to an overdue invoice
  "manual_debit", // manual charge by an admin (with justification)
  "payment_reversal", // cancelled payment — restores the debt

  // Credits — money received or an obligation removed
  "payment_received", // cash or GCash payment
  "invoice_void", // invoice cancelled — removes the debt
  "advance_credit", // payment exceeded invoices — credit for future use
  "advance_credit_applied", // consumes an advance credit applied to a new invoice
  "manual_credit", // manual credit by an admin (with justification)
  "write_off", // bad debt written off (creates a zero balance but is documented)
]);

// `advance_credit_applied` is listed with the credits above (the enum order is kept
// stable so no migration is regenerated), but it is a DEBIT: applying an advance
// credit consumes it, shrinking the credit the subscriber still holds.

/** Debit entry types. Every other type is a credit. */
export const DEBIT_ENTRY_TYPES = [
  "invoice_posted",
  "late_fee",
  "manual_debit",
  "payment_reversal",
  "advance_credit_applied",
] as const;

export const ledgerEntries = pgTable("ledger_entries", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Every ledger entry belongs to a specific service account, not the subscriber:
  // each service has its own financial record.
  serviceAccountId: uuid("service_account_id")
    .notNull()
    .references(() => serviceAccounts.id),

  entryType: ledgerEntryTypeEnum("entry_type").notNull(),

  // Amount in centavos, ALWAYS POSITIVE (the type tells you the direction).
  amountCentavos: integer("amount_centavos").notNull(),

  // The position of this entry in the account's ledger chain, starting at 1 and
  // increasing by exactly one per new entry. It is what makes the running balance
  // provably an unbroken chain: a gap means a row was deleted, a duplicate means
  // two writers raced. The unique index below is the database-level backstop.
  sequenceNumber: integer("sequence_number").notNull().default(0),

  // Running balance AFTER this entry (debit adds, credit subtracts).
  runningBalanceCentavos: integer("running_balance_centavos").notNull(),

  // Human-readable description shown on the Statement of Account.
  // e.g. "Invoice INV-2025-01-000042 — January 2025"
  description: text("description").notNull(),

  // The source document. Only one of these is populated per entry.
  invoiceId: uuid("invoice_id").references(() => invoices.id),
  paymentId: uuid("payment_id").references(() => payments.id),

  entryDate: timestamp("entry_date", { withTimezone: true }).notNull().defaultNow(),

  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
},
(table) => [
  // One service account can never hold two entries with the same sequence number.
  // Even if the per-account advisory lock were bypassed, this refuses the write.
  uniqueIndex("ledger_entries_account_sequence_uq").on(
    table.serviceAccountId,
    table.sequenceNumber
  ),
  // The ledger page and the balance lookup both filter by account and read in
  // sequence order; this index serves both.
  index("ledger_entries_service_account_idx").on(table.serviceAccountId),
]);

export const ledgerEntriesRelations = relations(ledgerEntries, ({ one }) => ({
  serviceAccount: one(serviceAccounts, {
    fields: [ledgerEntries.serviceAccountId],
    references: [serviceAccounts.id],
  }),
  invoice: one(invoices, {
    fields: [ledgerEntries.invoiceId],
    references: [invoices.id],
  }),
  payment: one(payments, {
    fields: [ledgerEntries.paymentId],
    references: [payments.id],
  }),
}));

export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type NewLedgerEntry = typeof ledgerEntries.$inferInsert;
export type LedgerEntryType = (typeof ledgerEntryTypeEnum.enumValues)[number];
