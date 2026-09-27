// Tests for the invoice arithmetic. These are the numbers the billing job and the
// late-fee job rely on, so they are pinned down here without a database.

import { describe, expect, it } from "vitest";

import {
  buildDiscountLineItem,
  buildInstallationFeeLineItem,
  buildInvoiceDraftFromLineItems,
  buildLateFeeLineItem,
  buildMonthlyInvoiceDraft,
  buildMonthlySubscriptionLineItem,
  buildReconnectionFeeLineItem,
  calculatePercentageOfCentavos,
  calculateRemainingBalanceCentavos,
  divideRoundingHalfAwayFromZero,
  sumLineItemTotalsCentavos,
} from "../src/modules/billing/invoice-calculations";

const FIBER_PLAN = { name: "Fiber 25Mbps", monthlyRateCentavos: 99900 };

describe("invoice calculations", () => {
  it("stores every amount as an integer number of centavos", () => {
    const draft = buildMonthlyInvoiceDraft(FIBER_PLAN, 2025, 1);

    expect(Number.isInteger(draft.subtotalCentavos)).toBe(true);
    expect(Number.isInteger(draft.totalAmountCentavos)).toBe(true);
    for (const lineItem of draft.lineItems) {
      expect(Number.isInteger(lineItem.unitAmountCentavos)).toBe(true);
      expect(Number.isInteger(lineItem.totalAmountCentavos)).toBe(true);
    }
  });

  it("makes the invoice total equal the sum of its line items", () => {
    const draft = buildMonthlyInvoiceDraft(FIBER_PLAN, 2025, 1);

    expect(draft.totalAmountCentavos).toBe(sumLineItemTotalsCentavos(draft.lineItems));
    expect(draft.totalAmountCentavos).toBe(99900);
    expect(draft.remainingBalanceCentavos).toBe(99900);
  });

  it("names the subscription line with the plan and billing period", () => {
    const lineItem = buildMonthlySubscriptionLineItem(FIBER_PLAN, 2025, 1);
    expect(lineItem.description).toBe("Fiber 25Mbps — January 2025");
    expect(lineItem.quantity).toBe(1);
  });

  it("adds a late fee as a line item whose total is the fee", () => {
    const lineItem = buildLateFeeLineItem(5000, "2025-02-16");
    expect(lineItem.description).toBe("Late Payment Fee — 2025-02-16");
    expect(lineItem.totalAmountCentavos).toBe(5000);
  });

  it("adds a reconnection fee as a line item whose total is the fee", () => {
    const lineItem = buildReconnectionFeeLineItem("Fiber 25Mbps", 50000);
    expect(lineItem.description).toBe("Reconnection Fee — Fiber 25Mbps");
    expect(lineItem.totalAmountCentavos).toBe(50000);
  });

  it("never lets a remaining balance fall below zero", () => {
    expect(calculateRemainingBalanceCentavos(99900, 40000)).toBe(59900);
    expect(calculateRemainingBalanceCentavos(100, 200)).toBe(0);
  });

  it("adds an installation fee as a first-class line item", () => {
    const lineItem = buildInstallationFeeLineItem("Fiber 25Mbps", 60000);
    expect(lineItem.description).toBe("Installation Fee — Fiber 25Mbps");
    expect(lineItem.quantity).toBe(1);
    expect(lineItem.unitAmountCentavos).toBe(60000);
    expect(lineItem.totalAmountCentavos).toBe(60000);
  });

  it("adds a discount as a NEGATIVE line item so it reduces the total", () => {
    const lineItem = buildDiscountLineItem("Senior citizen", 10000);
    expect(lineItem.description).toBe("Discount — Senior citizen");
    expect(lineItem.unitAmountCentavos).toBe(-10000);
    expect(lineItem.totalAmountCentavos).toBe(-10000);

    const draft = buildInvoiceDraftFromLineItems([
      buildMonthlySubscriptionLineItem(
        { name: "Fiber 25Mbps", monthlyRateCentavos: 99900 },
        2025,
        1
      ),
      lineItem,
    ]);
    expect(draft.subtotalCentavos).toBe(89900);
    expect(draft.totalAmountCentavos).toBe(89900);
    expect(draft.totalAmountCentavos).toBe(sumLineItemTotalsCentavos(draft.lineItems));
  });

  it("rounds half away from zero, using integer arithmetic only", () => {
    // Exact halves round away from zero, in both directions.
    expect(divideRoundingHalfAwayFromZero(1, 2)).toBe(1);
    expect(divideRoundingHalfAwayFromZero(-1, 2)).toBe(-1);
    expect(divideRoundingHalfAwayFromZero(5, 2)).toBe(3);
    expect(divideRoundingHalfAwayFromZero(-5, 2)).toBe(-3);
    // Below and above a half round to the nearer integer as usual.
    expect(divideRoundingHalfAwayFromZero(3, 2)).toBe(2);
    expect(divideRoundingHalfAwayFromZero(4, 2)).toBe(2);
    // Every result is an integer, so no float ever reaches a money value.
    expect(Number.isInteger(divideRoundingHalfAwayFromZero(99999, 2))).toBe(true);
  });

  it("applies a basis-point rate once per line and throws on a zero divisor", () => {
    // 3.33% of 99999 = 3329.9667 → 3330.
    expect(calculatePercentageOfCentavos(99999, 333)).toBe(3330);
    // 10% of 10000 is exact.
    expect(calculatePercentageOfCentavos(10000, 1000)).toBe(1000);
    // A half centavo rounds away from zero.
    expect(calculatePercentageOfCentavos(50, 100)).toBe(1);
    expect(() => divideRoundingHalfAwayFromZero(1, 0)).toThrow(/zero/i);
  });

  it("rounds each line on its own and sums the rounded lines, never the bases", () => {
    // Hand-computed. 25% (2500 bp) of 10002 centavos is 2500.5, which rounds half
    // away from zero to 2501 on EVERY line. Three lines therefore round to 7503.
    const perLineDiscounts = [10002, 10002, 10002].map((base) =>
      calculatePercentageOfCentavos(base, 2500)
    );
    expect(perLineDiscounts).toEqual([2501, 2501, 2501]);

    const summedAfterRounding = perLineDiscounts.reduce((total, line) => total + line, 0);
    expect(summedAfterRounding).toBe(7503);

    // Rounding the 30006 base once instead would give 7502: the rule explicitly
    // forbids that order, so the two must differ here.
    expect(calculatePercentageOfCentavos(30006, 2500)).toBe(7502);
    expect(summedAfterRounding).not.toBe(calculatePercentageOfCentavos(30006, 2500));

    // Every rounded line is an integer centavo, so the sum is exact.
    for (const discount of perLineDiscounts) {
      expect(Number.isInteger(discount)).toBe(true);
    }

    const draft = buildInvoiceDraftFromLineItems(
      perLineDiscounts.map((discount, index) =>
        buildDiscountLineItem(`Line ${index + 1}`, discount)
      )
    );
    expect(draft.totalAmountCentavos).toBe(-7503);
    expect(draft.totalAmountCentavos).toBe(sumLineItemTotalsCentavos(draft.lineItems));
  });
});
