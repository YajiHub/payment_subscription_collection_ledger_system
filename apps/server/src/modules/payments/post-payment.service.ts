// Records a payment.
//
// Two things can happen here, and the difference is the payment method:
//
//   • Cash, bank transfer, cheque or other — the money is in hand. The payment is
//     allocated to the account's oldest unpaid invoices, the invoice balances move,
//     a receipt number is issued, and the ledger credits are written. All of it in
//     ONE transaction.
//   • GCash — the money is CLAIMED, not yet received. The payment is recorded in
//     `pending_verification` and NOTHING else moves: no allocation, no invoice
//     balance, no ledger entry. A verifier confirms the transfer and only then does
//     the payment post and allocate (`verifyGcashPayment`). Section 3.7: an uploaded
//     screenshot is proof of a claim and never marks an account paid.
//
// If any step fails, the whole transaction rolls back, so a failure partway can
// never leave a payment without its allocations, or an invoice balance updated
// without the payment that changed it.

import { and, asc, eq, gt, inArray } from "drizzle-orm";

import type { PostablePaymentMethod } from "@bcis/shared";
import { db, type DbExecutor } from "../../db/connection";
import { invoices } from "../../db/schema/billing";
import {
  gcashPayments,
  paymentAllocations,
  payments,
  type GcashPayment,
  type Payment,
} from "../../db/schema/payments";
import { serviceAccounts } from "../../db/schema/subscribers";
import { audit, type AuditActor } from "../../shared/audit/audit-logger";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { isUniqueViolation } from "../../shared/unique-violation";
import { recordPaymentPosted } from "../ledger/ledger.service";
import { normalizeGcashReference } from "./gcash-reference";
import {
  allocatePayment,
  applyPaymentToInvoice,
  buildManualAllocation,
  toInvoiceStatus,
  type AllocationResult,
  type ManualAllocationInput,
  type OutstandingInvoice,
  type PaymentAllocationDraft,
} from "./payment-allocation";
import { getNextReceiptNumber } from "./receipt-number.service";

export interface GcashDetailsInput {
  referenceNumber: string;
  senderGcashNumber?: string;
  senderName?: string;
  screenshotFilePath?: string;
}

export interface PostPaymentInput {
  serviceAccountId: string;
  paymentMethod: PostablePaymentMethod;
  amountCentavos: number;
  paymentDate: string;
  notes?: string;
  postedByUserId: string;
  /**
   * Who performed the post and from where, for the audit trail. Optional so a
   * non-HTTP caller (field collection) still records the user id it has.
   */
  actor?: AuditActor;
  gcash?: GcashDetailsInput;
  /**
   * S3-5: the operator's own split instead of oldest-invoice-first. Only reachable
   * through the authorized manual-allocation route, and only for a method whose
   * money is already in hand — a GCash payment is allocated when a verifier
   * confirms it.
   */
  manualAllocation?: ManualAllocationInput;
}

export interface PostPaymentResult {
  payment: Payment;
  gcash: GcashPayment | null;
  allocations: PaymentAllocationDraft[];
  allocatedCentavos: number;
  advanceCreditCentavos: number;
}

// A payment only settles invoices that are still owed. This is also what makes a
// re-posted payment safe: an invoice that is already paid is never selected, so
// the same debt cannot be paid twice.
const OUTSTANDING_INVOICE_STATUSES = ["unpaid", "partially_paid", "overdue"] as const;

/**
 * Loads the invoices this payment may settle, oldest first.
 *
 * Rows are locked FOR UPDATE so a concurrent payment cannot read the same
 * remaining balances and both allocate against them.
 */
export async function loadOutstandingInvoicesOldestFirst(
  executor: DbExecutor,
  serviceAccountId: string
): Promise<OutstandingInvoice[]> {
  return executor
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      totalAmountCentavos: invoices.totalAmountCentavos,
      paidAmountCentavos: invoices.paidAmountCentavos,
      remainingBalanceCentavos: invoices.remainingBalanceCentavos,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.serviceAccountId, serviceAccountId),
        inArray(invoices.status, [...OUTSTANDING_INVOICE_STATUSES]),
        gt(invoices.remainingBalanceCentavos, 0)
      )
    )
    .orderBy(asc(invoices.invoiceDate), asc(invoices.id))
    .for("update");
}

/** Rejects a GCash reference that has already been used, with a readable message. */
async function assertGcashReferenceIsUnused(
  executor: DbExecutor,
  normalizedReferenceNumber: string
): Promise<void> {
  const existing = await executor
    .select({ id: gcashPayments.id })
    .from(gcashPayments)
    .where(eq(gcashPayments.gcashReferenceNumber, normalizedReferenceNumber))
    .limit(1);

  if (existing.length > 0) {
    throw new ConflictError(
      `GCash reference ${normalizedReferenceNumber} has already been used. Duplicate payment rejected.`
    );
  }
}

/**
 * Writes the invoice balance changes and the allocation rows for an allocation.
 *
 * Shared by the automatic and the manual path — and by the GCash verify step that
 * posts a payment later — so the three can never apply a split differently.
 */
export async function applyAllocationToInvoices(
  executor: DbExecutor,
  paymentId: string,
  allocation: AllocationResult,
  outstandingInvoices: readonly OutstandingInvoice[]
): Promise<void> {
  for (const draft of allocation.allocations) {
    const invoice = outstandingInvoices.find((candidate) => candidate.id === draft.invoiceId);
    if (invoice === undefined) {
      continue; // impossible: an allocation only references loaded invoices
    }

    const update = applyPaymentToInvoice(invoice, draft.amountCentavos);
    await executor
      .update(invoices)
      .set({
        paidAmountCentavos: update.paidAmountCentavos,
        remainingBalanceCentavos: update.remainingBalanceCentavos,
        status: toInvoiceStatus(update),
      })
      .where(eq(invoices.id, draft.invoiceId));
  }

  if (allocation.allocations.length > 0) {
    // The bridge records how the payment was spread, and the ledger credits depend
    // on the same split.
    await executor.insert(paymentAllocations).values(
      allocation.allocations.map((draft) => ({
        paymentId,
        invoiceId: draft.invoiceId,
        allocatedAmountCentavos: draft.amountCentavos,
      }))
    );
  }
}

/**
 * Records a payment.
 *
 * A GCash payment comes back in `pending_verification`; a payment in any other
 * method comes back posted and allocated.
 */
export async function postPayment(input: PostPaymentInput): Promise<PostPaymentResult> {
  return db.transaction((tx) => postPaymentWithinTransaction(tx, input));
}

/**
 * Records a payment inside a transaction the caller already owns.
 *
 * Phase 7 records a field collection as a real payment; it needs the payment, its
 * allocations, its receipt, and its ledger credits to commit together with the
 * batch assignment that points at them, so it calls this function with its own
 * transaction instead of letting `postPayment` open a second one.
 */
export async function postPaymentWithinTransaction(
  executor: DbExecutor,
  input: PostPaymentInput
): Promise<PostPaymentResult> {
  if (!Number.isInteger(input.amountCentavos) || input.amountCentavos <= 0) {
    throw new ValidationError("Payment amount must be greater than zero");
  }

  const isGcashPayment = input.paymentMethod === "gcash";

  if (isGcashPayment && input.gcash === undefined) {
    throw new ValidationError("A GCash reference number is required for a GCash payment");
  }

  if (isGcashPayment && input.manualAllocation !== undefined) {
    throw new ValidationError(
      "A GCash payment is allocated when a verifier confirms it, so it cannot be recorded with a manual allocation"
    );
  }

  const account = await executor
    .select({ id: serviceAccounts.id })
    .from(serviceAccounts)
    .where(eq(serviceAccounts.id, input.serviceAccountId))
    .limit(1);

  if (account.length === 0) {
    throw new NotFoundError("Service account not found");
  }

  if (isGcashPayment && input.gcash !== undefined) {
    return recordGcashPaymentPendingVerification(executor, input, input.gcash);
  }

  return postAllocatedPayment(executor, input);
}

/**
 * Records a GCash payment that a verifier still has to confirm.
 *
 * Nothing financial happens here: no allocation, no invoice balance, no ledger
 * entry. The GCash reference is normalized before it is stored and before the
 * duplicate check, so a reformatted reference cannot slip past either (S12-7).
 */
async function recordGcashPaymentPendingVerification(
  executor: DbExecutor,
  input: PostPaymentInput,
  gcashDetails: GcashDetailsInput
): Promise<PostPaymentResult> {
  const normalizedReferenceNumber = normalizeGcashReference(gcashDetails.referenceNumber);

  if (normalizedReferenceNumber.length === 0) {
    throw new ValidationError("A GCash reference number is required for a GCash payment");
  }

  await assertGcashReferenceIsUnused(executor, normalizedReferenceNumber);

  const receiptNumber = await getNextReceiptNumber(executor);

  const insertedPayment = await executor
    .insert(payments)
    .values({
      receiptNumber,
      serviceAccountId: input.serviceAccountId,
      paymentMethod: input.paymentMethod,
      status: "pending_verification",
      amountCentavos: input.amountCentavos,
      allocatedCentavos: 0,
      advanceCreditCentavos: 0,
      paymentDate: input.paymentDate,
      notes: input.notes ?? null,
      postedBy: input.postedByUserId,
    })
    .returning()
    .then((rows) => rows[0]);

  if (insertedPayment === undefined) {
    throw new ValidationError("Payment could not be created");
  }

  const gcash = await insertGcashDetails(executor, insertedPayment.id, {
    ...gcashDetails,
    referenceNumber: normalizedReferenceNumber,
  });

  return {
    payment: insertedPayment,
    gcash,
    allocations: [],
    allocatedCentavos: 0,
    advanceCreditCentavos: 0,
  };
}

/**
 * Posts a payment whose money is already in hand.
 *
 * The split is either the operator's manual choice or the oldest-invoice-first
 * sweep; both satisfy allocatedCentavos + advanceCreditCentavos === amountCentavos.
 */
async function postAllocatedPayment(
  executor: DbExecutor,
  input: PostPaymentInput
): Promise<PostPaymentResult> {
  const outstandingInvoices = await loadOutstandingInvoicesOldestFirst(
    executor,
    input.serviceAccountId
  );

  const allocation =
    input.manualAllocation === undefined
      ? allocatePayment(input.amountCentavos, outstandingInvoices)
      : buildManualAllocation(input.amountCentavos, input.manualAllocation, outstandingInvoices);

  const receiptNumber = await getNextReceiptNumber(executor);

  const insertedPayment = await executor
    .insert(payments)
    .values({
      receiptNumber,
      serviceAccountId: input.serviceAccountId,
      paymentMethod: input.paymentMethod,
      amountCentavos: input.amountCentavos,
      allocatedCentavos: allocation.allocatedCentavos,
      advanceCreditCentavos: allocation.advanceCreditCentavos,
      paymentDate: input.paymentDate,
      notes: input.notes ?? null,
      postedBy: input.postedByUserId,
    })
    .returning()
    .then((rows) => rows[0]);

  if (insertedPayment === undefined) {
    throw new ValidationError("Payment could not be created");
  }

  await applyAllocationToInvoices(executor, insertedPayment.id, allocation, outstandingInvoices);
  await recordPaymentPosted(executor, insertedPayment, input.postedByUserId);

  // A manual split carries its justification into the trail, so the audit row shows
  // which invoices the operator chose and why, not just that money was posted.
  await audit.paymentPosted(
    input.manualAllocation === undefined
      ? { ...insertedPayment }
      : {
          ...insertedPayment,
          manualAllocation: {
            reason: input.manualAllocation.reason,
            allocations: allocation.allocations,
          },
        },
    input.actor ?? { userId: input.postedByUserId }
  );

  return {
    payment: insertedPayment,
    gcash: null,
    allocations: allocation.allocations,
    allocatedCentavos: allocation.allocatedCentavos,
    advanceCreditCentavos: allocation.advanceCreditCentavos,
  };
}

/**
 * Writes the GCash detail row.
 *
 * The pre-check in `recordGcashPaymentPendingVerification` covers the common case;
 * this catch covers the race where two requests pass the check at the same time.
 * Either way the caller sees a 409, never a 500.
 */
async function insertGcashDetails(
  executor: DbExecutor,
  paymentId: string,
  details: GcashDetailsInput
): Promise<GcashPayment> {
  try {
    const inserted = await executor
      .insert(gcashPayments)
      .values({
        paymentId,
        gcashReferenceNumber: details.referenceNumber,
        senderGcashNumber: details.senderGcashNumber ?? null,
        senderName: details.senderName ?? null,
        screenshotFilePath: details.screenshotFilePath ?? null,
      })
      .returning()
      .then((rows) => rows[0]);

    if (inserted === undefined) {
      throw new ConflictError("GCash details could not be saved");
    }

    return inserted;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        `GCash reference ${details.referenceNumber} has already been used. Duplicate payment rejected.`
      );
    }
    throw error;
  }
}
