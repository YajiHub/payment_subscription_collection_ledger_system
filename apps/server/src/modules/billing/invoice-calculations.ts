// Pure invoice arithmetic. No database, no side effects — just centavos.
//
// These functions are the single source of truth for how an invoice total is
// built, and they are what the unit tests exercise without PostgreSQL.
//
// Invariant: totalAmountCentavos === subtotalCentavos + lateFeesCentavos, and it
// also equals the sum of every line item's total. All arithmetic is integer
// centavos, so it is exact.
//
// ROUNDING RULE (section 3.4 / S2-3)
// --------------------------------
// A percentage-based line (a discount, for example) may not divide evenly into
// centavos. The rule is: round the exact result HALF AWAY FROM ZERO, apply the
// rounding ONCE PER LINE, then sum the already-rounded line totals. Rounding is
// done in integer arithmetic only — no float is ever introduced — so the same
// inputs always produce the same cents on every machine.

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

/** An installation fee line, charged once when a service account is installed. */
export function buildInstallationFeeLineItem(
  planName: string,
  installationFeeCentavos: number
): InvoiceLineItemDraft {
  return {
    description: `Installation Fee — ${planName}`,
    quantity: 1,
    unitAmountCentavos: installationFeeCentavos,
    totalAmountCentavos: installationFeeCentavos,
  };
}

/**
 * A discount line. The amount is stored as a NEGATIVE line total so it reduces the
 * invoice when the line totals are summed, exactly like any other charge math.
 */
export function buildDiscountLineItem(
  reason: string,
  discountCentavos: number
): InvoiceLineItemDraft {
  return {
    description: `Discount — ${reason}`,
    quantity: 1,
    unitAmountCentavos: -discountCentavos,
    totalAmountCentavos: -discountCentavos,
  };
}

/**
 * Divides two integers and rounds the exact result half away from zero.
 *
 * Integer arithmetic only, so no float ever touches a money value:
 * `(2 * |n| + |d|) / (2 * |d|)` is the half-away-from-zero rounding of `|n| / |d|`.
 * Signs are applied afterwards, so 1/2 → 1, -1/2 → -1 and 3/2 → 2.
 */
export function divideRoundingHalfAwayFromZero(numerator: number, denominator: number): number {
  if (denominator === 0) {
    throw new Error("Cannot divide a money amount by zero");
  }

  const isNegative = numerator < 0 !== denominator < 0;
  const absoluteNumerator = Math.abs(numerator);
  const absoluteDenominator = Math.abs(denominator);
  const roundedMagnitude = Math.floor(
    (2 * absoluteNumerator + absoluteDenominator) / (2 * absoluteDenominator)
  );

  return isNegative ? -roundedMagnitude : roundedMagnitude;
}

/**
 * A percentage of an amount, in centavos, rounded half away from zero.
 *
 * The rate is an integer number of basis points (1% = 100 bp), so the arithmetic
 * stays in whole numbers: centavos * bp / 10 000.
 */
export function calculatePercentageOfCentavos(
  baseCentavos: number,
  rateBasisPoints: number
): number {
  return divideRoundingHalfAwayFromZero(baseCentavos * rateBasisPoints, 10_000);
}

/**
 * Builds an invoice draft from an explicit set of line items.
 *
 * Every line total is already rounded, so the sum is exact. A negative discount
 * line reduces the subtotal; late fees are added on top. Used by the installation
 * fee and discount paths, which build their own line sets.
 */
export function buildInvoiceDraftFromLineItems(
  lineItems: readonly InvoiceLineItemDraft[],
  lateFeesCentavos = 0
): MonthlyInvoiceDraft {
  const subtotalCentavos = sumLineItemTotalsCentavos(lineItems);
  const totalAmountCentavos = subtotalCentavos + lateFeesCentavos;

  return {
    subtotalCentavos,
    lateFeesCentavos,
    totalAmountCentavos,
    remainingBalanceCentavos: totalAmountCentavos,
    lineItems: [...lineItems],
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
