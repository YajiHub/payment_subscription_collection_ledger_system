// Pure tests for the overdue account summarising.
//
// These pin the "consecutive overdue months" calculation and the two filters
// ("no payment in N days", "at least N consecutive overdue months") without a
// database.

import { describe, expect, it } from "vitest";

import {
  countConsecutiveOverdueMonths,
  summarizeOverdueAccounts,
  type LastPaymentRow,
  type OverdueInvoiceRow,
} from "../src/modules/receivables/overdue-accounts.service";
import { accountFilterConditions } from "../src/modules/reports/report-filters";

const AS_OF = new Date("2025-02-15T00:00:00Z");

function overdueInvoice(overrides: Partial<OverdueInvoiceRow> = {}): OverdueInvoiceRow {
  return {
    serviceAccountId: "account-1",
    remainingBalanceCentavos: 99900,
    billingPeriodYear: 2025,
    billingPeriodMonth: 1,
    dueDate: "2025-01-15",
    invoiceNumber: "INV-2025-0001",
    serviceAccountNumber: "SA-20250101-00001",
    subscriberId: "subscriber-1",
    subscriberFirstName: "Maria",
    subscriberLastName: "Santos",
    planName: "Fiber 25Mbps",
    storedConsecutiveOverdueMonths: 0,
    collectorId: "collector-1",
    collectorName: "Rico Reyes",
    areaName: "Route 1",
    ...overrides,
  };
}

describe("countConsecutiveOverdueMonths", () => {
  it("counts an unbroken run ending at the most recent month", () => {
    expect(
      countConsecutiveOverdueMonths([
        { year: 2025, month: 1 },
        { year: 2024, month: 12 },
        { year: 2024, month: 11 },
      ])
    ).toBe(3);
  });

  it("breaks the run at a gap", () => {
    expect(
      countConsecutiveOverdueMonths([
        { year: 2025, month: 1 },
        { year: 2024, month: 11 },
        { year: 2024, month: 10 },
      ])
    ).toBe(1);
  });

  it("counts across a year boundary", () => {
    expect(
      countConsecutiveOverdueMonths([
        { year: 2025, month: 1 },
        { year: 2024, month: 12 },
      ])
    ).toBe(2);
  });

  it("returns zero when there are no monthly periods", () => {
    expect(countConsecutiveOverdueMonths([])).toBe(0);
  });
});

describe("summarizeOverdueAccounts", () => {
  it("sums overdue invoices per account and reports the collector and last payment", () => {
    const lastPayments: LastPaymentRow[] = [{ serviceAccountId: "account-1", paymentDate: "2024-10-01" }];

    const accounts = summarizeOverdueAccounts(
      [
        overdueInvoice({ remainingBalanceCentavos: 50000 }),
        overdueInvoice({ remainingBalanceCentavos: 25000, billingPeriodYear: 2024, billingPeriodMonth: 12 }),
      ],
      lastPayments,
      {},
      AS_OF
    );

    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      serviceAccountId: "account-1",
      totalOverdueCentavos: 75000,
      consecutiveOverdueMonths: 2,
      collectorName: "Rico Reyes",
      lastPaymentDate: "2024-10-01",
    });
  });

  it("filters out accounts overdue for fewer months than requested", () => {
    const accounts = summarizeOverdueAccounts(
      [overdueInvoice()],
      [],
      { minConsecutiveOverdueMonths: 2 },
      AS_OF
    );

    expect(accounts).toEqual([]);
  });

  it("keeps accounts with no payment in the requested window", () => {
    const invoiceRows = [overdueInvoice()];

    // Last paid 137 days ago (2024-10-01 → 2025-02-15) — included for 90 days.
    const oldPayment = summarizeOverdueAccounts(
      invoiceRows,
      [{ serviceAccountId: "account-1", paymentDate: "2024-10-01" }],
      { noPaymentInDays: 90 },
      AS_OF
    );
    expect(oldPayment).toHaveLength(1);

    // A payment 3 days ago excludes the account for a 90-day filter.
    const recentPayment = summarizeOverdueAccounts(
      invoiceRows,
      [{ serviceAccountId: "account-1", paymentDate: "2025-02-12" }],
      { noPaymentInDays: 90 },
      AS_OF
    );
    expect(recentPayment).toEqual([]);

    // Never paid — always qualifies.
    const neverPaid = summarizeOverdueAccounts(invoiceRows, [], { noPaymentInDays: 1 }, AS_OF);
    expect(neverPaid).toHaveLength(1);
  });

  it("falls back to the stored consecutive-month count for one-off invoices", () => {
    const accounts = summarizeOverdueAccounts(
      [overdueInvoice({ billingPeriodYear: null, billingPeriodMonth: null, storedConsecutiveOverdueMonths: 4 })],
      [],
      {},
      AS_OF
    );

    expect(accounts[0]?.consecutiveOverdueMonths).toBe(4);
  });

  it("reports the area and the oldest unpaid invoice number", () => {
    const accounts = summarizeOverdueAccounts(
      [
        overdueInvoice({ dueDate: "2025-01-15", invoiceNumber: "INV-2025-0001" }),
        overdueInvoice({
          dueDate: "2024-11-15",
          invoiceNumber: "INV-2024-0011",
          billingPeriodYear: 2024,
          billingPeriodMonth: 11,
        }),
      ],
      [],
      {},
      AS_OF
    );

    expect(accounts[0]).toMatchObject({
      areaName: "Route 1",
      oldestUnpaidInvoiceNumber: "INV-2024-0011",
      oldestUnpaidDueDate: "2024-11-15",
    });
  });

  it("filters by delinquency age from the OLDEST unpaid invoice", () => {
    const invoiceRows = [
      overdueInvoice({ dueDate: "2025-01-15", invoiceNumber: "INV-2025-0001" }),
      overdueInvoice({
        dueDate: "2024-11-15",
        invoiceNumber: "INV-2024-0011",
        billingPeriodYear: 2024,
        billingPeriodMonth: 11,
      }),
    ];

    // 2025-02-15 minus 2024-11-15 is 92 days; minus 2025-01-15 is 31 days.
    expect(summarizeOverdueAccounts(invoiceRows, [], { minOverdueDays: 90 }, AS_OF)).toHaveLength(1);
    expect(summarizeOverdueAccounts(invoiceRows, [], { minOverdueDays: 93 }, AS_OF)).toEqual([]);
    expect(summarizeOverdueAccounts(invoiceRows, [], { minOverdueDays: 31 }, AS_OF)).toHaveLength(1);
  });
});

// S4-5/S4-6: the overdue list and AR aging share ONE place where a filter becomes a
// SQL condition (`accountFilterConditions`), so each new filter must produce its own
// condition — proving the filter reaches the query instead of being accepted and
// ignored, which is the exact defect the audit found.
describe("overdue and aging account filters reach the SQL", () => {
  it("adds one condition per collector, area, plan and service-type filter", () => {
    expect(accountFilterConditions({})).toHaveLength(0);
    expect(accountFilterConditions({ collectorId: "c1" })).toHaveLength(1);
    expect(accountFilterConditions({ areaId: "a1" })).toHaveLength(1);
    expect(accountFilterConditions({ planId: "p1" })).toHaveLength(1);
    expect(accountFilterConditions({ serviceType: "internet" })).toHaveLength(1);
    expect(
      accountFilterConditions({
        collectorId: "c1",
        areaId: "a1",
        planId: "p1",
        serviceType: "internet",
      })
    ).toHaveLength(4);
  });
});