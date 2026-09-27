// The allocation algorithm — pure arithmetic over integer centavos.
//
// No database and no side effects, so the financial rules can be tested directly:
//
//   • Oldest invoice first. The caller passes the invoices already ordered by
//     invoice date; this function never reorders them.
//   • The payment is spread until it is exhausted. Anything left over is an
//     advance credit for the next invoice.
//   • Exhaustive and exact: SUM(allocations) + advance === the payment amount.
//     No centavo is lost, double-counted, or created.
//
// The same file holds the manual variant (S3-5): an operator names the invoices
// instead of letting the older-first sweep choose them. It obeys the SAME
// invariant — the amounts chosen plus the declared advance credit must equal the
// payment exactly — so a manual split can neither over- nor under-allocate.

import { MANUAL_ALLOCATION_REASON_MIN_LENGTH } from "@bcis/shared";

import { ValidationError } from "../../shared/errors";

/** The minimum an invoice needs to expose for allocation: what is still owed. */
export interface OutstandingInvoice {
  id: string;
  invoiceNumber: string;
  totalAmountCentavos: number;
  paidAmountCentavos: number;
  remainingBalanceCentavos: number;
}

export interface PaymentAllocationDraft {
  invoiceId: string;
  amountCentavos: number;
}

export interface AllocationResult {
  /** One entry per invoice the payment touched, oldest first. */
  allocations: PaymentAllocationDraft[];
  /** Total applied to invoices — the sum of `allocations`. */
  allocatedCentavos: number;
  /** Whatever is left over after every invoice is settled. */
  advanceCreditCentavos: number;
}

/**
 * Spreads `amountCentavos` across the outstanding invoices, oldest first.
 *
 * Returns the exact split. The invariant
 *   allocatedCentavos + advanceCreditCentavos === amountCentavos
 * holds for every input, and every produced amount is a positive integer.
 */
export function allocatePayment(
  amountCentavos: number,
  invoicesOldestFirst: readonly OutstandingInvoice[]
): AllocationResult {
  if (!Number.isInteger(amountCentavos) || amountCentavos <= 0) {
    throw new ValidationError("Payment amount must be a positive integer number of centavos");
  }

  let remainingPayment = amountCentavos;
  const allocations: PaymentAllocationDraft[] = [];

  for (const invoice of invoicesOldestFirst) {
    if (remainingPayment <= 0) {
      break;
    }

    // A settled invoice is never paid again — that is what keeps re-posting from
    // double-applying a payment that already cleared this invoice.
    if (invoice.remainingBalanceCentavos <= 0) {
      continue;
    }

    const amountToApply = Math.min(remainingPayment, invoice.remainingBalanceCentavos);
    allocations.push({ invoiceId: invoice.id, amountCentavos: amountToApply });
    remainingPayment -= amountToApply;
  }

  const allocatedCentavos = amountCentavos - remainingPayment;

  return {
    allocations,
    allocatedCentavos,
    advanceCreditCentavos: remainingPayment,
  };
}

/** The invoice columns a payment changes. */
export interface InvoiceBalance {
  totalAmountCentavos: number;
  paidAmountCentavos: number;
  remainingBalanceCentavos: number;
}

export interface InvoiceBalanceUpdate {
  paidAmountCentavos: number;
  remainingBalanceCentavos: number;
  status: "partial" | "paid";
}

/**
 * The new paid amount, remaining balance, and status after applying a payment.
 *
 * The status is deliberately returned as `"partial"` or `"paid"` rather than the
 * database values, so the caller maps it to the invoice_status enum explicitly
 * (partially_paid vs paid) and a new status cannot leak in silently.
 */
export function applyPaymentToInvoice(
  invoice: InvoiceBalance,
  amountCentavos: number
): InvoiceBalanceUpdate {
  if (!Number.isInteger(amountCentavos) || amountCentavos <= 0) {
    throw new ValidationError("Allocated amount must be a positive integer number of centavos");
  }

  if (amountCentavos > invoice.remainingBalanceCentavos) {
    throw new ValidationError("Allocated amount cannot exceed the invoice's remaining balance");
  }

  const paidAmountCentavos = invoice.paidAmountCentavos + amountCentavos;
  const remainingBalanceCentavos = invoice.totalAmountCentavos - paidAmountCentavos;

  return {
    paidAmountCentavos,
    remainingBalanceCentavos,
    status: remainingBalanceCentavos === 0 ? "paid" : "partial",
  };
}

/** Maps the allocation result's status to the invoice_status enum value. */
export function toInvoiceStatus(update: InvoiceBalanceUpdate): "paid" | "partially_paid" {
  return update.status === "paid" ? "paid" : "partially_paid";
}

// ─── Manual allocation (S3-5) ─────────────────────────────────────────────────

/** One "pay this invoice by this much" instruction from an operator. */
export interface ManualAllocationLineRequest {
  invoiceId: string;
  amountCentavos: number;
}

/** An operator's chosen split, with the leftover declared rather than guessed. */
export interface ManualAllocationInput {
  /** One entry per invoice the operator chose, in the order they chose them. */
  allocations: readonly ManualAllocationLineRequest[];
  /**
   * What the operator says is left over after the chosen invoices are settled.
   * Required, even when it is zero: it is what makes the invariant checkable, so a
   * split that quietly forgets centavos is refused instead of becoming credit.
   */
  advanceCreditCentavos: number;
  /** Why the payment was directed this way. Audited with the allocation. */
  reason: string;
}

/**
 * Builds an allocation from the invoices an operator chose.
 *
 * Refused, with a message naming the offending invoice, when:
 *   • an invoice is named twice, which would double-count one balance;
 *   • an invoice is not one this payment may settle (not outstanding, or another
 *     account's);
 *   • one invoice would receive more than it still owes (over-allocation);
 *   • the chosen amounts plus the declared advance credit do not equal the payment
 *     amount (an under- or over-allocated split).
 *
 * A valid result always satisfies
 *   SUM(allocations) + advanceCreditCentavos === amountCentavos
 * — the same invariant the automatic, oldest-first path guarantees.
 */
export function buildManualAllocation(
  amountCentavos: number,
  input: ManualAllocationInput,
  outstandingInvoices: readonly OutstandingInvoice[]
): AllocationResult {
  if (!Number.isInteger(amountCentavos) || amountCentavos <= 0) {
    throw new ValidationError("Payment amount must be a positive integer number of centavos");
  }

  if (input.reason.trim().length < MANUAL_ALLOCATION_REASON_MIN_LENGTH) {
    throw new ValidationError(
      `A manual allocation needs a reason of at least ${MANUAL_ALLOCATION_REASON_MIN_LENGTH} characters`
    );
  }

  if (!Number.isInteger(input.advanceCreditCentavos) || input.advanceCreditCentavos < 0) {
    throw new ValidationError("Declared advance credit must be zero or more centavos");
  }

  const invoiceById = new Map(outstandingInvoices.map((invoice) => [invoice.id, invoice]));
  const chosenInvoiceIds = new Set<string>();
  const allocations: PaymentAllocationDraft[] = [];
  let allocatedCentavos = 0;

  for (const line of input.allocations) {
    if (!Number.isInteger(line.amountCentavos) || line.amountCentavos <= 0) {
      throw new ValidationError("Each manual allocation must be a positive number of centavos");
    }

    if (chosenInvoiceIds.has(line.invoiceId)) {
      throw new ValidationError(`Invoice ${line.invoiceId} was chosen more than once`);
    }
    chosenInvoiceIds.add(line.invoiceId);

    const invoice = invoiceById.get(line.invoiceId);
    if (invoice === undefined) {
      throw new ValidationError(
        `Invoice ${line.invoiceId} is not an outstanding invoice of this service account`
      );
    }

    if (line.amountCentavos > invoice.remainingBalanceCentavos) {
      throw new ValidationError(
        `Invoice ${invoice.invoiceNumber} owes ${invoice.remainingBalanceCentavos} centavos; ${line.amountCentavos} would over-allocate it`
      );
    }

    allocations.push({ invoiceId: line.invoiceId, amountCentavos: line.amountCentavos });
    allocatedCentavos += line.amountCentavos;
  }

  if (allocatedCentavos + input.advanceCreditCentavos !== amountCentavos) {
    throw new ValidationError(
      `The manual allocation accounts for ${allocatedCentavos + input.advanceCreditCentavos} centavos but the payment is ${amountCentavos}; every centavo must be allocated or declared as advance credit`
    );
  }

  return {
    allocations,
    allocatedCentavos,
    advanceCreditCentavos: input.advanceCreditCentavos,
  };
}
