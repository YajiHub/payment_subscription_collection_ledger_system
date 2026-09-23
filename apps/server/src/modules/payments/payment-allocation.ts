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
