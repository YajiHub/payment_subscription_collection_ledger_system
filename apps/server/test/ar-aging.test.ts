// Pure tests for the AR aging buckets.
//
// The most important assertion here is the acceptance criterion: the aging grand
// total must equal the sum of every outstanding invoice's remaining balance. The
// bucket arithmetic is a pure function, so this needs no database.

import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { classifyInvoiceAge } from "@bcis/shared";
import {
  buildAgingReport,
  type OutstandingInvoiceAgingRow,
} from "../src/modules/receivables/ar-aging.service";

/** An outstanding invoice row as the aging query returns it. */
function invoiceRow(overrides: Partial<OutstandingInvoiceAgingRow> = {}): OutstandingInvoiceAgingRow {
  return {
    invoiceId: randomUUID(),
    serviceAccountId: "account-1",
    remainingBalanceCentavos: 100000,
    dueDate: "2025-01-01",
    subscriberId: "subscriber-1",
    subscriberFirstName: "Maria",
    subscriberLastName: "Santos",
    serviceAccountNumber: "SA-20250101-00001",
    planName: "Fiber 25Mbps",
    ...overrides,
  };
}

const AS_OF = new Date("2025-02-15T00:00:00Z");

describe("classifyInvoiceAge", () => {
  it("treats a due date today or in the future as current", () => {
    expect(classifyInvoiceAge(new Date("2025-02-15T00:00:00Z"), AS_OF)).toBe("current");
    expect(classifyInvoiceAge(new Date("2025-03-01T00:00:00Z"), AS_OF)).toBe("current");
  });

  it("puts each overdue range in its own bucket at the boundaries", () => {
    expect(classifyInvoiceAge(new Date("2025-02-14T00:00:00Z"), AS_OF)).toBe("1_to_30"); // 1 day
    expect(classifyInvoiceAge(new Date("2025-01-16T00:00:00Z"), AS_OF)).toBe("1_to_30"); // 30 days
    expect(classifyInvoiceAge(new Date("2025-01-15T00:00:00Z"), AS_OF)).toBe("31_to_60"); // 31 days
    expect(classifyInvoiceAge(new Date("2024-12-17T00:00:00Z"), AS_OF)).toBe("31_to_60"); // 60 days
    expect(classifyInvoiceAge(new Date("2024-12-16T00:00:00Z"), AS_OF)).toBe("61_to_90"); // 61 days
    expect(classifyInvoiceAge(new Date("2024-11-17T00:00:00Z"), AS_OF)).toBe("61_to_90"); // 90 days
    expect(classifyInvoiceAge(new Date("2024-11-16T00:00:00Z"), AS_OF)).toBe("over_90"); // 91 days
  });
});

describe("buildAgingReport", () => {
  it("buckets invoices by account and sums each bucket", () => {
    const report = buildAgingReport(
      [
        invoiceRow({
          serviceAccountId: "account-1",
          remainingBalanceCentavos: 100000,
          dueDate: "2025-02-20",
        }),
        invoiceRow({
          serviceAccountId: "account-1",
          remainingBalanceCentavos: 50000,
          dueDate: "2025-02-01",
        }),
        invoiceRow({
          serviceAccountId: "account-1",
          remainingBalanceCentavos: 25000,
          dueDate: "2024-11-01",
        }),
        invoiceRow({
          serviceAccountId: "account-2",
          remainingBalanceCentavos: 80000,
          dueDate: "2025-02-01",
        }),
      ],
      AS_OF
    );

    expect(report.entries).toHaveLength(2);

    const accountOne = report.entries.find((entry) => entry.serviceAccountId === "account-1");
    expect(accountOne).toMatchObject({
      currentCentavos: 100000,
      bucket_1_30_centavos: 50000,
      bucket_31_60_centavos: 0,
      bucket_61_90_centavos: 0,
      over_90_centavos: 25000,
      totalOutstandingCentavos: 175000,
    });

    const accountTwo = report.entries.find((entry) => entry.serviceAccountId === "account-2");
    expect(accountTwo).toMatchObject({
      bucket_1_30_centavos: 80000,
      totalOutstandingCentavos: 80000,
    });
  });

  it("sorts the largest outstanding balance first", () => {
    const report = buildAgingReport(
      [
        invoiceRow({ serviceAccountId: "small", remainingBalanceCentavos: 10000 }),
        invoiceRow({ serviceAccountId: "large", remainingBalanceCentavos: 90000 }),
      ],
      AS_OF
    );

    expect(report.entries.map((entry) => entry.serviceAccountId)).toEqual(["large", "small"]);
  });

  it("makes the grand total equal the sum of every remaining balance", () => {
    const rows = [
      invoiceRow({ remainingBalanceCentavos: 111111, dueDate: "2025-02-20" }),
      invoiceRow({ serviceAccountId: "account-2", remainingBalanceCentavos: 222222, dueDate: "2025-01-01" }),
      invoiceRow({ serviceAccountId: "account-3", remainingBalanceCentavos: 33333, dueDate: "2024-01-01" }),
    ];

    const report = buildAgingReport(rows, AS_OF);
    const sumOfRemainingBalances = rows.reduce(
      (runningTotal, row) => runningTotal + row.remainingBalanceCentavos,
      0
    );

    expect(report.totals.grandTotal).toBe(sumOfRemainingBalances);
    expect(
      report.totals.current +
        report.totals.bucket_1_30 +
        report.totals.bucket_31_60 +
        report.totals.bucket_61_90 +
        report.totals.over_90
    ).toBe(sumOfRemainingBalances);
  });
});