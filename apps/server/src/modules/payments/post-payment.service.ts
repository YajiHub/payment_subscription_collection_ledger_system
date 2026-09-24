// Posts a payment: allocates it, updates invoice balances, issues a receipt, and
// writes the ledger credits — all in ONE transaction.
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
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { isUniqueViolation } from "../../shared/unique-violation";
import { recordPaymentPosted } from "../ledger/ledger.service";
import {
  allocatePayment,
  applyPaymentToInvoice,
  toInvoiceStatus,
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
  gcash?: GcashDetailsInput;
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
const OUTSTANDING_INVOICE_STATUSES = ["posted", "partially_paid", "overdue"] as const;

/**
 * Loads the invoices this payment may settle, oldest first.
 *
 * Rows are locked FOR UPDATE so a concurrent payment cannot read the same
 * remaining balances and both allocate against them.
 */
async function loadOutstandingInvoicesOldestFirst(
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
  referenceNumber: string
): Promise<void> {
  const existing = await executor
    .select({ id: gcashPayments.id })
    .from(gcashPayments)
    .where(eq(gcashPayments.gcashReferenceNumber, referenceNumber))
    .limit(1);

  if (existing.length > 0) {
    throw new ConflictError(
      `GCash reference ${referenceNumber} has already been used. Duplicate payment rejected.`
    );
  }
}

/**
 * Posts a Cash or GCash payment.
 *
 * The allocation is oldest-invoice-first and exhaustive; the returned split always
 * satisfies allocatedCentavos + advanceCreditCentavos === amountCentavos.
 */
export async function postPayment(input: PostPaymentInput): Promise<PostPaymentResult> {
  return db.transaction((tx) => postPaymentWithinTransaction(tx, input));
}

/**
 * Posts a payment inside a transaction the caller already owns.
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

  if (input.paymentMethod === "gcash" && input.gcash === undefined) {
    throw new ValidationError("A GCash reference number is required for a GCash payment");
  }

  const account = await executor
    .select({ id: serviceAccounts.id })
    .from(serviceAccounts)
    .where(eq(serviceAccounts.id, input.serviceAccountId))
    .limit(1);

  if (account.length === 0) {
    throw new NotFoundError("Service account not found");
  }

  if (input.paymentMethod === "gcash" && input.gcash !== undefined) {
    await assertGcashReferenceIsUnused(executor, input.gcash.referenceNumber);
  }

  const outstandingInvoices = await loadOutstandingInvoicesOldestFirst(
    executor,
    input.serviceAccountId
  );
  const allocation = allocatePayment(input.amountCentavos, outstandingInvoices);

  // Apply the allocation to each invoice's cached paid/remaining amounts.
  for (const draft of allocation.allocations) {
    const invoice = outstandingInvoices.find((candidate) => candidate.id === draft.invoiceId);
    if (invoice === undefined) {
      continue; // impossible: the allocation only references loaded invoices
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

  if (allocation.allocations.length > 0) {
    // The bridge records how the payment was spread, and the ledger credits below
    // depend on the same split.
    await executor.insert(paymentAllocations).values(
      allocation.allocations.map((draft) => ({
        paymentId: insertedPayment.id,
        invoiceId: draft.invoiceId,
        allocatedAmountCentavos: draft.amountCentavos,
      }))
    );
  }

  let gcash: GcashPayment | null = null;
  if (input.paymentMethod === "gcash" && input.gcash !== undefined) {
    gcash = await insertGcashDetails(executor, insertedPayment.id, input.gcash);
  }

  await recordPaymentPosted(executor, insertedPayment, input.postedByUserId);

  return {
    payment: insertedPayment,
    gcash,
    allocations: allocation.allocations,
    allocatedCentavos: allocation.allocatedCentavos,
    advanceCreditCentavos: allocation.advanceCreditCentavos,
  };
}

/**
 * Writes the GCash detail row.
 *
 * The pre-check in `postPayment` covers the common case; this catch covers the
 * race where two requests pass the check at the same time. Either way the caller
 * sees a 409, never a 500.
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
