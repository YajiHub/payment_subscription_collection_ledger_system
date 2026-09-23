// Tests for the invoice arithmetic. These are the numbers the billing job and the
// late-fee job rely on, so they are pinned down here without a database.

import { describe, expect, it } from "vitest";

import {
  buildLateFeeLineItem,
  buildMonthlyInvoiceDraft,
  buildMonthlySubscriptionLineItem,
  buildReconnectionFeeLineItem,
  calculateRemainingBalanceCentavos,
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
});
