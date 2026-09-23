# Phase 6 — Subscriber Ledger and Financial Records

> **Prompt template for AI-assisted implementation:**
> "I am building the BCIS Subscription Billing and Collection System (Electron + React, Fastify,
> PostgreSQL, Drizzle ORM). Implement Phase 6: Subscriber Ledger and Statement of Account. Create
> the Drizzle schema for the ledger table. Every invoice post and every payment creates a ledger
> entry (debit or credit respectively). The running balance must be derivable from ledger entries
> alone — the balance is never stored separately (it is computed). Implement the Statement of Account
> view that shows a subscriber's full financial history. Use the spec at specs/phase6-ledger.md."

---

## 1. Overview

The **ledger** is the central financial record of the system. Every financial event creates a
ledger entry — invoices create debits, payments create credits. The subscriber's balance at any
point in time equals the sum of all debits minus the sum of all credits in their ledger.

> **Why not just compute balance from invoices and payments directly?**
> The ledger provides a single, ordered, complete record of every financial event. It is easier
> to audit, easier to explain during a defense, and maps directly to how real accounting works.
> The "balance" shown on screen is always computed from the ledger — it is never stored as a
> separate column that can drift out of sync.

**Instructor checkpoint:** CP3 — Financial Core

---

## 2. Ledger Principles

```
Ledger Balance = SUM(debits) - SUM(credits)

Positive balance = subscriber owes money (typical)
Zero balance     = subscriber is current
Negative balance = subscriber has advance credit (overpayment)

Events that create DEBIT entries:
  - Monthly subscription invoice posted
  - Reconnection fee invoice posted
  - Late fee applied
  - Manual adjustment (charge)
  - Payment reversal (cancels a previous credit)

Events that create CREDIT entries:
  - Payment posted (cash or GCash)
  - Invoice voided (cancels a previous debit)
  - Manual adjustment (credit)
  - Write-off (bad debt)
```

---

## 3. Database Schema

```typescript
// apps/server/src/db/schema/ledger.ts

import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  pgEnum,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { serviceAccounts } from "./subscribers";
import { invoices } from "./billing";
import { payments } from "./payments";
import { users } from "./users";

export const ledgerEntryTypeEnum = pgEnum("ledger_entry_type", [
  // Debits — money owed to the company
  "invoice_posted",         // monthly subscription or reconnection fee invoice
  "late_fee",               // penalty added to an overdue invoice
  "manual_debit",           // manual charge by admin (with justification)
  "payment_reversal",       // cancelled payment — restores the debt

  // Credits — money received or obligation removed
  "payment_received",       // cash or GCash payment
  "invoice_void",           // invoice cancelled — removes the debt
  "advance_credit",         // payment exceeded invoices — credit for future use
  "advance_credit_applied", // advance credit consumed by a new invoice
  "manual_credit",          // manual credit by admin (with justification)
  "write_off",              // bad debt written off (creates zero balance but is documented)
]);

// ─── Ledger Entries ───────────────────────────────────────────────────────────
// Immutable — once created, a ledger entry is NEVER updated or deleted.
// Corrections are made through new, offsetting entries.
export const ledgerEntries = pgTable("ledger_entries", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Every ledger entry belongs to a specific service account.
  // (Not the subscriber — because each service has its own financial record.)
  serviceAccountId: uuid("service_account_id").notNull().references(() => serviceAccounts.id),

  entryType: ledgerEntryTypeEnum("entry_type").notNull(),

  // Amount in centavos (ALWAYS POSITIVE — the type field tells you if it's debit or credit)
  // Using signed integers here makes queries more complex and error-prone.
  // Better: keep amounts positive and use entry_type to determine direction.
  amountCentavos: integer("amount_centavos").notNull(),

  // Running balance AFTER this entry — pre-computed for display performance
  // Computed as: previous_running_balance +/- amountCentavos
  // (debit = add, credit = subtract)
  // This is a convenience cache — the balance can always be recomputed from scratch.
  runningBalanceCentavos: integer("running_balance_centavos").notNull(),

  // Human-readable description shown on Statement of Account
  description: text("description").notNull(),
  // e.g., "Monthly Invoice INV-2025-01-000042 — January 2025"
  // e.g., "Payment Received — OR-2025-000055 (Cash)"
  // e.g., "Invoice INV-2025-01-000042 Voided — Entered incorrectly"

  // Foreign keys to the source document — useful for drilling down from ledger to document
  // Only one of these will be populated per entry
  invoiceId: uuid("invoice_id").references(() => invoices.id),
  paymentId: uuid("payment_id").references(() => payments.id),

  // When this entry was created — the exact timestamp of the financial event
  entryDate: timestamp("entry_date", { withTimezone: true }).notNull().defaultNow(),

  // Who initiated this entry
  createdBy: uuid("created_by").notNull().references(() => users.id),
});

// ─── Relations ───────────────────────────────────────────────────────────────
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
```

---

## 4. Ledger Service

```typescript
// apps/server/src/modules/ledger/ledger.service.ts
// Functions called by billing, payment, and other modules to create ledger entries.
// Ledger entries are NEVER created directly — always through these functions.

export async function recordInvoicePosted(
  tx: DrizzleTransaction,
  invoice: InvoiceRecord,
  createdByUserId: string
): Promise<void> {
  const previousBalance = await getCurrentBalance(tx, invoice.serviceAccountId);
  const newBalance = previousBalance + invoice.totalAmountCentavos;

  await tx.insert(ledgerEntries).values({
    serviceAccountId: invoice.serviceAccountId,
    entryType: "invoice_posted",
    amountCentavos: invoice.totalAmountCentavos,
    runningBalanceCentavos: newBalance,
    description: `Invoice ${invoice.invoiceNumber} — ${getMonthYearLabel(invoice.billingPeriodMonth, invoice.billingPeriodYear)}`,
    invoiceId: invoice.id,
    createdBy: createdByUserId,
  });
}

export async function recordPaymentReceived(
  tx: DrizzleTransaction,
  payment: PaymentRecord,
  createdByUserId: string
): Promise<void> {
  const previousBalance = await getCurrentBalance(tx, payment.serviceAccountId);
  const newBalance = previousBalance - payment.amountCentavos;

  await tx.insert(ledgerEntries).values({
    serviceAccountId: payment.serviceAccountId,
    entryType: "payment_received",
    amountCentavos: payment.amountCentavos,
    runningBalanceCentavos: newBalance,
    description: `Payment Received — ${payment.receiptNumber} (${formatPaymentMethod(payment.paymentMethod)})`,
    paymentId: payment.id,
    createdBy: createdByUserId,
  });
}

export async function recordInvoiceVoided(
  tx: DrizzleTransaction,
  invoice: InvoiceRecord,
  reason: string,
  createdByUserId: string
): Promise<void> {
  const previousBalance = await getCurrentBalance(tx, invoice.serviceAccountId);
  // Voiding a debit = credit back the full amount
  const amountToReverse = invoice.remainingBalanceCentavos; // only unpaid portion
  const newBalance = previousBalance - amountToReverse;

  await tx.insert(ledgerEntries).values({
    serviceAccountId: invoice.serviceAccountId,
    entryType: "invoice_void",
    amountCentavos: amountToReverse,
    runningBalanceCentavos: newBalance,
    description: `Invoice ${invoice.invoiceNumber} Voided — ${reason}`,
    invoiceId: invoice.id,
    createdBy: createdByUserId,
  });
}

export async function recordPaymentReversal(
  tx: DrizzleTransaction,
  payment: PaymentRecord,
  reason: string,
  createdByUserId: string
): Promise<void> {
  const previousBalance = await getCurrentBalance(tx, payment.serviceAccountId);
  // Reversing a credit = debit back the full amount
  const newBalance = previousBalance + payment.amountCentavos;

  await tx.insert(ledgerEntries).values({
    serviceAccountId: payment.serviceAccountId,
    entryType: "payment_reversal",
    amountCentavos: payment.amountCentavos,
    runningBalanceCentavos: newBalance,
    description: `Payment ${payment.receiptNumber} Reversed — ${reason}`,
    paymentId: payment.id,
    createdBy: createdByUserId,
  });
}

// Gets the current balance from the most recent ledger entry (fast — O(1) query)
export async function getCurrentBalance(
  tx: DrizzleTransaction,
  serviceAccountId: string
): Promise<number> {
  const lastEntry = await tx
    .select({ runningBalanceCentavos: ledgerEntries.runningBalanceCentavos })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.serviceAccountId, serviceAccountId))
    .orderBy(desc(ledgerEntries.entryDate))
    .limit(1);

  return lastEntry[0]?.runningBalanceCentavos ?? 0; // 0 = no entries = no balance
}

// Verifies that the running balances in all ledger entries are internally consistent.
// Use this in tests and as an admin diagnostic tool.
export async function verifyLedgerIntegrity(serviceAccountId: string): Promise<{
  isValid: boolean;
  discrepancy?: number;
  lastComputedBalance: number;
  lastStoredBalance: number;
}> {
  const entries = await db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.serviceAccountId, serviceAccountId))
    .orderBy(asc(ledgerEntries.entryDate));

  let computedBalance = 0;
  for (const entry of entries) {
    const isDebit = [
      "invoice_posted", "late_fee", "manual_debit", "payment_reversal"
    ].includes(entry.entryType);

    computedBalance = isDebit
      ? computedBalance + entry.amountCentavos
      : computedBalance - entry.amountCentavos;

    if (computedBalance !== entry.runningBalanceCentavos) {
      return {
        isValid: false,
        discrepancy: computedBalance - entry.runningBalanceCentavos,
        lastComputedBalance: computedBalance,
        lastStoredBalance: entry.runningBalanceCentavos,
      };
    }
  }

  return { isValid: true, lastComputedBalance: computedBalance, lastStoredBalance: computedBalance };
}
```

---

## 5. Statement of Account

```typescript
// apps/server/src/modules/ledger/statement-of-account.service.ts
// Generates a full financial history for a service account.
// Used both for on-screen display and for PDF export.

export interface StatementOfAccountLine {
  date: string;
  description: string;
  debitCentavos: number;    // amount if this is a debit entry, 0 otherwise
  creditCentavos: number;   // amount if this is a credit entry, 0 otherwise
  balanceCentavos: number;  // running balance after this line
  referenceNumber: string;  // invoice or receipt number
}

export async function getStatementOfAccount(
  serviceAccountId: string,
  fromDate?: string,
  toDate?: string
): Promise<{
  serviceAccount: ServiceAccountRecord;
  subscriber: SubscriberRecord;
  lines: StatementOfAccountLine[];
  openingBalanceCentavos: number;
  closingBalanceCentavos: number;
  totalDebitsCentavos: number;
  totalCreditsCentavos: number;
}> {
  // All ledger entries within the date range
  const entries = await db
    .select()
    .from(ledgerEntries)
    .leftJoin(invoices, eq(ledgerEntries.invoiceId, invoices.id))
    .leftJoin(payments, eq(ledgerEntries.paymentId, payments.id))
    .where(
      and(
        eq(ledgerEntries.serviceAccountId, serviceAccountId),
        fromDate ? gte(ledgerEntries.entryDate, new Date(fromDate)) : undefined,
        toDate ? lte(ledgerEntries.entryDate, new Date(toDate)) : undefined,
      )
    )
    .orderBy(asc(ledgerEntries.entryDate));

  // Transform entries into statement lines with debit/credit columns
  const isDebitEntry = (type: string) =>
    ["invoice_posted", "late_fee", "manual_debit", "payment_reversal"].includes(type);

  const lines: StatementOfAccountLine[] = entries.map((e) => ({
    date: e.ledger_entries.entryDate.toISOString().slice(0, 10),
    description: e.ledger_entries.description,
    debitCentavos: isDebitEntry(e.ledger_entries.entryType) ? e.ledger_entries.amountCentavos : 0,
    creditCentavos: !isDebitEntry(e.ledger_entries.entryType) ? e.ledger_entries.amountCentavos : 0,
    balanceCentavos: e.ledger_entries.runningBalanceCentavos,
    referenceNumber: e.invoices?.invoiceNumber ?? e.payments?.receiptNumber ?? "",
  }));

  return {
    serviceAccount: /* ... */,
    subscriber: /* ... */,
    lines,
    openingBalanceCentavos: /* balance before fromDate */,
    closingBalanceCentavos: lines.at(-1)?.balanceCentavos ?? 0,
    totalDebitsCentavos: lines.reduce((sum, l) => sum + l.debitCentavos, 0),
    totalCreditsCentavos: lines.reduce((sum, l) => sum + l.creditCentavos, 0),
  };
}
```

---

## 6. API Endpoints

```
GET /api/service-accounts/:id/ledger         → Ledger entries (paginated, filter by date)
GET /api/service-accounts/:id/balance        → Current balance only (fast)
GET /api/service-accounts/:id/statement      → Full Statement of Account (export-ready)
GET /api/subscribers/:id/statement           → SOA for ALL service accounts of a subscriber
GET /api/ledger/verify/:serviceAccountId     → Integrity check (Admin only)
POST /api/ledger/manual-entry                → Manual debit/credit (Admin only, with justification)
```

---

## 7. UI Screens

### Service Account Ledger Page
- Header: service account number, plan, status, current balance (large, prominent)
- Balance color: green = ≤ 0 (paid up or credit), amber = low positive, red = overdue
- Ledger table: Date | Description | Debit | Credit | Balance | Reference
- Filter: date range picker
- "Export Statement" button → PDF or XLSX

### Statement of Account (Print/PDF)
- Company letterhead
- Subscriber info, service account number
- Statement period
- Opening balance
- Ledger lines with debit/credit/balance columns
- Totals row: Total Debits | Total Credits | Closing Balance
- "As of [date]" certification line

---

## 8. Acceptance Criteria

- [ ] Every invoice post creates a DEBIT ledger entry
- [ ] Every payment creates a CREDIT ledger entry
- [ ] Every invoice void creates a CREDIT ledger entry
- [ ] Every payment reversal creates a DEBIT ledger entry
- [ ] Running balance in each ledger entry is always consistent with previous balance ± amount
- [ ] `verifyLedgerIntegrity()` returns `isValid: true` for all test scenarios
- [ ] Current balance can be read from the last ledger entry (no separate balance column)
- [ ] Statement of Account shows all entries in date order with running balance
- [ ] Statement debit/credit totals reconcile to: opening + debits - credits = closing balance
- [ ] Ledger entries are NEVER updated or deleted — only new entries created
- [ ] Unit tests: balance computation, integrity check, debit/credit direction
- [ ] Integration test: invoice → payment → reversal → verify ledger sequence
