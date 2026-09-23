// Pure invoice arithmetic. No database, no side effects — just centavos.
//
// These functions are the single source of truth for how an invoice total is
// built, and they are what the unit tests exercise without PostgreSQL.
//
// Invariant: totalAmountCentavos === subtotalCentavos + lateFeesCentavos, and it
// also equals the sum of every line item's total. All arithmetic is integer
// centavos, so it is exact.

import { getMonthYearLabel } from "@bcis/shared";

/** One line as it will be written to the invoice_line_items table. */
export interface InvoiceLineItemDraft {
  description: string;
  quantity: number;
  unitAmountCentavos: number;
  totalAmountCentavos: number;
}

export interface MonthlyInvoiceDraft {
  subtotalCentavos: number;
  lateFeesCentavos: number;
  totalAmountCentavos: number;
  remainingBalanceCentavos: number;
  lineItems: InvoiceLineItemDraft[];
}

export interface PlanForBilling {
  name: string;
  monthlyRateCentavos: number;
}

/** Sums the line item totals. The invoice total must equal this. */
export function sumLineItemTotalsCentavos(
  lineItems: readonly { totalAmountCentavos: number }[]
): number {
  return lineItems.reduce((runningTotal, item) => runningTotal + item.totalAmountCentavos, 0);
}

/** A monthly subscription line, e.g. "Fiber 25Mbps — January 2025". */
export function buildMonthlySubscriptionLineItem(
  plan: PlanForBilling,
  year: number,
  month: number
): InvoiceLineItemDraft {
  return {
    description: `${plan.name} — ${getMonthYearLabel(month, year)}`,
    quantity: 1,
    unitAmountCentavos: plan.monthlyRateCentavos,
    totalAmountCentavos: plan.monthlyRateCentavos,
  };
}

/** A late payment fee line. */
export function buildLateFeeLineItem(
  lateFeeCentavos: number,
  appliedOnLabel: string
): InvoiceLineItemDraft {
  return {
    description: `Late Payment Fee — ${appliedOnLabel}`,
    quantity: 1,
    unitAmountCentavos: lateFeeCentavos,
    totalAmountCentavos: lateFeeCentavos,
  };
}

/** A reconnection fee line. */
export function buildReconnectionFeeLineItem(
  planName: string,
  reconnectionFeeCentavos: number
): InvoiceLineItemDraft {
  return {
    description: `Reconnection Fee — ${planName}`,
    quantity: 1,
    unitAmountCentavos: reconnectionFeeCentavos,
    totalAmountCentavos: reconnectionFeeCentavos,
  };
}

/**
 * Builds the whole monthly invoice from a plan rate.
 *
 * A fresh invoice has no late fees and nothing paid, so its remaining balance is
 * its total. Keeping this in one pure function means the billing job and its test
 * agree on the arithmetic by construction.
 */
export function buildMonthlyInvoiceDraft(
  plan: PlanForBilling,
  year: number,
  month: number
): MonthlyInvoiceDraft {
  const monthlySubscriptionLine = buildMonthlySubscriptionLineItem(plan, year, month);
  const lineItems = [monthlySubscriptionLine];
  const subtotalCentavos = sumLineItemTotalsCentavos(lineItems);
  const lateFeesCentavos = 0;
  const totalAmountCentavos = subtotalCentavos + lateFeesCentavos;

  return {
    subtotalCentavos,
    lateFeesCentavos,
    totalAmountCentavos,
    remainingBalanceCentavos: totalAmountCentavos,
    lineItems,
  };
}

/** The remaining balance after a payment, never allowed below zero. */
export function calculateRemainingBalanceCentavos(
  totalAmountCentavos: number,
  paidAmountCentavos: number
): number {
  return Math.max(totalAmountCentavos - paidAmountCentavos, 0);
}
