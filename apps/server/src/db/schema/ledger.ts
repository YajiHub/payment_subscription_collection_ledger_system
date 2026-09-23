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
import { integer, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { invoices } from "./billing";
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
  "advance_credit_applied", // advance credit consumed by a new invoice
  "manual_credit", // manual credit by an admin (with justification)
  "write_off", // bad debt written off (creates a zero balance but is documented)
]);

/** Debit entry types. Every other type is a credit. */
export const DEBIT_ENTRY_TYPES = [
  "invoice_posted",
  "late_fee",
  "manual_debit",
  "payment_reversal",
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

  // Running balance AFTER this entry (debit adds, credit subtracts).
  runningBalanceCentavos: integer("running_balance_centavos").notNull(),

  // Human-readable description shown on the Statement of Account.
  // e.g. "Invoice INV-2025-01-000042 — January 2025"
  description: text("description").notNull(),

  // The source document. A payment reference is added in Phase 5; until the
  // payments table exists this column is a plain id so this phase stays self-contained.
  invoiceId: uuid("invoice_id").references(() => invoices.id),
  paymentId: uuid("payment_id"),

  entryDate: timestamp("entry_date", { withTimezone: true }).notNull().defaultNow(),

  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
});

export const ledgerEntriesRelations = relations(ledgerEntries, ({ one }) => ({
  serviceAccount: one(serviceAccounts, {
    fields: [ledgerEntries.serviceAccountId],
    references: [serviceAccounts.id],
  }),
  invoice: one(invoices, {
    fields: [ledgerEntries.invoiceId],
    references: [invoices.id],
  }),
}));

export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type NewLedgerEntry = typeof ledgerEntries.$inferInsert;
export type LedgerEntryType = (typeof ledgerEntryTypeEnum.enumValues)[number];
