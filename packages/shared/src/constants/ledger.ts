// Ledger constants shared by the client and the server.
//
// The ledger is the financial source of truth: every invoice post, payment,
// void, and reversal writes one entry, and a subscriber's balance is the sum of
// the debits minus the sum of the credits. Entries are append-only — a correction
// is always a new, offsetting entry.
//
// The strings below must match the database enum EXACTLY so no translation layer
// is needed anywhere between the schema, the API, and the UI.

export const LEDGER_ENTRY_TYPES = [
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
  "write_off", // bad debt written off (creates zero balance but is documented)
] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

/**
 * The entry types that DEBIT the account — they increase what the subscriber owes.
 * Every other type is a credit. `advance_credit_applied` is a debit even though it
 * sounds like a credit: applying an advance credit consumes it, shrinking what the
 * subscriber still holds.
 */
export const DEBIT_LEDGER_ENTRY_TYPES = [
  "invoice_posted",
  "late_fee",
  "manual_debit",
  "payment_reversal",
  "advance_credit_applied",
] as const;

/** True when an entry of this type increases what the subscriber owes. */
export function isDebitLedgerEntryType(type: LedgerEntryType): boolean {
  return (DEBIT_LEDGER_ENTRY_TYPES as readonly string[]).includes(type);
}

/** The direction of an entry as it appears on a statement. */
export type LedgerEntryDirection = "debit" | "credit";

/** "debit" increases the balance; "credit" decreases it. */
export function ledgerEntryDirection(type: LedgerEntryType): LedgerEntryDirection {
  return isDebitLedgerEntryType(type) ? "debit" : "credit";
}

/** Human-readable entry names, used in tables and on the statement of account. */
export const LEDGER_ENTRY_TYPE_LABELS = {
  invoice_posted: "Invoice Posted",
  late_fee: "Late Fee",
  manual_debit: "Manual Debit",
  payment_reversal: "Payment Reversal",
  payment_received: "Payment Received",
  invoice_void: "Invoice Voided",
  advance_credit: "Advance Credit",
  advance_credit_applied: "Advance Credit Applied",
  manual_credit: "Manual Credit",
  write_off: "Write-Off",
} as const satisfies Record<LedgerEntryType, string>;

/**
 * The only two entry types an admin may create directly through the manual-entry
 * endpoint. Every other type is derived from a document (an invoice or a payment)
 * by the billing and payment modules.
 */
export const MANUAL_LEDGER_ENTRY_TYPES = ["manual_debit", "manual_credit"] as const;
export type ManualLedgerEntryType = (typeof MANUAL_LEDGER_ENTRY_TYPES)[number];

/**
 * A balance at or below this many centavos is treated as "low" in the UI, so a
 * small remaining amount is shown in amber rather than red. PHP 500.00.
 */
export const LOW_BALANCE_THRESHOLD_CENTAVOS = 50000;
