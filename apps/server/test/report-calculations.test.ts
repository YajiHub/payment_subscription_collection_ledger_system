// Pure tests for the report calculations and the two export generators.
//
// A report is read as a statement of fact about money, so these tests pin:
//
//   • every report total equals the sum of the rows it displays;
//   • the outstanding-by-collector buckets stay exact and non-overlapping, and their
//     grand total equals the AR aging grand total;
//   • voided invoices, reversed payments, and voided collections count for nothing;
//   • a report with no data produces zeros and an empty table instead of crashing;
//   • the PDF is a real, loadable PDF and the spreadsheet is a real ZIP workbook.

import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";

import {
  buildDailyCollectionReport,
  summarizePayments,
  type DailyCollectionPaymentRow,
} from "../src/modules/reports/daily-collection.service";
import {
  buildMonthlyBillingReport,
  summarizeInvoices,
  type MonthlyBillingInvoiceRow,
} from "../src/modules/reports/monthly-billing.service";
import { buildCollectorRemittanceReport } from "../src/modules/reports/collector-remittance.service";
import {
  buildOutstandingByCollector,
  UNASSIGNED_COLLECTOR_NAME,
  type OutstandingInvoiceWithCollectorRow,
} from "../src/modules/reports/outstanding-by-collector.service";
import {
  arAgingReportTable,
  collectorRemittanceReportTable,
  dailyCollectionReportTable,
  monthlyBillingReportTable,
  outstandingByCollectorReportTable,
  subscriberStatementReportTable,
} from "../src/modules/reports/report-tables";
import { buildAgingReport, type ArAgingReport } from "../src/modules/receivables/ar-aging.service";
import type { CollectorBatchDetail } from "../src/modules/collections/collector-batches.service";
import type { StatementOfAccount } from "../src/modules/ledger/statement-of-account.service";
import { formatReportCount, formatReportMoney } from "../src/shared/reports/money-format";
import { generateReportPdf, sanitizePdfText } from "../src/shared/pdf/report-generator";
import { buildReportRows, generateReportXlsx } from "../src/shared/xlsx/report-generator";

/** A payment row as the daily collection query returns it. */
function paymentRow(overrides: Partial<DailyCollectionPaymentRow> = {}): DailyCollectionPaymentRow {
  return {
    receiptNumber: "OR-2025-000001",
    postedAt: new Date("2025-01-24T09:15:00Z"),
    subscriberFirstName: "Maria",
    subscriberLastName: "Santos",
    serviceAccountNumber: "SA-20250101-00001",
    paymentMethod: "cash",
    status: "posted",
    amountCentavos: 50000,
    postedByName: "Ana Cruz",
    ...overrides,
  };
}

/** An invoice row as the monthly billing query returns it. */
function invoiceRow(overrides: Partial<MonthlyBillingInvoiceRow> = {}): MonthlyBillingInvoiceRow {
  return {
    invoiceNumber: "INV-2025-01-000001",
    subscriberFirstName: "Maria",
    subscriberLastName: "Santos",
    serviceAccountNumber: "SA-20250101-00001",
    planName: "Fiber 25Mbps",
    invoiceDate: "2025-01-05",
    dueDate: "2025-01-15",
    totalAmountCentavos: 99900,
    paidAmountCentavos: 0,
    remainingBalanceCentavos: 99900,
    status: "posted",
    ...overrides,
  };
}

/** An outstanding invoice with its assigned collector. */
function outstandingRow(
  overrides: Partial<OutstandingInvoiceWithCollectorRow> = {}
): OutstandingInvoiceWithCollectorRow {
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
    collectorId: null,
    collectorName: null,
    ...overrides,
  };
}

describe("summarizePayments", () => {
  it("totals cash and GCash separately and adds them into the grand total", () => {
    const totals = summarizePayments([
      { status: "posted", paymentMethod: "cash", amountCentavos: 10000 },
      { status: "posted", paymentMethod: "gcash", amountCentavos: 25000 },
      { status: "posted", paymentMethod: "cash", amountCentavos: 5000 },
    ]);

    expect(totals).toEqual({
      paymentCount: 3,
      cashTotalCentavos: 15000,
      gcashTotalCentavos: 25000,
      grandTotalCentavos: 40000,
    });
  });

  it("ignores a reversed payment entirely", () => {
    const totals = summarizePayments([
      { status: "posted", paymentMethod: "cash", amountCentavos: 10000 },
      { status: "reversed", paymentMethod: "cash", amountCentavos: 990000 },
    ]);

    expect(totals.paymentCount).toBe(1);
    expect(totals.grandTotalCentavos).toBe(10000);
    expect(totals.cashTotalCentavos).toBe(10000);
  });
});

describe("buildDailyCollectionReport", () => {
  it("totals exactly the rows it lists", () => {
    const report = buildDailyCollectionReport(
      [
        paymentRow({ receiptNumber: "OR-2025-000001", amountCentavos: 10000 }),
        paymentRow({
          receiptNumber: "OR-2025-000002",
          amountCentavos: 25000,
          paymentMethod: "gcash",
        }),
      ],
      "2025-01-24"
    );

    const listedTotal = report.items.reduce((sum, item) => sum + item.amountCentavos, 0);
    expect(report.items).toHaveLength(2);
    expect(report.totals.grandTotalCentavos).toBe(listedTotal);
    expect(report.totals.grandTotalCentavos).toBe(35000);
  });

  it("leaves a reversed payment out of the list and out of the totals", () => {
    const report = buildDailyCollectionReport(
      [
        paymentRow({ receiptNumber: "OR-2025-000001", amountCentavos: 10000 }),
        paymentRow({ receiptNumber: "OR-2025-000002", amountCentavos: 990000, status: "reversed" }),
      ],
      "2025-01-24"
    );

    expect(report.items.map((item) => item.receiptNumber)).toEqual(["OR-2025-000001"]);
    expect(report.totals.grandTotalCentavos).toBe(10000);
  });

  it("handles a day with no collections", () => {
    const report = buildDailyCollectionReport([], "2025-01-24");

    expect(report.items).toEqual([]);
    expect(report.totals.grandTotalCentavos).toBe(0);
    expect(report.totals.paymentCount).toBe(0);
  });
});

describe("summarizeInvoices", () => {
  it("excludes a voided invoice from every total", () => {
    const totals = summarizeInvoices([
      {
        status: "posted",
        totalAmountCentavos: 100000,
        paidAmountCentavos: 0,
        remainingBalanceCentavos: 100000,
      },
      {
        status: "paid",
        totalAmountCentavos: 50000,
        paidAmountCentavos: 50000,
        remainingBalanceCentavos: 0,
      },
      {
        status: "void",
        totalAmountCentavos: 999999,
        paidAmountCentavos: 0,
        remainingBalanceCentavos: 999999,
      },
    ]);

    expect(totals.invoiceCount).toBe(2);
    expect(totals.totalInvoicedCentavos).toBe(150000);
    expect(totals.totalPaidCentavos).toBe(50000);
    expect(totals.totalOutstandingCentavos).toBe(100000);
  });

  it("sums the stored remaining balances rather than deriving them", () => {
    // The stored balance is the authority; a derived value could disagree with it.
    const totals = summarizeInvoices([
      {
        status: "partially_paid",
        totalAmountCentavos: 100000,
        paidAmountCentavos: 30000,
        remainingBalanceCentavos: 70000,
      },
    ]);

    expect(totals.totalOutstandingCentavos).toBe(70000);
    expect(totals.totalInvoicedCentavos - totals.totalPaidCentavos).toBe(70000);
  });
});

describe("buildMonthlyBillingReport", () => {
  it("lists every invoice and totals only the live ones", () => {
    const report = buildMonthlyBillingReport(
      [
        invoiceRow({
          invoiceNumber: "INV-2025-01-000001",
          totalAmountCentavos: 99900,
          remainingBalanceCentavos: 99900,
        }),
        invoiceRow({
          invoiceNumber: "INV-2025-01-000002",
          totalAmountCentavos: 50000,
          paidAmountCentavos: 50000,
          remainingBalanceCentavos: 0,
          status: "paid",
        }),
        invoiceRow({
          invoiceNumber: "INV-2025-01-000003",
          totalAmountCentavos: 777700,
          remainingBalanceCentavos: 777700,
          status: "void",
        }),
      ],
      2025,
      1
    );

    expect(report.items).toHaveLength(3); // the voided invoice is still listed
    expect(report.periodLabel).toBe("January 2025");
    expect(report.totals.totalInvoicedCentavos).toBe(149900);
    expect(report.totals.totalPaidCentavos).toBe(50000);
    expect(report.totals.totalOutstandingCentavos).toBe(99900);
  });

  it("handles a period with no invoices", () => {
    const report = buildMonthlyBillingReport([], 2025, 1);

    expect(report.items).toEqual([]);
    expect(report.totals).toEqual({
      invoiceCount: 0,
      totalInvoicedCentavos: 0,
      totalPaidCentavos: 0,
      totalOutstandingCentavos: 0,
    });
  });
});

describe("buildOutstandingByCollector", () => {
  const AS_OF = new Date("2025-04-01T00:00:00Z");

  /** The due date exactly `days` before the as-of day, so no calendar is guessed. */
  function dueDaysAgo(days: number): string {
    return new Date(AS_OF.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  it("groups by collector and keeps the buckets non-overlapping at their boundaries", () => {
    const report = buildOutstandingByCollector(
      [
        // Exactly 30 days past due: the 1-30 bucket, so it belongs to NO column here.
        outstandingRow({
          collectorId: "collector-1",
          collectorName: "Rico Reyes",
          remainingBalanceCentavos: 1000,
          dueDate: dueDaysAgo(30),
        }),
        // 31 days: the first column begins here.
        outstandingRow({
          collectorId: "collector-1",
          collectorName: "Rico Reyes",
          remainingBalanceCentavos: 2000,
          dueDate: dueDaysAgo(31),
        }),
        // 60 days: still the first column.
        outstandingRow({
          collectorId: "collector-1",
          collectorName: "Rico Reyes",
          remainingBalanceCentavos: 4000,
          dueDate: dueDaysAgo(60),
        }),
        // 61 days: the second column begins here.
        outstandingRow({
          collectorId: "collector-1",
          collectorName: "Rico Reyes",
          remainingBalanceCentavos: 8000,
          dueDate: dueDaysAgo(61),
        }),
        // 90 days: still the second column.
        outstandingRow({
          collectorId: "collector-1",
          collectorName: "Rico Reyes",
          remainingBalanceCentavos: 16000,
          dueDate: dueDaysAgo(90),
        }),
        // 91 days: the third column begins here.
        outstandingRow({
          collectorId: "collector-1",
          collectorName: "Rico Reyes",
          remainingBalanceCentavos: 32000,
          dueDate: dueDaysAgo(91),
        }),
      ],
      AS_OF
    );

    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]).toMatchObject({
      bucket_30_60_centavos: 2000 + 4000,
      bucket_60_90_centavos: 8000 + 16000,
      over_90_centavos: 32000,
      totalOutstandingCentavos: 1000 + 2000 + 4000 + 8000 + 16000 + 32000,
    });
  });

  it("counts each assigned account once, however many invoices it owes", () => {
    const serviceAccountId = "account-1";
    const report = buildOutstandingByCollector(
      [
        outstandingRow({
          collectorId: "collector-1",
          collectorName: "Rico Reyes",
          serviceAccountId,
          remainingBalanceCentavos: 5000,
        }),
        outstandingRow({
          collectorId: "collector-1",
          collectorName: "Rico Reyes",
          serviceAccountId,
          remainingBalanceCentavos: 7000,
        }),
      ],
      AS_OF
    );

    expect(report.groups[0]).toMatchObject({
      assignedAccountCount: 1,
      totalOutstandingCentavos: 12000,
    });
    expect(report.totals.assignedAccountCount).toBe(1);
  });

  it("makes the grand total equal the AR aging grand total", () => {
    const rows = [
      outstandingRow({
        collectorId: "collector-1",
        collectorName: "Rico Reyes",
        remainingBalanceCentavos: 111111,
        dueDate: "2025-03-01",
      }),
      outstandingRow({
        collectorId: "collector-2",
        collectorName: "Lito Bautista",
        remainingBalanceCentavos: 222222,
        dueDate: "2025-01-01",
      }),
      outstandingRow({ remainingBalanceCentavos: 33333, dueDate: "2024-01-01" }), // unassigned
    ];

    const report = buildOutstandingByCollector(rows, AS_OF);
    const aging = buildAgingReport(rows, AS_OF);

    expect(report.totals.totalOutstandingCentavos).toBe(aging.totals.grandTotal);
    expect(report.totals.totalOutstandingCentavos).toBe(366666);
    expect(report.totals.bucket_30_60_centavos).toBe(111111);
    expect(report.totals.bucket_60_90_centavos).toBe(222222);
    expect(report.totals.over_90_centavos).toBe(33333);
  });

  it("keeps unassigned accounts in their own group so the totals still reconcile", () => {
    const report = buildOutstandingByCollector(
      [
        outstandingRow({
          collectorId: "collector-1",
          collectorName: "Rico Reyes",
          remainingBalanceCentavos: 10000,
          dueDate: "2025-03-01",
        }),
        outstandingRow({ remainingBalanceCentavos: 20000, dueDate: "2025-03-01" }),
      ],
      AS_OF
    );

    const unassigned = report.groups.find(
      (group) => group.collectorName === UNASSIGNED_COLLECTOR_NAME
    );
    expect(unassigned).toMatchObject({ collectorId: null, totalOutstandingCentavos: 20000 });
    expect(report.totals.totalOutstandingCentavos).toBe(30000);
  });

  it("handles an empty receivables book", () => {
    const report = buildOutstandingByCollector([], AS_OF);

    expect(report.groups).toEqual([]);
    expect(report.totals.totalOutstandingCentavos).toBe(0);
  });
});

/** A collector batch detail as the collection service assembles it. */
function batchDetail(overrides: Partial<CollectorBatchDetail> = {}): CollectorBatchDetail {
  return {
    id: randomUUID(),
    batchNumber: "CB-20250124-0001",
    collectorId: "collector-1",
    collectorName: "Rico Reyes",
    status: "submitted",
    collectionDate: "2025-01-24",
    expectedRemittanceCentavos: 700000,
    actualRemittanceCentavos: 650000,
    varianceCentavos: -50000,
    varianceNotes: "Short by PHP 500",
    assignmentCount: 3,
    collectedCount: 2,
    createdAt: new Date("2025-01-24T08:00:00Z"),
    submittedAt: new Date("2025-01-24T17:00:00Z"),
    reconciledAt: null,
    assignments: [
      {
        id: randomUUID(),
        serviceAccountId: "account-1",
        serviceAccountNumber: "SA-20250101-00001",
        subscriberId: "subscriber-1",
        subscriberName: "Santos, Maria",
        planName: "Fiber 25Mbps",
        outstandingBalanceCentavos: 99900,
        collectionResult: "collected",
        collectedAmountCentavos: 500000,
        collectedMethod: "cash",
        paymentId: "payment-1",
        collectorNotes: null,
        voidedAt: null,
        voidReason: null,
      },
      {
        id: randomUUID(),
        serviceAccountId: "account-2",
        serviceAccountNumber: "SA-20250101-00002",
        subscriberId: "subscriber-2",
        subscriberName: "Reyes, Juan",
        planName: "Fiber 25Mbps",
        outstandingBalanceCentavos: 200000,
        collectionResult: "partial",
        collectedAmountCentavos: 200000,
        collectedMethod: "gcash",
        paymentId: "payment-2",
        collectorNotes: null,
        voidedAt: null,
        voidReason: null,
      },
      {
        id: randomUUID(),
        serviceAccountId: "account-3",
        serviceAccountNumber: "SA-20250101-00003",
        subscriberId: "subscriber-3",
        subscriberName: "Cruz, Pedro",
        planName: "Fiber 25Mbps",
        outstandingBalanceCentavos: 300000,
        collectionResult: null,
        collectedAmountCentavos: null,
        collectedMethod: null,
        paymentId: null,
        collectorNotes: null,
        voidedAt: new Date("2025-01-24T16:00:00Z"),
        voidReason: "Posted to the wrong account",
      },
    ],
    collectedTotalCentavos: 700000,
    outstandingTotalCentavos: 1499900,
    ...overrides,
  };
}

describe("buildCollectorRemittanceReport", () => {
  it("shows the variance the batch stored rather than recomputing it", () => {
    const report = buildCollectorRemittanceReport(batchDetail());

    expect(report.expectedRemittanceCentavos).toBe(700000);
    expect(report.actualRemittanceCentavos).toBe(650000);
    expect(report.varianceCentavos).toBe(-50000);
    expect(report.hasVariance).toBe(true);
  });

  it("makes the expected remittance equal the sum of the lines it prints", () => {
    const report = buildCollectorRemittanceReport(batchDetail());

    const lineTotal = report.lines.reduce(
      (runningTotal, line) => runningTotal + line.collectedAmountCentavos,
      0
    );
    expect(lineTotal).toBe(report.expectedRemittanceCentavos);
  });

  it("counts a voided collection as nothing", () => {
    const report = buildCollectorRemittanceReport(batchDetail());
    const voidedLine = report.lines.find(
      (line) => line.serviceAccountNumber === "SA-20250101-00003"
    );

    expect(voidedLine).toMatchObject({
      collectedAmountCentavos: 0,
      collectionResult: null,
      isVoided: true,
    });
  });

  it("reports an open batch as having no remittance yet", () => {
    const report = buildCollectorRemittanceReport(
      batchDetail({ status: "open", actualRemittanceCentavos: null, varianceCentavos: null })
    );

    expect(report.actualRemittanceCentavos).toBeNull();
    expect(report.varianceCentavos).toBeNull();
    expect(report.hasVariance).toBe(false);
  });
});

describe("report tables", () => {
  it("puts the daily collection cash, GCash, and grand totals on their own lines", () => {
    const table = dailyCollectionReportTable(
      buildDailyCollectionReport(
        [
          paymentRow({ receiptNumber: "OR-2025-000001", amountCentavos: 10000 }),
          paymentRow({
            receiptNumber: "OR-2025-000002",
            amountCentavos: 25000,
            paymentMethod: "gcash",
          }),
        ],
        "2025-01-24"
      )
    );

    expect(table.rows).toHaveLength(2);
    expect(table.totalsRows).toEqual([
      ["Cash total", "2 payment(s)", "", "", "", 10000, ""],
      ["GCash total", "", "", "", "", 25000, ""],
      ["Grand total", "", "", "", "", 35000, ""],
    ]);
  });

  it("declares its money columns so both generators render centavos correctly", () => {
    const table = monthlyBillingReportTable(buildMonthlyBillingReport([], 2025, 1));

    expect(table.columns.map((column) => column.format)).toEqual([
      "text",
      "text",
      "text",
      "text",
      "text",
      "text",
      "money",
      "money",
      "money",
      "text",
    ]);
  });

  it("totals the aging table to exactly the report totals", () => {
    const aging: ArAgingReport = {
      asOfDate: "2025-02-15",
      entries: [
        {
          subscriberId: "subscriber-1",
          subscriberName: "Santos, Maria",
          serviceAccountId: "account-1",
          serviceAccountNumber: "SA-20250101-00001",
          planName: "Fiber 25Mbps",
          currentCentavos: 1000,
          bucket_1_30_centavos: 2000,
          bucket_31_60_centavos: 4000,
          bucket_61_90_centavos: 8000,
          over_90_centavos: 16000,
          totalOutstandingCentavos: 31000,
        },
      ],
      totals: {
        current: 1000,
        bucket_1_30: 2000,
        bucket_31_60: 4000,
        bucket_61_90: 8000,
        over_90: 16000,
        grandTotal: 31000,
      },
    };

    const table = arAgingReportTable(aging);
    const totalsRow = table.totalsRows[0] ?? [];

    expect(table.orientation).toBe("landscape");
    expect(totalsRow.slice(3)).toEqual([1000, 2000, 4000, 8000, 16000, 31000]);
  });

  it("labels the outstanding-by-collector buckets with the ranges the spec writes", () => {
    const report = buildOutstandingByCollector(
      [
        outstandingRow({
          collectorId: "collector-1",
          collectorName: "Rico Reyes",
          dueDate: "2025-03-01",
        }),
      ],
      new Date("2025-04-01T00:00:00Z")
    );

    const table = outstandingByCollectorReportTable(report);

    expect(table.columns.map((column) => column.header)).toEqual([
      "Collector",
      "Assigned Accounts",
      "Total Outstanding",
      "30-60 Days",
      "60-90 Days",
      "90+ Days",
    ]);
    expect(table.totalsRows[0]).toEqual(["TOTAL", 1, 100000, 100000, 0, 0]);
  });

  it("labels the remittance variance as an overage or a shortage", () => {
    const short = collectorRemittanceReportTable(buildCollectorRemittanceReport(batchDetail()));
    expect(short.totalsRows[2]?.[0]).toBe("Variance (shortage)");

    const over = collectorRemittanceReportTable(
      buildCollectorRemittanceReport(
        batchDetail({
          expectedRemittanceCentavos: 700000,
          actualRemittanceCentavos: 800000,
          varianceCentavos: 100000,
        })
      )
    );
    expect(over.totalsRows[2]?.[0]).toBe("Variance (overage)");
  });

  it("closes a statement of account with opening + debits - credits", () => {
    const statement: StatementOfAccount = {
      serviceAccount: {
        id: "account-1",
        serviceAccountNumber: "SA-20250101-00001",
        planName: "Fiber 25Mbps",
        serviceType: "internet",
        monthlyRateCentavos: 99900,
        status: "active",
      },
      subscriber: {
        id: "subscriber-1",
        accountNumber: "SUB-20250101-00001",
        firstName: "Maria",
        middleName: null,
        lastName: "Santos",
        serviceAddress: "12 Mabini Street",
        serviceBarangay: "Poblacion",
        serviceMunicipality: "Cabuyao",
        serviceProvince: "Laguna",
      },
      generatedAt: new Date("2025-02-15T08:00:00Z"),
      periodFrom: null,
      periodTo: null,
      asOfDate: "2025-02-15",
      lines: [
        {
          id: "entry-1",
          sequenceNumber: 1,
          date: "2025-01-05",
          description: "Invoice INV-2025-01-000001",
          debitCentavos: 99900,
          creditCentavos: 0,
          balanceCentavos: 99900,
          referenceNumber: "INV-2025-01-000001",
          entryType: "invoice_posted",
        },
        {
          id: "entry-2",
          sequenceNumber: 2,
          date: "2025-01-20",
          description: "Payment OR-2025-000001",
          debitCentavos: 0,
          creditCentavos: 50000,
          balanceCentavos: 49900,
          referenceNumber: "OR-2025-000001",
          entryType: "payment_received",
        },
      ],
      openingBalanceCentavos: 0,
      closingBalanceCentavos: 49900,
      totalDebitsCentavos: 99900,
      totalCreditsCentavos: 50000,
    };

    const table = subscriberStatementReportTable(statement);

    expect(table.rows).toHaveLength(2);
    expect(table.totalsRows).toEqual([
      ["Opening balance", "", "", "", "", 0],
      ["Totals", "", "", 99900, 50000, ""],
      ["CLOSING BALANCE", "", "", "", "", 49900],
    ]);
  });
});

describe("formatReportMoney", () => {
  it("formats integer centavos as pesos without ever using a float", () => {
    expect(formatReportMoney(0)).toBe("PHP 0.00");
    expect(formatReportMoney(5)).toBe("PHP 0.05");
    expect(formatReportMoney(123456)).toBe("PHP 1,234.56");
    expect(formatReportMoney(123456789)).toBe("PHP 1,234,567.89");
  });

  it("signs a negative amount, as a shortage or an advance credit is", () => {
    expect(formatReportMoney(-5000)).toBe("-PHP 50.00");
  });

  it("groups a count with thousands separators", () => {
    expect(formatReportCount(1234)).toBe("1,234");
  });
});

describe("sanitizePdfText", () => {
  it("replaces characters the standard fonts cannot encode", () => {
    expect(sanitizePdfText("₱1,234.56")).toBe("PHP 1,234.56");
    expect(sanitizePdfText("1–30 Days")).toBe("1-30 Days");
    expect(sanitizePdfText("61—90 Days")).toBe("61-90 Days");
    expect(sanitizePdfText("Santos’ bill")).toBe("Santos' bill");
  });

  it("keeps the latin-1 characters a subscriber name may contain", () => {
    expect(sanitizePdfText("Muñoz, José")).toBe("Muñoz, José");
  });

  it("replaces anything with no glyph rather than letting pdf-lib throw", () => {
    expect(sanitizePdfText("Cable 日本語")).toBe("Cable ???");
  });
});

describe("generateReportPdf", () => {
  const table = arAgingReportTable({
    asOfDate: "2025-02-15",
    entries: [
      {
        subscriberId: "subscriber-1",
        subscriberName: "Santos, Maria",
        serviceAccountId: "account-1",
        serviceAccountNumber: "SA-20250101-00001",
        planName: "Fiber 25Mbps",
        currentCentavos: 0,
        bucket_1_30_centavos: 50000,
        bucket_31_60_centavos: 0,
        bucket_61_90_centavos: 0,
        over_90_centavos: 0,
        totalOutstandingCentavos: 50000,
      },
    ],
    totals: {
      current: 0,
      bucket_1_30: 50000,
      bucket_31_60: 0,
      bucket_61_90: 0,
      over_90: 0,
      grandTotal: 50000,
    },
  });

  it("produces a document that starts and ends like a PDF", async () => {
    const pdf = await generateReportPdf(table);

    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.subarray(-6).toString("latin1").trim()).toBe("%%EOF");
  });

  it("produces a document a PDF reader can load back", async () => {
    const pdf = await generateReportPdf(table);
    const loaded = await PDFDocument.load(pdf);

    expect(loaded.getPageCount()).toBe(1);
    expect(loaded.getTitle()).toBe(table.title);
  });

  it("starts a new page when the rows do not fit", async () => {
    const manyRows = {
      ...table,
      rows: Array.from({ length: 120 }, (_value, index) => [
        `Subscriber ${index}`,
        "SA-20250101-00001",
        "Fiber 25Mbps",
        0,
        1000,
        0,
        0,
        0,
        1000,
      ]),
    };

    const loaded = await PDFDocument.load(await generateReportPdf(manyRows));

    expect(loaded.getPageCount()).toBeGreaterThan(1);
  });

  it("still produces a page for an empty report", async () => {
    const emptyTable = { ...table, rows: [], totalsRows: [] };
    const loaded = await PDFDocument.load(await generateReportPdf(emptyTable));

    expect(loaded.getPageCount()).toBe(1);
  });
});

describe("generateReportXlsx", () => {
  it("writes the title, a centavos-labelled header, the rows, and the totals", () => {
    const table = dailyCollectionReportTable(
      buildDailyCollectionReport([paymentRow({ amountCentavos: 10000 })], "2025-01-24")
    );

    const rows = buildReportRows(table);

    expect(rows[0]).toEqual([table.title]);
    expect(rows[1]).toEqual(["For 2025-01-24"]);
    expect(rows[3]).toContain("Amount (centavos)");
    expect(rows[4]).toEqual([
      "OR-2025-000001",
      "09:15:00",
      "Santos, Maria",
      "SA-20250101-00001",
      "Cash",
      10000,
      "Ana Cruz",
    ]);
    expect(rows.at(-1)).toEqual(["Grand total", "", "", "", "", 10000, ""]);
  });

  it("produces a real ZIP archive", () => {
    const bytes = generateReportXlsx(
      monthlyBillingReportTable(buildMonthlyBillingReport([invoiceRow()], 2025, 1))
    );

    expect(bytes[0]).toBe(0x50); // P
    expect(bytes[1]).toBe(0x4b); // K
    expect(bytes[2]).toBe(0x03);
    expect(bytes[3]).toBe(0x04);
  });
});
