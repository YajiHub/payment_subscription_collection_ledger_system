// Reverses a payment. The original payment row is NEVER deleted or otherwise
// rewritten: its status becomes "reversed", a payment_reversals row records why,
// and a debit ledger entry cancels the credit the payment had created.
//
// Restoring the invoice balances and writing the reversal record happen in one
// transaction, so a reversed payment is always fully reversed.

import { eq } from "drizzle-orm";

import { db, type DbExecutor } from "../../db/connection";
import { invoices } from "../../db/schema/billing";
import { paymentAllocations, paymentReversals, payments } from "../../db/schema/payments";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { recordPaymentReversed } from "../ledger/ledger.service";
import { getNextReversalReceiptNumber } from "./receipt-number.service";

export interface ReversePaymentResult {
  paymentId: string;
  reversalReceiptNumber: string;
  reversedAt: Date;
}

/**
 * Reverses a payment by id.
 *
 * Admin-only at the route level. A reason of at least 10 characters is required,
 * so there are no silent reversals.
 */
export async function reversePayment(
  paymentId: string,
  reason: string,
  reversedByUserId: string
): Promise<ReversePaymentResult> {
  return db.transaction((tx) =>
    reversePaymentWithinTransaction(tx, paymentId, reason, reversedByUserId)
  );
}

/**
 * Reverses a payment inside a transaction the caller already owns.
 *
 * Phase 7 voids a recorded field collection by reversing the payment it created;
 * that reversal and the assignment update must commit together, so it calls this
 * function with its own transaction instead of letting `reversePayment` open a
 * second one.
 */
export async function reversePaymentWithinTransaction(
  executor: DbExecutor,
  paymentId: string,
  reason: string,
  reversedByUserId: string
): Promise<ReversePaymentResult> {
  if (reason.trim().length < 10) {
    throw new ValidationError("Reversal reason must be at least 10 characters");
  }

  const payment = await executor
    .select()
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1)
    .for("update")
    .then((rows) => rows[0]);

  if (payment === undefined) {
    throw new NotFoundError("Payment not found");
  }

  if (payment.status === "reversed") {
    throw new ConflictError("Payment has already been reversed");
  }

  await restoreInvoiceBalances(executor, paymentId);

  const reversedAt = new Date();
  await executor
    .update(payments)
    .set({ status: "reversed", reversedAt, reversedBy: reversedByUserId })
    .where(eq(payments.id, paymentId));

  const reversalReceiptNumber = await getNextReversalReceiptNumber(executor);
  await executor.insert(paymentReversals).values({
    originalPaymentId: paymentId,
    reason,
    reversalReceiptNumber,
    reversedBy: reversedByUserId,
  });

  await recordPaymentReversed(executor, payment, reason, reversedByUserId);

  return { paymentId, reversalReceiptNumber, reversedAt };
}

/**
 * Removes this payment's allocations from each invoice it touched.
 *
 * Each invoice's paid amount drops by exactly what this payment applied, so the
 * remaining balance returns to what it was and the net effect on the invoice is
 * zero. An invoice that still has other payments keeps its partially-paid status.
 */
async function restoreInvoiceBalances(executor: DbExecutor, paymentId: string): Promise<void> {
  const allocations = await executor
    .select({
      invoiceId: paymentAllocations.invoiceId,
      allocatedAmountCentavos: paymentAllocations.allocatedAmountCentavos,
    })
    .from(paymentAllocations)
    .where(eq(paymentAllocations.paymentId, paymentId));

  for (const allocation of allocations) {
    const invoice = await executor
      .select({
        id: invoices.id,
        totalAmountCentavos: invoices.totalAmountCentavos,
        paidAmountCentavos: invoices.paidAmountCentavos,
      })
      .from(invoices)
      .where(eq(invoices.id, allocation.invoiceId))
      .limit(1)
      .for("update")
      .then((rows) => rows[0]);

    if (invoice === undefined) {
      continue; // an invoice can never be deleted, so this is defensive only
    }

    const restoredPaid = invoice.paidAmountCentavos - allocation.allocatedAmountCentavos;
    const restoredRemaining = Math.max(invoice.totalAmountCentavos - restoredPaid, 0);

    await executor
      .update(invoices)
      .set({
        paidAmountCentavos: restoredPaid,
        remainingBalanceCentavos: restoredRemaining,
        status: restoredRemaining === 0 ? "paid" : "posted",
      })
      .where(eq(invoices.id, allocation.invoiceId));
  }
}
