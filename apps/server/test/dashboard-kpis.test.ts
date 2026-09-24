// Pure tests for the management dashboard's KPI arithmetic.
//
// The dashboard is read as a statement of fact, so these tests pin the three ways
// it can lie:
//
//   • a voided invoice or a reversed payment counted as revenue;
//   • a calendar-month range off by one day at either end;
//   • an overdue figure that disagrees with the AR aging report about the same
//     invoice, most easily at the 30-day and 90-day boundaries.
//
// No database is involved: `buildDashboardKpis` takes the rows a loader fetched.

import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildDashboardKpis,
  computeCollectionRatePercent,
  type DashboardSnapshot,
  type MonthlyInvoiceRow,
  type MonthlyPaymentRow,
  type ServiceAccountCountRow,
} from "../src/modules/dashboard/dashboard.service";
import {
  buildAgingReport,
  type OutstandingInvoiceAgingRow,
} from "../src/modules/receivables/ar-aging.service";

const BUSINESS_DAY = "2025-04-01";

/** An empty snapshot: a fresh installation must produce all zeros. */
function emptySnapshot(): DashboardSnapshot {
  return {
    serviceAccounts: [],
    monthInvoices: [],
    monthPayments: [],
    outstandingInvoices: [],
    batches: [],
    latestBillingRun: null,
  };
}

/** A stored service account, reduced to the fields the KPI counts read. */
function accountRow(overrides: Partial<ServiceAccountCountRow> = {}): ServiceAccountCountRow {
  return {
    status: "active",
    // Built from local calendar fields on purpose: `formatDateOnly` reads the local
    // day, so a UTC-built date would move the account to another month in some
    // timezones and make this test lie about the range it is checking.
    createdAt: new Date(2025, 3, 15, 10, 0),
    ...overrides,
  };
}

function invoiceRow(overrides: Partial<MonthlyInvoiceRow> = {}): MonthlyInvoiceRow {
  return {
    status: "posted",
    invoiceDate: "2025-04-05",
    totalAmountCentavos: 100000,
    paidAmountCentavos: 0,
    remainingBalanceCentavos: 100000,
    ...overrides,
  };
}

function paymentRow(overrides: Partial<MonthlyPaymentRow> = {}): MonthlyPaymentRow {
  return {
    status: "posted",
    paymentDate: "2025-04-05",
    paymentMethod: "cash",
    amountCentavos: 50000,
    ...overrides,
  };
}

/** An outstanding invoice as the AR aging query returns it. */
function outstandingRow(
  overrides: Partial<OutstandingInvoiceAgingRow> = {}
): OutstandingInvoiceAgingRow {
  return {
    invoiceId: randomUUID(),
    serviceAccountId: randomUUID(),
    remainingBalanceCentavos: 100000,
    dueDate: "2025-04-01",
    subscriberId: randomUUID(),
    subscriberFirstName: "Maria",
    subscriberLastName: "Santos",
    serviceAccountNumber: "SA-20250101-00001",
    planName: "Fiber 25Mbps",
    ...overrides,
  };
}

describe("buildDashboardKpis on an empty database", () => {
  it("reports zeros rather than nulls or crashes", () => {
    expect(buildDashboardKpis(emptySnapshot(), BUSINESS_DAY)).toEqual({
      totalActiveServiceAccounts: 0,
      newServiceAccountsThisMonth: 0,
      suspendedAccounts: 0,
      terminatedAccounts: 0,
      totalInvoicedThisMonthCentavos: 0,
      totalCollectedThisMonthCentavos: 0,
      collectionRatePercent: 0,
      totalOutstandingArCentavos: 0,
      overdueOver30DaysCentavos: 0,
      overdueOver90DaysCentavos: 0,
      openCollectorBatches: 0,
      submittedBatchesPendingReconciliation: 0,
      lastBillingRunDate: null,
      lastBillingRunAccountsCount: null,
    });
  });
});

describe("computeCollectionRatePercent", () => {
  it("reports 0 when nothing was invoiced instead of dividing by zero", () => {
    expect(computeCollectionRatePercent(0, 12345)).toBe(0);
  });

  it("computes a percentage to two decimals", () => {
    expect(computeCollectionRatePercent(300000, 150000)).toBe(50);
    expect(computeCollectionRatePercent(300000, 100000)).toBe(33.33);
    expect(computeCollectionRatePercent(300000, 300000)).toBe(100);
  });
});

describe("subscriber metrics", () => {
  it("counts the accounts that actually hold each status", () => {
    const kpis = buildDashboardKpis(
      {
        ...emptySnapshot(),
        serviceAccounts: [
          accountRow({ status: "active" }),
          accountRow({ status: "active" }),
          accountRow({ status: "suspended" }),
          accountRow({ status: "terminated" }),
          accountRow({ status: "pending" }),
        ],
      },
      BUSINESS_DAY
    );

    // The counts must equal the rows they claim to count — including the two
    // accounts that deliberately belong to no counter.
    expect(kpis.totalActiveServiceAccounts).toBe(2);
    expect(kpis.suspendedAccounts).toBe(1);
    expect(kpis.terminatedAccounts).toBe(1);
  });

  it("counts only the accounts created inside the current month", () => {
    const kpis = buildDashboardKpis(
      {
        ...emptySnapshot(),
        serviceAccounts: [
          accountRow({ createdAt: new Date(2025, 3, 1, 0, 0) }), // first day of April
          accountRow({ createdAt: new Date(2025, 3, 30, 23, 59) }), // last day of April
          accountRow({ createdAt: new Date(2025, 2, 31, 23, 59) }), // March — excluded
          accountRow({ createdAt: new Date(2025, 4, 1, 0, 0) }), // May — excluded
        ],
      },
      BUSINESS_DAY
    );

    expect(kpis.newServiceAccountsThisMonth).toBe(2);
  });
});

describe("revenue metrics", () => {
  it("sums the invoices dated inside the current calendar month and excludes voided ones", () => {
    const kpis = buildDashboardKpis(
      {
        ...emptySnapshot(),
        monthInvoices: [
          invoiceRow({ invoiceDate: "2025-04-01", totalAmountCentavos: 100000 }),
          invoiceRow({ invoiceDate: "2025-04-30", totalAmountCentavos: 50000 }),
          invoiceRow({ invoiceDate: "2025-04-15", totalAmountCentavos: 900000, status: "void" }),
          // Outside the month: the loader narrows by date, and the rule re-checks it.
          invoiceRow({ invoiceDate: "2025-03-31", totalAmountCentavos: 700000 }),
          invoiceRow({ invoiceDate: "2025-05-01", totalAmountCentavos: 800000 }),
        ],
      },
      BUSINESS_DAY
    );

    expect(kpis.totalInvoicedThisMonthCentavos).toBe(150000);
  });

  it("sums posted payments and excludes reversed ones", () => {
    const kpis = buildDashboardKpis(
      {
        ...emptySnapshot(),
        monthPayments: [
          paymentRow({ paymentDate: "2025-04-01", amountCentavos: 25000 }),
          paymentRow({ paymentDate: "2025-04-30", amountCentavos: 15000, paymentMethod: "gcash" }),
          paymentRow({ paymentDate: "2025-04-10", amountCentavos: 990000, status: "reversed" }),
          paymentRow({ paymentDate: "2025-03-31", amountCentavos: 770000 }),
        ],
      },
      BUSINESS_DAY
    );

    expect(kpis.totalCollectedThisMonthCentavos).toBe(40000);
    expect(kpis.collectionRatePercent).toBe(0); // nothing invoiced, so no rate
  });

  it("derives the collection rate from the two totals it reports", () => {
    const kpis = buildDashboardKpis(
      {
        ...emptySnapshot(),
        monthInvoices: [invoiceRow({ totalAmountCentavos: 300000 })],
        monthPayments: [paymentRow({ amountCentavos: 100000 })],
      },
      BUSINESS_DAY
    );

    expect(kpis.totalInvoicedThisMonthCentavos).toBe(300000);
    expect(kpis.totalCollectedThisMonthCentavos).toBe(100000);
    expect(kpis.collectionRatePercent).toBe(33.33);
  });
});

describe("AR metrics", () => {
  it("makes the outstanding total equal the sum of every remaining balance", () => {
    const outstandingInvoices = [
      outstandingRow({ remainingBalanceCentavos: 111111, dueDate: "2025-04-20" }),
      outstandingRow({ remainingBalanceCentavos: 222222, dueDate: "2025-03-01" }),
      outstandingRow({ remainingBalanceCentavos: 333333, dueDate: "2024-01-01" }),
    ];

    const kpis = buildDashboardKpis({ ...emptySnapshot(), outstandingInvoices }, BUSINESS_DAY);
    const sumOfRemainingBalances = outstandingInvoices.reduce(
      (runningTotal, invoice) => runningTotal + invoice.remainingBalanceCentavos,
      0
    );

    expect(kpis.totalOutstandingArCentavos).toBe(sumOfRemainingBalances);
  });

  it("agrees with the AR aging report about the same invoices", () => {
    const outstandingInvoices = [
      outstandingRow({ remainingBalanceCentavos: 50000, dueDate: "2025-04-20" }), // current
      outstandingRow({ remainingBalanceCentavos: 60000, dueDate: "2025-03-15" }), // 1-30
      outstandingRow({ remainingBalanceCentavos: 70000, dueDate: "2025-02-15" }), // 31-60
      outstandingRow({ remainingBalanceCentavos: 80000, dueDate: "2025-01-15" }), // 61-90
      outstandingRow({ remainingBalanceCentavos: 90000, dueDate: "2024-12-15" }), // 90+
    ];

    const kpis = buildDashboardKpis({ ...emptySnapshot(), outstandingInvoices }, BUSINESS_DAY);
    const aging = buildAgingReport(outstandingInvoices, new Date("2025-04-01T00:00:00Z"));

    expect(kpis.totalOutstandingArCentavos).toBe(aging.totals.grandTotal);
    // "Over 30 days" is everything past the 1-30 bucket, so exactly 31 days overdue
    // is included and exactly 30 days overdue is not.
    expect(kpis.overdueOver30DaysCentavos).toBe(
      aging.totals.bucket_31_60 + aging.totals.bucket_61_90 + aging.totals.over_90
    );
    expect(kpis.overdueOver90DaysCentavos).toBe(aging.totals.over_90);
  });

  it("places the 30-day, 31-day, 90-day, and 91-day boundaries in the right bucket", () => {
    // 2025-04-01 minus 30 days is 2025-03-02; minus 31 is 2025-03-01.
    const thirtyDaysPastDue = outstandingRow({
      remainingBalanceCentavos: 1000,
      dueDate: "2025-03-02",
    });
    const thirtyOneDaysPastDue = outstandingRow({
      remainingBalanceCentavos: 2000,
      dueDate: "2025-03-01",
    });

    const atThirty = buildDashboardKpis(
      { ...emptySnapshot(), outstandingInvoices: [thirtyDaysPastDue] },
      BUSINESS_DAY
    );
    const atThirtyOne = buildDashboardKpis(
      { ...emptySnapshot(), outstandingInvoices: [thirtyOneDaysPastDue] },
      BUSINESS_DAY
    );

    expect(atThirty.overdueOver30DaysCentavos).toBe(0);
    expect(atThirtyOne.overdueOver30DaysCentavos).toBe(2000);

    // 2025-04-01 minus 90 days is 2025-01-01; minus 91 is 2024-12-31.
    const ninetyDaysPastDue = outstandingRow({
      remainingBalanceCentavos: 3000,
      dueDate: "2025-01-01",
    });
    const ninetyOneDaysPastDue = outstandingRow({
      remainingBalanceCentavos: 4000,
      dueDate: "2024-12-31",
    });

    const atNinety = buildDashboardKpis(
      { ...emptySnapshot(), outstandingInvoices: [ninetyDaysPastDue] },
      BUSINESS_DAY
    );
    const atNinetyOne = buildDashboardKpis(
      { ...emptySnapshot(), outstandingInvoices: [ninetyOneDaysPastDue] },
      BUSINESS_DAY
    );

    expect(atNinety.overdueOver90DaysCentavos).toBe(0);
    expect(atNinety.overdueOver30DaysCentavos).toBe(3000); // 61-90 is still "over 30"
    expect(atNinetyOne.overdueOver90DaysCentavos).toBe(4000);
  });

  it("does not treat a voided invoice as an outstanding balance", () => {
    // A voided invoice has already been reversed out of the ledger, so the aging
    // loader never returns it. An empty outstanding set is therefore the honest
    // "nothing owed" answer even while voided rows exist in the ledger history.
    const kpis = buildDashboardKpis(
      { ...emptySnapshot(), monthInvoices: [invoiceRow({ status: "void" })] },
      BUSINESS_DAY
    );

    expect(kpis.totalOutstandingArCentavos).toBe(0);
    expect(kpis.totalInvoicedThisMonthCentavos).toBe(0);
  });
});

describe("collection operations and the last billing run", () => {
  it("counts open and submitted batches from the rows it was given", () => {
    const kpis = buildDashboardKpis(
      {
        ...emptySnapshot(),
        batches: [
          { status: "open" },
          { status: "open" },
          { status: "submitted" },
          { status: "reconciled" },
          { status: "cancelled" },
        ],
      },
      BUSINESS_DAY
    );

    expect(kpis.openCollectorBatches).toBe(2);
    expect(kpis.submittedBatchesPendingReconciliation).toBe(1);
  });

  it("reports the latest billing run, and nulls when none has ever run", () => {
    const withRun = buildDashboardKpis(
      {
        ...emptySnapshot(),
        latestBillingRun: { ranAt: new Date(2025, 3, 2, 9, 30), totalServiceAccountsProcessed: 42 },
      },
      BUSINESS_DAY
    );

    expect(withRun.lastBillingRunDate).toBe("2025-04-02");
    expect(withRun.lastBillingRunAccountsCount).toBe(42);

    const withoutRun = buildDashboardKpis(emptySnapshot(), BUSINESS_DAY);
    expect(withoutRun.lastBillingRunDate).toBeNull();
    expect(withoutRun.lastBillingRunAccountsCount).toBeNull();
  });
});
