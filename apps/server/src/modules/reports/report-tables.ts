// Turns each report's data into the table that gets printed and written to a
// spreadsheet.
//
// Every function here is PURE: it takes the report data the services already
// assembled and produces a `ReportTable`. No database, no formatting decisions
// beyond the column headers and the totals labels — which is exactly what makes
// "the PDF, the spreadsheet, and the screen show the same numbers" testable.
//
// Money cells hold integer centavos and their column is declared as money, so the
// generators can render them for their own medium without either of them converting
// through a floating-point peso amount.

import {
  COLLECTED_METHOD_LABELS,
  COLLECTION_RESULT_LABELS,
  INVOICE_STATUS_LABELS,
  REPORT_TYPE_LABELS,
  PAYMENT_METHOD_LABELS,
  type AgingBucket,
} from "@bcis/shared";
import type { ReportTable } from "../../shared/reports/report-table";
import type { StatementOfAccount } from "../ledger/statement-of-account.service";
import type { ArAgingReport } from "../receivables/ar-aging.service";
import type { CollectorRemittanceReport } from "./collector-remittance.service";
import type { DailyCollectionReport } from "./daily-collection.service";
import type { MonthlyBillingReport } from "./monthly-billing.service";
import type { OutstandingByCollectorReport } from "./outstanding-by-collector.service";

// The bucket labels shared with the screen use an en dash ("1–30 Days"), which the
// PDF standard fonts cannot encode. The printable headers spell the ranges with a
// plain hyphen instead; the numbers behind both are identical.
const PRINTABLE_BUCKET_HEADERS = {
  current: "Current",
  "1_to_30": "1-30 Days",
  "31_to_60": "31-60 Days",
  "61_to_90": "61-90 Days",
  over_90: "90+ Days",
} as const satisfies Record<AgingBucket, string>;

/** The header for one aging bucket, in the printable spelling. */
function printableBucketHeader(bucket: AgingBucket): string {
  return PRINTABLE_BUCKET_HEADERS[bucket];
}

/** R1 — Daily Collection Summary. One line per posted payment plus the cash count. */
export function dailyCollectionReportTable(report: DailyCollectionReport): ReportTable {
  return {
    title: REPORT_TYPE_LABELS.daily_collection.toUpperCase(),
    subtitle: `For ${report.date}`,
    orientation: "portrait",
    columns: [
      { header: "Receipt #", format: "text" },
      { header: "Time", format: "text" },
      { header: "Subscriber", format: "text" },
      { header: "Service Account", format: "text" },
      { header: "Method", format: "text" },
      { header: "Amount", format: "money" },
      { header: "Posted By", format: "text" },
    ],
    rows: report.items.map((item) => [
      item.receiptNumber,
      item.postedAt.toISOString().slice(11, 19),
      item.subscriberName,
      item.serviceAccountNumber,
      PAYMENT_METHOD_LABELS[item.paymentMethod],
      item.amountCentavos,
      item.postedByName,
    ]),
    totalsRows: [
      [
        "Cash total",
        `${report.totals.paymentCount} payment(s)`,
        "",
        "",
        "",
        report.totals.cashTotalCentavos,
        "",
      ],
      ["GCash total", "", "", "", "", report.totals.gcashTotalCentavos, ""],
      ["Grand total", "", "", "", "", report.totals.grandTotalCentavos, ""],
    ],
  };
}

/** R2 — Monthly Billing Summary. One line per invoice raised for the period. */
export function monthlyBillingReportTable(report: MonthlyBillingReport): ReportTable {
  return {
    title: REPORT_TYPE_LABELS.monthly_billing.toUpperCase(),
    subtitle: `Billing period ${report.periodLabel}`,
    orientation: "landscape",
    columns: [
      { header: "Invoice #", format: "text" },
      { header: "Subscriber", format: "text" },
      { header: "Service Account", format: "text" },
      { header: "Plan", format: "text" },
      { header: "Invoice Date", format: "text" },
      { header: "Due Date", format: "text" },
      { header: "Amount", format: "money" },
      { header: "Paid", format: "money" },
      { header: "Balance", format: "money" },
      { header: "Status", format: "text" },
    ],
    rows: report.items.map((item) => [
      item.invoiceNumber,
      item.subscriberName,
      item.serviceAccountNumber,
      item.planName,
      item.invoiceDate,
      item.dueDate,
      item.totalAmountCentavos,
      item.paidAmountCentavos,
      item.remainingBalanceCentavos,
      INVOICE_STATUS_LABELS[item.status],
    ]),
    totalsRows: [
      [
        "TOTAL",
        `${report.totals.invoiceCount} invoice(s)`,
        "",
        "",
        "",
        "",
        report.totals.totalInvoicedCentavos,
        report.totals.totalPaidCentavos,
        report.totals.totalOutstandingCentavos,
        "",
      ],
    ],
  };
}

/** R3 — AR Aging Report. One line per service account, totalled per bucket. */
export function arAgingReportTable(report: ArAgingReport): ReportTable {
  return {
    title: REPORT_TYPE_LABELS.ar_aging.toUpperCase(),
    subtitle: `As of ${report.asOfDate}`,
    orientation: "landscape",
    columns: [
      { header: "Subscriber", format: "text" },
      { header: "Account #", format: "text" },
      { header: "Plan", format: "text" },
      { header: printableBucketHeader("current"), format: "money" },
      { header: printableBucketHeader("1_to_30"), format: "money" },
      { header: printableBucketHeader("31_to_60"), format: "money" },
      { header: printableBucketHeader("61_to_90"), format: "money" },
      { header: printableBucketHeader("over_90"), format: "money" },
      { header: "Total", format: "money" },
    ],
    rows: report.entries.map((entry) => [
      entry.subscriberName,
      entry.serviceAccountNumber,
      entry.planName,
      entry.currentCentavos,
      entry.bucket_1_30_centavos,
      entry.bucket_31_60_centavos,
      entry.bucket_61_90_centavos,
      entry.over_90_centavos,
      entry.totalOutstandingCentavos,
    ]),
    totalsRows: [
      [
        "TOTAL",
        `${report.entries.length} account(s)`,
        "",
        report.totals.current,
        report.totals.bucket_1_30,
        report.totals.bucket_31_60,
        report.totals.bucket_61_90,
        report.totals.over_90,
        report.totals.grandTotal,
      ],
    ],
  };
}

/** R5 — Collector Remittance Report. One line per assigned account, plus variance. */
export function collectorRemittanceReportTable(report: CollectorRemittanceReport): ReportTable {
  return {
    title: REPORT_TYPE_LABELS.collector_remittance.toUpperCase(),
    subtitle: `Batch ${report.batchNumber} — ${report.collectorName} — ${report.collectionDate} (${report.status})`,
    orientation: "portrait",
    columns: [
      { header: "Subscriber", format: "text" },
      { header: "Account #", format: "text" },
      { header: "Collected", format: "money" },
      { header: "Method", format: "text" },
      { header: "Result", format: "text" },
    ],
    rows: report.lines.map((line) => [
      line.subscriberName,
      line.serviceAccountNumber,
      line.collectedAmountCentavos,
      line.collectedMethod === null ? "" : COLLECTED_METHOD_LABELS[line.collectedMethod],
      collectionOutcomeLabel(line.collectionResult, line.isVoided),
    ]),
    totalsRows: [
      ["Expected remittance", "", report.expectedRemittanceCentavos, "", ""],
      ["Actual remittance", "", report.actualRemittanceCentavos ?? 0, "", ""],
      [
        `Variance${report.varianceCentavos === null ? "" : varianceNote(report.varianceCentavos)}`,
        "",
        report.varianceCentavos ?? 0,
        "",
        "",
      ],
    ],
  };
}

/** Names an overage or a shortage so the variance line reads without arithmetic. */
function varianceNote(varianceCentavos: number): string {
  if (varianceCentavos > 0) {
    return " (overage)";
  }
  if (varianceCentavos < 0) {
    return " (shortage)";
  }
  return " (balanced)";
}

/** What happened at one visit: a recorded result, or why there is none. */
function collectionOutcomeLabel(
  result: CollectorRemittanceReport["lines"][number]["collectionResult"],
  isVoided: boolean
): string {
  if (result !== null) {
    return COLLECTION_RESULT_LABELS[result];
  }
  return isVoided ? "Voided" : "Not visited";
}

/** R6 — Outstanding Receivables by Collector. */
export function outstandingByCollectorReportTable(
  report: OutstandingByCollectorReport
): ReportTable {
  return {
    title: REPORT_TYPE_LABELS.outstanding_by_collector.toUpperCase(),
    subtitle: `As of ${report.asOfDate}`,
    orientation: "landscape",
    columns: [
      { header: "Collector", format: "text" },
      { header: "Assigned Accounts", format: "count" },
      { header: "Total Outstanding", format: "money" },
      { header: "30-60 Days", format: "money" },
      { header: "60-90 Days", format: "money" },
      { header: "90+ Days", format: "money" },
    ],
    rows: report.groups.map((group) => [
      group.collectorName,
      group.assignedAccountCount,
      group.totalOutstandingCentavos,
      group.bucket_30_60_centavos,
      group.bucket_60_90_centavos,
      group.over_90_centavos,
    ]),
    totalsRows: [
      [
        "TOTAL",
        report.totals.assignedAccountCount,
        report.totals.totalOutstandingCentavos,
        report.totals.bucket_30_60_centavos,
        report.totals.bucket_60_90_centavos,
        report.totals.over_90_centavos,
      ],
    ],
  };
}

/** R4 — Subscriber Statement of Account, in the shape a printed statement takes. */
export function subscriberStatementReportTable(statement: StatementOfAccount): ReportTable {
  const subscriberName = `${statement.subscriber.lastName}, ${statement.subscriber.firstName}`;
  const address = [
    statement.subscriber.serviceAddress,
    statement.subscriber.serviceBarangay,
    statement.subscriber.serviceMunicipality,
    statement.subscriber.serviceProvince,
  ]
    .filter((part) => part.length > 0)
    .join(", ");

  return {
    title: "STATEMENT OF ACCOUNT",
    subtitle: `${subscriberName} — ${address} — Account ${statement.serviceAccount.serviceAccountNumber} — As of ${statement.asOfDate}`,
    orientation: "portrait",
    columns: [
      { header: "Date", format: "text" },
      { header: "Description", format: "text" },
      { header: "Reference", format: "text" },
      { header: "Debit", format: "money" },
      { header: "Credit", format: "money" },
      { header: "Balance", format: "money" },
    ],
    rows: statement.lines.map((line) => [
      line.date,
      line.description,
      line.referenceNumber,
      line.debitCentavos,
      line.creditCentavos,
      line.balanceCentavos,
    ]),
    totalsRows: [
      ["Opening balance", "", "", "", "", statement.openingBalanceCentavos],
      ["Totals", "", "", statement.totalDebitsCentavos, statement.totalCreditsCentavos, ""],
      ["CLOSING BALANCE", "", "", "", "", statement.closingBalanceCentavos],
    ],
  };
}
