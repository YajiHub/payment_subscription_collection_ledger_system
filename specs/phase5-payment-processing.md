# Phase 5 — Payment Processing (Cash and GCash)

> **Prompt template for AI-assisted implementation:**
> "I am building the BCIS Subscription Billing and Collection System (Electron + React, Fastify,
> PostgreSQL, Drizzle ORM). Implement Phase 5: Payment Processing. Create the Drizzle schema for
> payments, receipts, and GCash payment records. Implement payment posting (Cash and GCash),
> payment allocation against outstanding invoices (oldest-first), receipt generation with unique
> receipt numbers, duplicate GCash reference protection, payment reversal (never deletion), and
> advance payment handling. Use the spec at specs/phase5-payment-processing.md."

---

## 1. Overview

Payment processing is the most user-facing part of the financial core. When a subscriber pays,
the cashier posts a payment, the system allocates it against outstanding invoices, and a receipt
is printed. Everything must be traceable and irreversible — deleted payments are a **critical
failure condition** per the lab specification.

**Instructor checkpoint:** CP3 — Financial Core

---

## 2. Payment Types and Business Rules

### Payment Methods
| Method | Verification | Receipt |
|--------|-------------|---------|
| **Cash** | Cashier counts and confirms | Printed immediately |
| **GCash** | Cashier enters reference number + uploads screenshot proof | Printed after manual verification |

### Core Financial Rules

1. **Oldest invoice first** — When a payment is posted, it is applied to the oldest unpaid invoice first, then the next, until the payment amount is exhausted. This is the standard accounts receivable allocation rule.
2. **Partial payments** — A payment may only partially cover an invoice. The remaining balance stays on the invoice.
3. **Exact payments** — A payment that exactly covers one or more invoices marks those invoices as PAID.
4. **Advance payments** — A payment that exceeds all outstanding invoices creates a positive "credit balance" on the service account. The credit is applied to the next invoice automatically.
5. **Duplicate GCash protection** — The GCash reference number must be unique in the database. Attempting to post the same reference number twice returns an error.
6. **Reversal not deletion** — If a payment must be corrected, a reversal record is created. The original payment row is never deleted or modified. The reversal creates a debit ledger entry that cancels the original credit.
7. **Receipt numbers** — Sequential, unique, never reused. Even voided receipts keep their number permanently.

---

## 3. Database Schema

```typescript
// apps/server/src/db/schema/payments.ts

import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  boolean,
  timestamp,
  date,
  pgEnum,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { serviceAccounts } from "./subscribers";
import { invoices } from "./billing";
import { users } from "./users";

export const paymentMethodEnum = pgEnum("payment_method", [
  "cash",
  "gcash",
  "check",       // extensible — may be added in future
  "bank_transfer",
]);

export const paymentStatusEnum = pgEnum("payment_status", [
  "posted",      // Normal, active payment
  "reversed",    // Reversed — see payment_reversals table for reason
]);

// ─── Payments ─────────────────────────────────────────────────────────────────
// One row per payment transaction. NEVER deleted.
export const payments = pgTable("payments", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Receipt number — printed on the document given to the subscriber
  // Format: OR-YYYY-XXXXXX (Official Receipt)
  receiptNumber: varchar("receipt_number", { length: 30 }).notNull().unique(),

  serviceAccountId: uuid("service_account_id").notNull().references(() => serviceAccounts.id),

  paymentMethod: paymentMethodEnum("payment_method").notNull(),
  status: paymentStatusEnum("status").notNull().default("posted"),

  // Amount received (in centavos)
  amountCentavos: integer("amount_centavos").notNull(),

  // Amount allocated to invoices vs. held as advance credit
  allocatedCentavos: integer("allocated_centavos").notNull().default(0),
  advanceCreditCentavos: integer("advance_credit_centavos").notNull().default(0),
  // Invariant: allocatedCentavos + advanceCreditCentavos === amountCentavos

  paymentDate: date("payment_date").notNull(),

  // Notes — cashier can add memo (e.g., "Paid by family member")
  notes: text("notes"),

  postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
  postedBy: uuid("posted_by").notNull().references(() => users.id),

  // Populated when the payment is reversed
  reversedAt: timestamp("reversed_at", { withTimezone: true }),
  reversedBy: uuid("reversed_by").references(() => users.id),
});

// ─── GCash Payment Details ────────────────────────────────────────────────────
// Stores GCash-specific details. One row per GCash payment.
export const gcashPayments = pgTable("gcash_payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  paymentId: uuid("payment_id").notNull().unique().references(() => payments.id),

  // The reference number from GCash — must be unique system-wide
  // This is the primary duplicate detection mechanism
  gcashReferenceNumber: varchar("gcash_reference_number", { length: 50 }).notNull().unique(),

  // Sender's GCash number/name (as reported by subscriber)
  senderGcashNumber: varchar("sender_gcash_number", { length: 20 }),
  senderName: varchar("sender_name", { length: 100 }),

  // Path to the uploaded screenshot proof file
  // Stored on the server; path is relative to the uploads directory
  screenshotFilePath: text("screenshot_file_path"),

  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  verifiedBy: uuid("verified_by").references(() => users.id),
});

// ─── Payment Allocations ──────────────────────────────────────────────────────
// Records exactly how a payment was spread across invoices.
// This is the bridge between payments and invoices.
export const paymentAllocations = pgTable("payment_allocations", {
  id: uuid("id").primaryKey().defaultRandom(),
  paymentId: uuid("payment_id").notNull().references(() => payments.id),
  invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),

  // How much of this payment was applied to this specific invoice
  allocatedAmountCentavos: integer("allocated_amount_centavos").notNull(),

  allocatedAt: timestamp("allocated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Payment Reversals ────────────────────────────────────────────────────────
// When a payment must be undone, a reversal record is created.
// The original payment row status changes to "reversed" but is NEVER deleted.
export const paymentReversals = pgTable("payment_reversals", {
  id: uuid("id").primaryKey().defaultRandom(),
  originalPaymentId: uuid("original_payment_id").notNull().references(() => payments.id),

  // Why was this reversed? Required — no silent reversals.
  reason: text("reason").notNull(),

  // The reversing transaction's receipt number (so it appears in the audit trail)
  reversalReceiptNumber: varchar("reversal_receipt_number", { length: 30 }).notNull().unique(),

  reversedBy: uuid("reversed_by").notNull().references(() => users.id),
  reversedAt: timestamp("reversed_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Relations ───────────────────────────────────────────────────────────────
export const paymentsRelations = relations(payments, ({ one, many }) => ({
  serviceAccount: one(serviceAccounts, {
    fields: [payments.serviceAccountId],
    references: [serviceAccounts.id],
  }),
  gcashDetails: one(gcashPayments, {
    fields: [payments.id],
    references: [gcashPayments.paymentId],
  }),
  allocations: many(paymentAllocations),
}));
```

---

## 4. Payment Posting Service

```typescript
// apps/server/src/modules/payments/post-payment.service.ts
// Core financial logic — every step is wrapped in a transaction.
// If any step fails, the entire payment is rolled back.

export interface PostPaymentInput {
  serviceAccountId: string;
  paymentMethod: "cash" | "gcash";
  amountCentavos: number;
  paymentDate: string; // ISO date string
  notes?: string;
  postedByUserId: string;
  // GCash only:
  gcash?: {
    referenceNumber: string;
    senderGcashNumber?: string;
    senderName?: string;
    screenshotFilePath?: string;
  };
}

export async function postPayment(input: PostPaymentInput): Promise<{
  payment: typeof payments.$inferSelect;
  allocations: Array<{ invoiceId: string; amount: number }>;
  advanceCredit: number;
}> {
  // Validate: amount must be positive
  if (input.amountCentavos <= 0) {
    throw new ValidationError("Payment amount must be greater than zero");
  }

  // Validate GCash reference uniqueness BEFORE starting the transaction
  if (input.paymentMethod === "gcash" && input.gcash?.referenceNumber) {
    const existingGcash = await db
      .select({ id: gcashPayments.id })
      .from(gcashPayments)
      .where(eq(gcashPayments.gcashReferenceNumber, input.gcash.referenceNumber))
      .limit(1);

    if (existingGcash.length > 0) {
      throw new ConflictError(
        `GCash reference ${input.gcash.referenceNumber} has already been used. ` +
        `Duplicate payment rejected.`
      );
    }
  }

  return await db.transaction(async (tx) => {
    // Step 1: Get all outstanding invoices for this service account, oldest first
    const outstandingInvoices = await tx
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.serviceAccountId, input.serviceAccountId),
          inArray(invoices.status, ["posted", "partially_paid", "overdue"]),
        )
      )
      .orderBy(asc(invoices.invoiceDate)); // oldest first — standard AR allocation

    // Step 2: Allocate payment across invoices
    let remainingPayment = input.amountCentavos;
    const allocationRecords: Array<{ invoiceId: string; amount: number }> = [];

    for (const invoice of outstandingInvoices) {
      if (remainingPayment <= 0) break;

      const amountToApply = Math.min(remainingPayment, invoice.remainingBalanceCentavos);
      remainingPayment -= amountToApply;

      // Update this invoice's paid amount and remaining balance
      const newPaidAmount = invoice.paidAmountCentavos + amountToApply;
      const newRemaining = invoice.totalAmountCentavos - newPaidAmount;
      const newStatus = newRemaining === 0 ? "paid" : "partially_paid";

      await tx
        .update(invoices)
        .set({
          paidAmountCentavos: newPaidAmount,
          remainingBalanceCentavos: newRemaining,
          status: newStatus,
        })
        .where(eq(invoices.id, invoice.id));

      allocationRecords.push({ invoiceId: invoice.id, amount: amountToApply });
    }

    // Step 3: Anything left over is an advance credit (will apply to next invoice)
    const advanceCreditCentavos = remainingPayment;

    // Step 4: Create the payment record
    const receiptNumber = await getNextReceiptNumber(tx);
    const [payment] = await tx
      .insert(payments)
      .values({
        receiptNumber,
        serviceAccountId: input.serviceAccountId,
        paymentMethod: input.paymentMethod,
        amountCentavos: input.amountCentavos,
        allocatedCentavos: input.amountCentavos - advanceCreditCentavos,
        advanceCreditCentavos,
        paymentDate: input.paymentDate,
        notes: input.notes,
        postedBy: input.postedByUserId,
      })
      .returning();

    // Step 5: Insert allocation bridge records
    if (allocationRecords.length > 0) {
      await tx.insert(paymentAllocations).values(
        allocationRecords.map((a) => ({
          paymentId: payment.id,
          invoiceId: a.invoiceId,
          allocatedAmountCentavos: a.amount,
        }))
      );
    }

    // Step 6: If GCash, insert GCash details
    if (input.paymentMethod === "gcash" && input.gcash) {
      await tx.insert(gcashPayments).values({
        paymentId: payment.id,
        gcashReferenceNumber: input.gcash.referenceNumber,
        senderGcashNumber: input.gcash.senderGcashNumber,
        senderName: input.gcash.senderName,
        screenshotFilePath: input.gcash.screenshotFilePath,
      });
    }

    // Step 7: Create ledger credit entry (Phase 6 handles this)
    await createPaymentLedgerEntry(tx, payment, input.postedByUserId);

    return { payment, allocations: allocationRecords, advanceCredit: advanceCreditCentavos };
  });
}
```

---

## 5. Payment Reversal

```typescript
// apps/server/src/modules/payments/reverse-payment.service.ts

export async function reversePayment(
  paymentId: string,
  reason: string,
  reversedByUserId: string
): Promise<void> {
  if (reason.trim().length < 10) {
    throw new ValidationError("Reversal reason must be at least 10 characters");
  }

  await db.transaction(async (tx) => {
    const [payment] = await tx
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId))
      .limit(1);

    if (!payment) throw new NotFoundError("Payment not found");
    if (payment.status === "reversed") {
      throw new ConflictError("Payment has already been reversed");
    }

    // 1. Get all allocations from this payment
    const allocations = await tx
      .select()
      .from(paymentAllocations)
      .where(eq(paymentAllocations.paymentId, paymentId));

    // 2. Restore each invoice's paid/remaining amounts
    for (const allocation of allocations) {
      const [invoice] = await tx
        .select()
        .from(invoices)
        .where(eq(invoices.id, allocation.invoiceId))
        .limit(1);

      const restoredPaid = invoice.paidAmountCentavos - allocation.allocatedAmountCentavos;
      const restoredRemaining = invoice.totalAmountCentavos - restoredPaid;

      await tx
        .update(invoices)
        .set({
          paidAmountCentavos: restoredPaid,
          remainingBalanceCentavos: restoredRemaining,
          status: restoredRemaining > 0 ? "posted" : "paid",
        })
        .where(eq(invoices.id, invoice.id));
    }

    // 3. Mark original payment as reversed
    await tx
      .update(payments)
      .set({ status: "reversed", reversedAt: new Date(), reversedBy: reversedByUserId })
      .where(eq(payments.id, paymentId));

    // 4. Create reversal record
    const reversalReceiptNumber = await getNextReceiptNumber(tx);
    await tx.insert(paymentReversals).values({
      originalPaymentId: paymentId,
      reason,
      reversalReceiptNumber,
      reversedBy: reversedByUserId,
    });

    // 5. Create a debit ledger entry to cancel the original credit
    await createReversalLedgerEntry(tx, payment, reason, reversedByUserId);
  });
}
```

---

## 6. Receipt Number Generation

```typescript
// Format: OR-YYYY-XXXXXX (Official Receipt)
// OR-2025-000042
// Reversal receipts: RV-2025-000042

export async function getNextReceiptNumber(tx: DrizzleTransaction): Promise<string> {
  const year = new Date().getFullYear();
  // Use a PostgreSQL sequence or MAX+1 to get next number atomically
  // Using MAX+1 wrapped in a transaction is safe because the transaction holds a row lock
  const result = await tx.execute(
    sql`SELECT COALESCE(MAX(CAST(SPLIT_PART(receipt_number, '-', 3) AS INTEGER)), 0) + 1
        AS next_seq FROM payments WHERE receipt_number LIKE ${`OR-${year}-%`}`
  );
  const seq = String(result.rows[0].next_seq).padStart(6, "0");
  return `OR-${year}-${seq}`;
}
```

---

## 7. File Upload for GCash Screenshots

```typescript
// Electron handles file selection; the file path is sent to the API
// Server stores files in: uploads/gcash-proofs/YYYY/MM/

// Security rules for file uploads:
// 1. Only JPEG, PNG, WebP accepted
// 2. Maximum file size: 5MB
// 3. File is renamed to: gcash-{paymentId}-{timestamp}.{ext} — no original name kept
// 4. File path stored in database; actual file on server disk
// 5. Files are served only to authenticated users via API route, never from public URL
```

---

## 8. API Endpoints

```
POST /api/payments                         → Post payment (Cash or GCash) — Cashier, Admin
GET  /api/payments                         → List payments (filter by date, method, status)
GET  /api/payments/:id                     → Get payment with allocations
GET  /api/payments/receipt/:receiptNumber  → Get by receipt number
POST /api/payments/:id/reverse             → Reverse payment (reason required) — Admin only
GET  /api/service-accounts/:id/payments    → All payments for a service account

POST /api/payments/gcash/upload-screenshot → Upload GCash proof screenshot
```

---

## 9. UI Screens

### Post Payment Screen (Cashier)
- Service account lookup (search by account number, subscriber name)
- Shows: outstanding invoices table, current balance, advance credit balance
- Payment amount input
- Payment method toggle: Cash | GCash
- GCash fields (shown when GCash selected): Reference Number, Sender Name, Sender Number, Upload Screenshot button
- Preview allocation: "This payment will be applied as follows: Invoice #INV-2025-01-000001 → ₱999.00 | Advance Credit → ₱0.00"
- "Post Payment" button → shows confirmation dialog
- After posting: shows receipt number + "Print Receipt" button

### Payment History Screen
- Filter: date range, payment method, status
- Table: Receipt # | Date | Subscriber | Service | Method | Amount | Status | Posted By
- Click row → Payment Detail page
- "Reverse Payment" button (Admin only) → requires reason text

### Receipt Preview / Print
- ISP company header (name, address, logo)
- Receipt number, date, cashier name
- Subscriber and service account info
- Payment method (Cash / GCash + reference number)
- Invoice allocation breakdown
- Total received, advance credit
- Signature line for cashier and subscriber

---

## 10. Acceptance Criteria

- [ ] Posting a cash payment allocates to oldest invoice first
- [ ] Posting a payment that exceeds all invoices creates an advance credit entry
- [ ] Advance credit is applied to the next generated invoice
- [ ] GCash payment with a duplicate reference number is rejected with a clear error message
- [ ] Receipt numbers follow OR-YYYY-XXXXXX format and are unique
- [ ] Payment reversal restores invoice balances and marks payment as "reversed"
- [ ] Reversed payments still appear in the payment history
- [ ] Original payment row is NEVER deleted from the database
- [ ] Cashier cannot reverse payments (only Admin can)
- [ ] GCash screenshot is accepted only for JPEG/PNG/WebP formats under 5MB
- [ ] Invoice status changes to PAID when remaining balance = 0
- [ ] Invoice status changes to PARTIALLY_PAID when partial payment applied
- [ ] Unit tests: allocation logic, advance credit, reversal math
- [ ] Integration test: post → verify invoice status → reverse → verify restoration
