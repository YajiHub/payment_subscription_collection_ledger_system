// Unit tests for the payment allocation arithmetic.
//
// These pin the most dangerous rules in Phase 5: oldest invoice first, and an
// allocation that is exhaustive — the sum of the allocations plus the advance
// credit must equal the payment amount, to the centavo, with no floats.

import { describe, expect, it } from "vitest";

import {
  allocatePayment,
  applyPaymentToInvoice,
  toInvoiceStatus,
  type OutstandingInvoice,
} from "../src/modules/payments/payment-allocation";

function invoice(overrides: Partial<OutstandingInvoice> & { id: string }): OutstandingInvoice {
  return {
    invoiceNumber: `INV-2025-01-${overrides.id}`,
    totalAmountCentavos: 99900,
    paidAmountCentavos: 0,
    remainingBalanceCentavos: 99900,
    ...overrides,
  };
}

describe("payment allocation", () => {
  it("applies an exact payment to a single invoice and marks it paid", () => {
    const result = allocatePayment(99900, [invoice({ id: "1" })]);

    expect(result.allocations).toEqual([{ invoiceId: "1", amountCentavos: 99900 }]);
    expect(result.allocatedCentavos).toBe(99900);
    expect(result.advanceCreditCentavos).toBe(0);
  });

  it("applies a partial payment and leaves the rest on the invoice", () => {
    const result = allocatePayment(40000, [invoice({ id: "1" })]);

    expect(result.allocations).toEqual([{ invoiceId: "1", amountCentavos: 40000 }]);
    expect(result.advanceCreditCentavos).toBe(0);

    const update = applyPaymentToInvoice(
      { totalAmountCentavos: 99900, paidAmountCentavos: 0, remainingBalanceCentavos: 99900 },
      40000
    );
    expect(update.remainingBalanceCentavos).toBe(59900);
    expect(toInvoiceStatus(update)).toBe("partially_paid");
  });

  it("fills the oldest invoice first, then the next", () => {
    const oldest = invoice({ id: "old", remainingBalanceCentavos: 50000 });
    const newest = invoice({ id: "new", remainingBalanceCentavos: 80000 });

    const result = allocatePayment(100000, [oldest, newest]);

    expect(result.allocations).toEqual([
      { invoiceId: "old", amountCentavos: 50000 },
      { invoiceId: "new", amountCentavos: 50000 },
    ]);
    expect(result.allocatedCentavos).toBe(100000);
    expect(result.advanceCreditCentavos).toBe(0);
  });

  it("spreads a payment across many invoices without losing a centavo", () => {
    const invoices = [
      invoice({ id: "a", remainingBalanceCentavos: 33333 }),
      invoice({ id: "b", remainingBalanceCentavos: 33333 }),
      invoice({ id: "c", remainingBalanceCentavos: 33334 }),
    ];

    const result = allocatePayment(100000, invoices);

    const allocated = result.allocations.reduce((sum, a) => sum + a.amountCentavos, 0);
    expect(allocated).toBe(result.allocatedCentavos);
    expect(result.allocatedCentavos + result.advanceCreditCentavos).toBe(100000);
    // Nothing left: the three invoices total exactly 100000.
    expect(result.advanceCreditCentavos).toBe(0);
  });

  it("turns the amount beyond every invoice into an advance credit", () => {
    const result = allocatePayment(50000, [
      invoice({ id: "a", remainingBalanceCentavos: 20000 }),
      invoice({ id: "b", remainingBalanceCentavos: 15000 }),
    ]);

    expect(result.allocatedCentavos).toBe(35000);
    expect(result.advanceCreditCentavos).toBe(15000);
    // The invariant holds for every input.
    expect(result.allocatedCentavos + result.advanceCreditCentavos).toBe(50000);
  });

  it("keeps the allocated + advance invariant across many amounts", () => {
    const invoices = [
      invoice({ id: "a", remainingBalanceCentavos: 12345 }),
      invoice({ id: "b", remainingBalanceCentavos: 67890 }),
      invoice({ id: "c", remainingBalanceCentavos: 1 }),
    ];

    for (let amount = 1; amount <= 100000; amount += 997) {
      const result = allocatePayment(amount, invoices);
      const allocated = result.allocations.reduce((sum, a) => sum + a.amountCentavos, 0);
      expect(allocated).toBe(result.allocatedCentavos);
      expect(result.allocatedCentavos + result.advanceCreditCentavos).toBe(amount);
      for (const allocation of result.allocations) {
        expect(Number.isInteger(allocation.amountCentavos)).toBe(true);
      }
    }
  });

  it("never pays a settled invoice again — re-posting cannot double-apply", () => {
    const settled = invoice({ id: "paid", remainingBalanceCentavos: 0 });
    const open = invoice({ id: "open", remainingBalanceCentavos: 10000 });

    const result = allocatePayment(10000, [settled, open]);

    expect(result.allocations).toEqual([{ invoiceId: "open", amountCentavos: 10000 }]);
  });

  it("rejects a non-integer or non-positive amount", () => {
    expect(() => allocatePayment(0, [])).toThrow(/positive integer/);
    expect(() => allocatePayment(-5, [])).toThrow(/positive integer/);
    expect(() => allocatePayment(10.5, [])).toThrow(/positive integer/);
  });

  it("marks a fully covered invoice paid and a partially covered one partially paid", () => {
    const fullyCovered = applyPaymentToInvoice(
      { totalAmountCentavos: 99900, paidAmountCentavos: 0, remainingBalanceCentavos: 99900 },
      99900
    );
    expect(fullyCovered.remainingBalanceCentavos).toBe(0);
    expect(toInvoiceStatus(fullyCovered)).toBe("paid");

    const partial = applyPaymentToInvoice(
      { totalAmountCentavos: 99900, paidAmountCentavos: 50000, remainingBalanceCentavos: 49900 },
      10000
    );
    expect(partial.remainingBalanceCentavos).toBe(39900);
    expect(toInvoiceStatus(partial)).toBe("partially_paid");
  });
});
