// Hand-computed arithmetic tests for the report families added by S6-1 and S6-5.
//
// Every expectation below is written out by hand from the fixture — a peso amount
// worked out on paper — rather than taken from whatever the code happened to return.
// A snapshot of the code's own output would pass even when the code is wrong, which
// is exactly what a report test must not do.
//
// A report is a statement of fact about money, so each test also pins the invariant
// that matters for that report: the period totals add up to the grand total, the
// group totals add up to the whole, and a reversed, voided, or cancelled record
// counts for nothing.

import { describe, expect, it } from "vitest";

import {
  buildAnnualCollectionReport,
  buildWeeklyCollectionReport,
  type CollectionSummaryPaymentRow,
} from "../src/modules/reports/collection-summary.service";
import {
  buildRevenueReport,
  UNASSIGNED_AREA_NAME,
  type RevenueInvoiceRow,
} from "../src/modules/reports/revenue.service";
import {
  buildCollectorAssignmentReport,
  buildCollectorPerformanceReport,
  withAssignedAccountCounts,
  type CollectorAssignmentLine,
  type CollectorBatchRow,
  type CollectorPaymentRow,
} from "../src/modules/reports/collector-reports.service";
import {
  buildPaymentAdjustmentReport,
  buildVoidedReceiptReport,
  type PaymentAdjustmentRow,
} from "../src/modules/reports/payment-adjustment.service";
import {
  buildAuditLogReport,
  buildUserActivityReport,
  SYSTEM_ACTOR_USERNAME,
  type AuditReportRow,
} from "../src/modules/reports/audit-reports.service";
import {
  buildSubscriberMasterListReport,
  type SubscriberMasterListRow,
} from "../src/modules/reports/subscriber-master-list.service";
import {
  MAX_REPORT_EXPORT_ROWS,
  capReportRows,
  truncationNotice,
} from "../src/modules/reports/report-limits";
import { monthRange, weekRange, yearRange } from "../src/modules/reports/report-filters";

/** A payment row as the collection-summary query returns it. */
function collectionPaymentRow(
  overrides: Partial<CollectionSummaryPaymentRow> = {}
): CollectionSummaryPaymentRow {
  return {
    paymentDate: "2025-01-20",
    paymentMethod: "cash",
    status: "posted",
    amountCentavos: 10000,
    ...overrides,
  };
}

/** An invoice row as the revenue query returns it. */
function revenueInvoiceRow(overrides: Partial<RevenueInvoiceRow> = {}): RevenueInvoiceRow {
  return {
    invoiceDate: "2025-01-10",
    planName: "Fiber 25Mbps",
    serviceType: "internet",
    areaName: "Poblacion",
    totalAmountCentavos: 100000,
    paidAmountCentavos: 40000,
    remainingBalanceCentavos: 60000,
    status: "partially_paid",
    ...overrides,
  };
}

/** One line of the collector assignment report. */
function assignmentLine(overrides: Partial<CollectorAssignmentLine> = {}): CollectorAssignmentLine {
  return {
    collectorId: "collector-a",
    collectorName: "Ana Cruz",
    subscriberName: "Santos, Maria",
    serviceAccountNumber: "SA-20250101-00001",
    planName: "Fiber 25Mbps",
    serviceType: "internet",
    areaName: "Poblacion",
    accountStatus: "active",
    ...overrides,
  };
}

/** One reversal row, shared by the adjustment and voided-receipt reports. */
function adjustmentRow(overrides: Partial<PaymentAdjustmentRow> = {}): PaymentAdjustmentRow {
  return {
    receiptNumber: "OR-2025-000001",
    reversalReceiptNumber: "RV-2025-000001",
    paymentDate: "2025-01-10",
    reversedAt: new Date("2025-01-20T03:00:00Z"),
    reason: "Duplicate posting",
    reversedByName: "Ana Cruz",
    paymentMethod: "cash",
    amountCentavos: 10000,
    subscriberName: "Santos, Maria",
    serviceAccountNumber: "SA-20250101-00001",
    collectorId: null,
    collectorName: null,
    ...overrides,
  };
}

/** One audit row, shared by the user-activity and audit-trail reports. */
function auditRow(overrides: Partial<AuditReportRow> = {}): AuditReportRow {
  return {
    performedAt: new Date("2025-01-15T02:00:00Z"),
    performedBy: "user-1",
    performedByUsername: "ana.cruz",
    action: "payment.posted",
    entityType: "payment",
    entityId: "payment-1",
    description: "Payment OR-2025-000001 posted",
    clientIpAddress: "10.0.0.5",
    ...overrides,
  };
}

describe("weekly collection summary (R7)", () => {
  it("totals each day by hand and keeps a quiet day visible as zeros", () => {
    const report = buildWeeklyCollectionReport(
      [
        collectionPaymentRow({ paymentDate: "2025-01-20", amountCentavos: 10000 }),
        collectionPaymentRow({
          paymentDate: "2025-01-20",
          paymentMethod: "gcash",
          amountCentavos: 5000,
        }),
        // A reversed payment is not money in the drawer.
        collectionPaymentRow({
          paymentDate: "2025-01-21",
          amountCentavos: 999999,
          status: "reversed",
        }),
        collectionPaymentRow({ paymentDate: "2025-01-26", amountCentavos: 25000 }),
      ],
      { fromDate: "2025-01-20", toDate: "2025-01-26" }
    );

    // Seven periods, including the days with nothing.
    expect(report.periods.map((period) => period.periodKey)).toEqual([
      "2025-01-20",
      "2025-01-21",
      "2025-01-22",
      "2025-01-23",
      "2025-01-24",
      "2025-01-25",
      "2025-01-26",
    ]);

    expect(report.periods[0]?.totals).toEqual({
      paymentCount: 2,
      cashTotalCentavos: 10000,
      gcashTotalCentavos: 5000,
      grandTotalCentavos: 15000,
    });
    expect(report.periods[1]?.totals).toEqual({
      paymentCount: 0,
      cashTotalCentavos: 0,
      gcashTotalCentavos: 0,
      grandTotalCentavos: 0,
    });
    expect(report.periods[6]?.totals).toEqual({
      paymentCount: 1,
      cashTotalCentavos: 25000,
      gcashTotalCentavos: 0,
      grandTotalCentavos: 25000,
    });

    // 10000 cash + 5000 GCash + 25000 cash, and the reversed 999999 counts for nothing.
    expect(report.totals).toEqual({
      paymentCount: 3,
      cashTotalCentavos: 35000,
      gcashTotalCentavos: 5000,
      grandTotalCentavos: 40000,
    });
    expect(report.weekStartDate).toBe("2025-01-20");
  });

  it("sums the periods to the grand total it prints", () => {
    const report = buildWeeklyCollectionReport(
      [
        collectionPaymentRow({ paymentDate: "2025-01-20", amountCentavos: 12345 }),
        collectionPaymentRow({ paymentDate: "2025-01-23", amountCentavos: 67890 }),
      ],
      { fromDate: "2025-01-20", toDate: "2025-01-26" }
    );

    const periodGrandTotal = report.periods.reduce(
      (sum, period) => sum + period.totals.grandTotalCentavos,
      0
    );
    expect(periodGrandTotal).toBe(80235);
    expect(report.totals.grandTotalCentavos).toBe(80235);
  });
});

describe("annual collection summary (R8)", () => {
  it("totals each month by hand and lists all twelve months", () => {
    const report = buildAnnualCollectionReport(
      [
        collectionPaymentRow({ paymentDate: "2025-01-05", amountCentavos: 100000 }),
        collectionPaymentRow({
          paymentDate: "2025-03-10",
          paymentMethod: "gcash",
          amountCentavos: 50000,
        }),
        collectionPaymentRow({ paymentDate: "2025-03-20", amountCentavos: 25000 }),
      ],
      2025
    );

    expect(report.periods).toHaveLength(12);
    expect(report.periods[0]?.periodLabel).toBe("January 2025");
    expect(report.periods[0]?.totals.grandTotalCentavos).toBe(100000);
    expect(report.periods[1]?.periodLabel).toBe("February 2025");
    expect(report.periods[1]?.totals.grandTotalCentavos).toBe(0);
    expect(report.periods[2]?.periodLabel).toBe("March 2025");
    expect(report.periods[2]?.totals).toEqual({
      paymentCount: 2,
      cashTotalCentavos: 25000,
      gcashTotalCentavos: 50000,
      grandTotalCentavos: 75000,
    });

    expect(report.totals).toEqual({
      paymentCount: 3,
      cashTotalCentavos: 125000,
      gcashTotalCentavos: 50000,
      grandTotalCentavos: 175000,
    });
  });
});

describe("revenue by plan, service type, and area (R9-R11)", () => {
  const rows: RevenueInvoiceRow[] = [
    revenueInvoiceRow({
      planName: "Fiber 25Mbps",
      serviceType: "internet",
      areaName: "Poblacion",
      totalAmountCentavos: 100000,
      paidAmountCentavos: 40000,
      remainingBalanceCentavos: 60000,
    }),
    revenueInvoiceRow({
      planName: "Fiber 25Mbps",
      serviceType: "internet",
      areaName: "Poblacion",
      totalAmountCentavos: 50000,
      paidAmountCentavos: 50000,
      remainingBalanceCentavos: 0,
      status: "paid",
    }),
    revenueInvoiceRow({
      planName: "Cable Basic",
      serviceType: "cable_tv",
      areaName: null,
      totalAmountCentavos: 30000,
      paidAmountCentavos: 0,
      remainingBalanceCentavos: 30000,
      status: "posted",
    }),
    // A voided invoice is not revenue and must not appear anywhere.
    revenueInvoiceRow({
      planName: "Cable Basic",
      serviceType: "cable_tv",
      areaName: "Poblacion",
      totalAmountCentavos: 777700,
      paidAmountCentavos: 0,
      remainingBalanceCentavos: 777700,
      status: "void",
    }),
  ];

  const range = { fromDate: "2025-01-01", toDate: "2025-01-31" };

  it("groups the same invoices by plan", () => {
    const report = buildRevenueReport(rows, "plan", range);

    expect(report.groups).toHaveLength(2);
    expect(report.groups[0]).toEqual({
      groupKey: "Fiber 25Mbps",
      groupLabel: "Fiber 25Mbps",
      invoiceCount: 2,
      billedCentavos: 150000,
      collectedCentavos: 90000,
      outstandingCentavos: 60000,
    });
    expect(report.groups[1]).toEqual({
      groupKey: "Cable Basic",
      groupLabel: "Cable Basic",
      invoiceCount: 1,
      billedCentavos: 30000,
      collectedCentavos: 0,
      outstandingCentavos: 30000,
    });

    // The voided 777700 is excluded from the grand total.
    expect(report.totals).toMatchObject({
      invoiceCount: 3,
      billedCentavos: 180000,
      collectedCentavos: 90000,
      outstandingCentavos: 90000,
    });
  });

  it("groups the same invoices by service type", () => {
    const report = buildRevenueReport(rows, "service_type", range);

    expect(report.groups.map((group) => [group.groupLabel, group.billedCentavos])).toEqual([
      ["Internet", 150000],
      ["Cable TV", 30000],
    ]);
  });

  it("groups the same invoices by area, naming an accountless area Unassigned", () => {
    const report = buildRevenueReport(rows, "area", range);

    expect(report.groups.map((group) => [group.groupLabel, group.billedCentavos])).toEqual([
      ["Poblacion", 150000],
      [UNASSIGNED_AREA_NAME, 30000],
    ]);
  });
});

describe("collector assignment (R12)", () => {
  it("counts the accounts, collectors, and areas it lists", () => {
    const report = buildCollectorAssignmentReport([
      assignmentLine({ collectorId: "b", collectorName: "Ben Reyes", areaName: "Poblacion" }),
      assignmentLine({
        collectorId: "a",
        collectorName: "Ana Cruz",
        serviceAccountNumber: "SA-20250101-00002",
        areaName: "San Roque",
      }),
      assignmentLine({
        collectorId: null,
        collectorName: "Unassigned",
        serviceAccountNumber: "SA-20250101-00003",
        areaName: "Poblacion",
      }),
    ]);

    expect(report.accountCount).toBe(3);
    expect(report.collectorCount).toBe(3); // two collectors plus Unassigned
    expect(report.areaCount).toBe(2);
    // Sorted by collector name, so two runs agree.
    expect(report.lines.map((line) => line.collectorName)).toEqual([
      "Ana Cruz",
      "Ben Reyes",
      "Unassigned",
    ]);
  });
});

describe("collector performance (R13)", () => {
  const paymentRows: CollectorPaymentRow[] = [
    { collectorId: "a", collectorName: "Ana Cruz", paymentMethod: "cash", amountCentavos: 10000 },
    { collectorId: "a", collectorName: "Ana Cruz", paymentMethod: "gcash", amountCentavos: 5000 },
    {
      collectorId: null,
      collectorName: null,
      paymentMethod: "cash",
      amountCentavos: 20000,
    },
  ];

  const batchRows: CollectorBatchRow[] = [
    {
      collectorId: "a",
      collectorName: "Ana Cruz",
      expectedRemittanceCentavos: 15000,
      actualRemittanceCentavos: 14000,
      varianceCentavos: -1000,
    },
    // Ben has no payment in the range, so his batch is not attributed to anyone.
    {
      collectorId: "b",
      collectorName: "Ben Reyes",
      expectedRemittanceCentavos: 990000,
      actualRemittanceCentavos: 0,
      varianceCentavos: -990000,
    },
  ];

  const range = { fromDate: "2025-01-01", toDate: "2025-01-31" };

  it("sums each collector's collections and joins their remittance to it", () => {
    const report = buildCollectorPerformanceReport(paymentRows, batchRows, range);

    // Unassigned collected more (20000) than Ana (15000), so it sorts first.
    expect(report.groups.map((group) => group.collectorName)).toEqual(["Unassigned", "Ana Cruz"]);

    const ana = report.groups.find((group) => group.collectorId === "a");
    expect(ana).toEqual({
      collectorId: "a",
      collectorName: "Ana Cruz",
      assignedAccountCount: 0,
      paymentCount: 2,
      collectedCentavos: 15000,
      cashCentavos: 10000,
      gcashCentavos: 5000,
      batchCount: 1,
      expectedRemittanceCentavos: 15000,
      actualRemittanceCentavos: 14000,
      varianceCentavos: -1000,
    });

    const unassigned = report.groups.find((group) => group.collectorId === null);
    expect(unassigned).toMatchObject({
      collectorId: null,
      collectorName: "Unassigned",
      paymentCount: 1,
      collectedCentavos: 20000,
      cashCentavos: 20000,
      gcashCentavos: 0,
      batchCount: 0,
    });

    // Ben's batch is excluded, so the totals do not carry his 990000.
    expect(report.totals).toMatchObject({
      paymentCount: 3,
      collectedCentavos: 35000,
      cashCentavos: 30000,
      gcashCentavos: 5000,
      batchCount: 1,
      expectedRemittanceCentavos: 15000,
      actualRemittanceCentavos: 14000,
      varianceCentavos: -1000,
    });
  });

  it("fills in the assigned account counts from the assignment snapshot", () => {
    const report = withAssignedAccountCounts(
      buildCollectorPerformanceReport(paymentRows, batchRows, range),
      new Map([
        ["a", 3],
        ["", 1],
      ])
    );

    expect(report.groups.find((group) => group.collectorId === "a")?.assignedAccountCount).toBe(3);
    expect(
      report.groups.find((group) => group.collectorId === null)?.assignedAccountCount
    ).toBe(1);
    expect(report.totals.assignedAccountCount).toBe(4);
  });
});

describe("payment adjustments (R14) and voided receipts (R15)", () => {
  const rows: PaymentAdjustmentRow[] = [
    adjustmentRow({ paymentDate: "2025-01-10", paymentMethod: "cash", amountCentavos: 10000 }),
    adjustmentRow({
      paymentDate: "2025-01-20",
      paymentMethod: "gcash",
      amountCentavos: 25000,
      receiptNumber: "OR-2025-000002",
    }),
    adjustmentRow({
      paymentDate: "2025-01-15",
      paymentMethod: "check",
      amountCentavos: 5000,
      receiptNumber: "OR-2025-000003",
    }),
  ];
  const range = { fromDate: "2025-01-01", toDate: "2025-01-31" };

  it("splits the cash drawer from everything else", () => {
    const report = buildPaymentAdjustmentReport(rows, range);

    expect(report.totals).toEqual({
      reversalCount: 3,
      totalReversedCentavos: 40000,
      cashReversedCentavos: 10000,
      nonCashReversedCentavos: 30000,
    });
    // Newest receipt first.
    expect(report.lines.map((line) => line.paymentDate)).toEqual([
      "2025-01-20",
      "2025-01-15",
      "2025-01-10",
    ]);
  });

  it("splits the voided receipt book into cash and GCash", () => {
    const report = buildVoidedReceiptReport(rows, range);

    expect(report.totals).toEqual({
      receiptCount: 3,
      totalVoidedCentavos: 40000,
      cashVoidedCentavos: 10000,
      gcashVoidedCentavos: 25000,
    });
  });
});

describe("user activity (R16)", () => {
  it("counts the actions per user per action and keeps the latest instant", () => {
    const report = buildUserActivityReport(
      [
        auditRow({ performedAt: new Date("2025-01-15T02:00:00Z") }),
        auditRow({ performedAt: new Date("2025-01-16T02:00:00Z") }),
        auditRow({ action: "payment.reversed", performedAt: new Date("2025-01-17T02:00:00Z") }),
        auditRow({
          performedBy: null,
          performedByUsername: null,
          action: "billing.run",
          performedAt: new Date("2025-01-01T02:00:00Z"),
        }),
      ],
      { fromDate: "2025-01-01", toDate: "2025-01-31" }
    );

    expect(report.groups[0]).toEqual({
      username: "ana.cruz",
      action: "payment.posted",
      actionCount: 2,
      lastPerformedAt: new Date("2025-01-16T02:00:00Z"),
    });
    expect(report.totals).toEqual({
      entryCount: 4,
      userCount: 2, // ana.cruz plus the system actor
      distinctActionCount: 3,
    });
    expect(report.groups.map((group) => group.action)).toContain("billing.run");
    expect(report.groups.some((group) => group.username === SYSTEM_ACTOR_USERNAME)).toBe(true);
  });
});

describe("subscriber master list (R17)", () => {
  it("counts the subscribers and the accounts it lists", () => {
    const rows: SubscriberMasterListRow[] = [
      {
        subscriberId: "s1",
        subscriberAccountNumber: "SUB-20250101-00001",
        subscriberName: "Santos, Maria",
        primaryPhone: "0917-000-0001",
        emailAddress: null,
        serviceAddress: "1 Rizal St",
        areaName: "Poblacion",
        serviceAccountNumber: "SA-20250101-00001",
        planName: "Fiber 25Mbps",
        serviceType: "internet",
        accountStatus: "active",
        collectorName: "Ana Cruz",
      },
      {
        subscriberId: "s1",
        subscriberAccountNumber: "SUB-20250101-00001",
        subscriberName: "Santos, Maria",
        primaryPhone: "0917-000-0001",
        emailAddress: null,
        serviceAddress: "1 Rizal St",
        areaName: "Poblacion",
        serviceAccountNumber: "SA-20250101-00002",
        planName: "Cable Basic",
        serviceType: "cable_tv",
        accountStatus: "active",
        collectorName: "Ana Cruz",
      },
      {
        subscriberId: "s2",
        subscriberAccountNumber: "SUB-20250102-00002",
        subscriberName: "Dela Cruz, Juan",
        primaryPhone: "0917-000-0002",
        emailAddress: "juan@example.test",
        serviceAddress: "2 Mabini St",
        areaName: null,
        serviceAccountNumber: null,
        planName: null,
        serviceType: null,
        accountStatus: null,
        collectorName: null,
      },
    ];

    const report = buildSubscriberMasterListReport(rows);

    expect(report.subscriberCount).toBe(2);
    expect(report.accountCount).toBe(2);
    expect(report.rows.map((row) => row.subscriberName)).toEqual([
      "Dela Cruz, Juan",
      "Santos, Maria",
      "Santos, Maria",
    ]);
  });
});

describe("audit trail report (R18)", () => {
  it("lists the trail newest first and reports the cap honestly", () => {
    const rows = [
      auditRow({ performedAt: new Date("2025-01-15T02:00:00Z") }),
      auditRow({ performedAt: new Date("2025-01-17T02:00:00Z") }),
      auditRow({ performedAt: new Date("2025-01-16T02:00:00Z") }),
    ];

    const report = buildAuditLogReport(rows, { fromDate: "2025-01-01", toDate: "2025-01-31" }, 2);

    expect(report.rows).toHaveLength(2);
    expect(report.totalRows).toBe(3);
    expect(report.isTruncated).toBe(true);
    expect(report.rowLimit).toBe(2);
    expect(report.rows.map((row) => row.performedAt.toISOString().slice(0, 10))).toEqual([
      "2025-01-17",
      "2025-01-16",
    ]);
  });

  it("does not claim truncation when the whole trail fits", () => {
    const report = buildAuditLogReport(
      [auditRow()],
      { fromDate: "2025-01-01", toDate: "2025-01-31" },
      5
    );

    expect(report.isTruncated).toBe(false);
    expect(report.rows).toHaveLength(1);
  });
});

describe("export row cap (S6-6)", () => {
  it("keeps the first rows and reports how many were dropped", () => {
    const rows = Array.from({ length: 5 }, (_value, index) => [`row-${index}`]);

    const capped = capReportRows(rows, 3);

    expect(capped.rows).toEqual([["row-0"], ["row-1"], ["row-2"]]);
    expect(capped.totalRows).toBe(5);
    expect(capped.isTruncated).toBe(true);
  });

  it("changes nothing when the report fits inside the cap", () => {
    const rows = [["a"], ["b"]];
    const capped = capReportRows(rows, 3);

    expect(capped.rows).toEqual(rows);
    expect(capped.totalRows).toBe(2);
    expect(capped.isTruncated).toBe(false);
  });

  it("names the cap and the dropped count in the notice", () => {
    expect(truncationNotice(5000, 12345)).toBe(
      "Showing the first 5,000 of 12,345 rows — narrow the filters to export the rest."
    );
  });

  it("defaults to the documented 5,000-row limit", () => {
    expect(MAX_REPORT_EXPORT_ROWS).toBe(5000);
    const capped = capReportRows(
      Array.from({ length: 5001 }, (_value, index) => [`row-${index}`])
    );
    expect(capped.rows).toHaveLength(5000);
    expect(capped.isTruncated).toBe(true);
  });
});

describe("report date-range defaults", () => {
  it("makes a Monday-to-Sunday week", () => {
    // 2025-01-22 is a Wednesday, so the week is 2025-01-20 .. 2025-01-26.
    expect(weekRange("2025-01-22")).toEqual({
      fromDate: "2025-01-20",
      toDate: "2025-01-26",
      toDateExclusive: "2025-01-27",
    });
    // A Sunday belongs to the week that began six days earlier.
    expect(weekRange("2025-01-26").fromDate).toBe("2025-01-20");
  });

  it("makes a whole calendar month, including a February in a leap year", () => {
    expect(monthRange("2024-02-15")).toEqual({
      fromDate: "2024-02-01",
      toDate: "2024-02-29",
      toDateExclusive: "2024-03-01",
    });
    expect(monthRange("2025-02-15").toDate).toBe("2025-02-28");
  });

  it("makes a whole calendar year", () => {
    expect(yearRange("2025-06-30")).toEqual({
      fromDate: "2025-01-01",
      toDate: "2025-12-31",
      toDateExclusive: "2026-01-01",
    });
  });
});
