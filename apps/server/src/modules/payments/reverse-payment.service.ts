// Reverses a payment. The original payment row is NEVER deleted or otherwise
// rewritten: its status becomes "reversed", a payment_reversals row records why,
// and a debit ledger entry cancels the credit the payment had created.
//
// Restoring the invoice balances and writing the reversal record happen in one
// transaction, so a reversed payment is always fully reversed.
//
// GCash (S3-6). A payment that a verifier confirmed is reversed exactly like cash:
// the status change is what reverses the verification state, and every read of
// "money received" keys off `status = posted`, so a reversed payment cannot still
// read as verified-and-posted (`gcashVerificationStatus` in payments.service
// reports it as `reversed`). The verifier's identity and timestamp stay on the
// gcash_payments row as history — that is provenance, not money, and the audit
// trail must keep showing who confirmed the transfer.
//
// A GCash payment that was never verified has no posted amount to reverse, so
// reversing it is refused with a message pointing at rejection. That is deliberate:
// `recordPaymentReversed` writes a debit to cancel a credit, and a pending payment
// never created one — running it would invent a debit out of nothing.

import { eq } from "drizzle-orm";

import { db, type DbExecutor } from "../../db/connection";
import { invoices } from "../../db/schema/billing";
import { paymentAllocations, paymentReversals, payments } from "../../db/schema/payments";
import { audit, type AuditActor } from "../../shared/audit/audit-logger";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { recordPaymentReversed } from "../ledger/ledger.service";
import { getNextReversalReceiptNumber } from "./receipt-number.service";

export interface ReversePaymentResult {
  paymentId: string;
  /** The original payment's receipt number, so the audit trail names the payment. */
  receiptNumber: string;
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
  reversedByUserId: string,
  actor?: AuditActor
): Promise<ReversePaymentResult> {
  return db.transaction((tx) =>
    reversePaymentWithinTransaction(tx, paymentId, reason, reversedByUserId, actor)
  );
}

/**
 * Reverses a payment inside a transaction the caller already owns.
 *
 * Phase 7 voids a recorded field collection by reversing the payment it created;
 * that reversal and the assignment update must commit together, so it calls this
 * function with its own transaction instead of letting `reversePayment` open a
 * second one.
 *
 * The audit entry is written HERE, not in the route handler, so every caller that
 * reverses a payment — the office route and the field-collection void alike — is
 * guaranteed to leave a `payment.reversed` row on the trail.
 */
export async function reversePaymentWithinTransaction(
  executor: DbExecutor,
  paymentId: string,
  reason: string,
  reversedByUserId: string,
  actor?: AuditActor
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

  // A GCash payment that no verifier confirmed never posted, so there is no credit
  // to cancel and no allocation to restore. Its own workflow step is rejection.
  if (payment.status === "pending_verification") {
    throw new ConflictError(
      "This GCash payment is still awaiting verification and has not been posted, so there is nothing to reverse. Reject it instead."
    );
  }

  if (payment.status === "rejected") {
    throw new ConflictError(
      "This GCash payment was rejected and never posted, so there is nothing to reverse."
    );
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
  await audit.paymentReversed(
    paymentId,
    payment.receiptNumber,
    reason,
    actor ?? { userId: reversedByUserId }
  );

  return { paymentId, receiptNumber: payment.receiptNumber, reversalReceiptNumber, reversedAt };
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
        status: restoredRemaining === 0 ? "paid" : "unpaid",
      })
      .where(eq(invoices.id, allocation.invoiceId));
  }
}
