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
  SERVICE_ACCOUNT_STATUS_LABELS,
  SERVICE_TYPE_LABELS,
  type AgingBucket,
} from "@bcis/shared";
import type { ReportTable } from "../../shared/reports/report-table";
import { formatDateOnly, formatOfficeDateTime, formatTimeOfDay } from "../../shared/date";
import type { StatementOfAccount } from "../ledger/statement-of-account.service";
import type { ArAgingReport } from "../receivables/ar-aging.service";
import type { CollectorRemittanceReport } from "./collector-remittance.service";
import type { DailyCollectionReport } from "./daily-collection.service";
import type { MonthlyBillingReport } from "./monthly-billing.service";
import type { OutstandingByCollectorReport } from "./outstanding-by-collector.service";
import type {
  AnnualCollectionReport,
  CollectionRangeSummary,
  WeeklyCollectionReport,
} from "./collection-summary.service";
import type { RevenueDimension, RevenueReport } from "./revenue.service";
import type {
  CollectorAssignmentReport,
  CollectorPerformanceReport,
} from "./collector-reports.service";
import type {
  PaymentAdjustmentReport,
  VoidedReceiptReport,
} from "./payment-adjustment.service";
import type { AuditLogReport, UserActivityReport } from "./audit-reports.service";
import { auditActorLabel } from "./audit-reports.service";
import type { SubscriberMasterListReport } from "./subscriber-master-list.service";

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
      formatTimeOfDay(item.postedAt),
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
      // The five canonical aging buckets, labelled and filled identically to the
      // AR aging report, so the columns reconcile to the total (O7).
      { header: printableBucketHeader("current"), format: "money" },
      { header: printableBucketHeader("1_to_30"), format: "money" },
      { header: printableBucketHeader("31_to_60"), format: "money" },
      { header: printableBucketHeader("61_to_90"), format: "money" },
      { header: printableBucketHeader("over_90"), format: "money" },
    ],
    rows: report.groups.map((group) => [
      group.collectorName,
      group.assignedAccountCount,
      group.totalOutstandingCentavos,
      group.currentCentavos,
      group.bucket_1_30_centavos,
      group.bucket_31_60_centavos,
      group.bucket_61_90_centavos,
      group.over_90_centavos,
    ]),
    totalsRows: [
      [
        "TOTAL",
        report.totals.assignedAccountCount,
        report.totals.totalOutstandingCentavos,
        report.totals.currentCentavos,
        report.totals.bucket_1_30_centavos,
        report.totals.bucket_31_60_centavos,
        report.totals.bucket_61_90_centavos,
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

// ─── The reports added by S6-1 and S6-5 ──────────────────────────────────────

/**
 * Shared shape for the weekly and annual collection summaries.
 *
 * Both print one line per period — a day for a week, a month for a year — and end
 * with the week's or year's totals, so the two reports differ only in their heading.
 */
function collectionSummaryTable(
  title: string,
  subtitle: string,
  report: CollectionRangeSummary,
  periodColumnHeader: string
): ReportTable {
  return {
    title,
    subtitle,
    orientation: "portrait",
    columns: [
      { header: periodColumnHeader, format: "text" },
      { header: "Payments", format: "count" },
      { header: "Cash", format: "money" },
      { header: "GCash", format: "money" },
      { header: "Total", format: "money" },
    ],
    rows: report.periods.map((period) => [
      period.periodLabel,
      period.totals.paymentCount,
      period.totals.cashTotalCentavos,
      period.totals.gcashTotalCentavos,
      period.totals.grandTotalCentavos,
    ]),
    totalsRows: [
      [
        "TOTAL",
        report.totals.paymentCount,
        report.totals.cashTotalCentavos,
        report.totals.gcashTotalCentavos,
        report.totals.grandTotalCentavos,
      ],
    ],
  };
}

/** R7 — Weekly Collection Summary. */
export function weeklyCollectionReportTable(report: WeeklyCollectionReport): ReportTable {
  return collectionSummaryTable(
    REPORT_TYPE_LABELS.weekly_collection.toUpperCase(),
    `Week of ${report.weekStartDate} (${report.fromDate} to ${report.toDate})`,
    report,
    "Date"
  );
}

/** R8 — Annual Collection Summary. */
export function annualCollectionReportTable(report: AnnualCollectionReport): ReportTable {
  return collectionSummaryTable(
    REPORT_TYPE_LABELS.annual_collection.toUpperCase(),
    `Calendar year ${report.year}`,
    report,
    "Month"
  );
}

/** The heading over a revenue report's group column, named after its dimension. */
function revenueGroupHeader(dimension: RevenueDimension): string {
  switch (dimension) {
    case "plan":
      return "Plan";
    case "service_type":
      return "Service Type";
    case "area":
      return "Area";
  }
}

/** R9 / R10 / R11 — Revenue grouped by plan, service type, or area. */
export function revenueReportTable(report: RevenueReport): ReportTable {
  const label = REPORT_TYPE_LABELS[
    report.dimension === "plan"
      ? "revenue_by_plan"
      : report.dimension === "service_type"
        ? "revenue_by_service_type"
        : "revenue_by_area"
  ];

  return {
    title: label.toUpperCase(),
    subtitle: `${report.fromDate} to ${report.toDate}`,
    orientation: "landscape",
    columns: [
      { header: revenueGroupHeader(report.dimension), format: "text" },
      { header: "Invoices", format: "count" },
      { header: "Billed", format: "money" },
      { header: "Collected", format: "money" },
      { header: "Outstanding", format: "money" },
    ],
    rows: report.groups.map((group) => [
      group.groupLabel,
      group.invoiceCount,
      group.billedCentavos,
      group.collectedCentavos,
      group.outstandingCentavos,
    ]),
    totalsRows: [
      [
        "TOTAL",
        report.totals.invoiceCount,
        report.totals.billedCentavos,
        report.totals.collectedCentavos,
        report.totals.outstandingCentavos,
      ],
    ],
  };
}

/** R12 — Collector Assignment List. */
export function collectorAssignmentReportTable(
  report: CollectorAssignmentReport
): ReportTable {
  return {
    title: REPORT_TYPE_LABELS.collector_assignment.toUpperCase(),
    subtitle: `${report.accountCount} account(s) across ${report.collectorCount} collector(s) and ${report.areaCount} area(s)`,
    orientation: "landscape",
    columns: [
      { header: "Collector", format: "text" },
      { header: "Account #", format: "text" },
      { header: "Subscriber", format: "text" },
      { header: "Plan", format: "text" },
      { header: "Service Type", format: "text" },
      { header: "Area", format: "text" },
      { header: "Status", format: "text" },
    ],
    rows: report.lines.map((line) => [
      line.collectorName,
      line.serviceAccountNumber,
      line.subscriberName,
      line.planName,
      SERVICE_TYPE_LABELS[line.serviceType],
      line.areaName,
      SERVICE_ACCOUNT_STATUS_LABELS[line.accountStatus],
    ]),
    totalsRows: [
      [
        "TOTAL",
        `${report.accountCount} account(s)`,
        "",
        "",
        "",
        `${report.areaCount} area(s)`,
        "",
      ],
    ],
  };
}

/** R13 — Collector Performance. */
export function collectorPerformanceReportTable(
  report: CollectorPerformanceReport
): ReportTable {
  return {
    title: REPORT_TYPE_LABELS.collector_performance.toUpperCase(),
    subtitle: `${report.fromDate} to ${report.toDate}`,
    orientation: "landscape",
    columns: [
      { header: "Collector", format: "text" },
      { header: "Assigned Accounts", format: "count" },
      { header: "Payments", format: "count" },
      { header: "Collected", format: "money" },
      { header: "Cash", format: "money" },
      { header: "GCash", format: "money" },
      { header: "Batches", format: "count" },
      { header: "Expected Remittance", format: "money" },
      { header: "Actual Remittance", format: "money" },
      { header: "Variance", format: "money" },
    ],
    rows: report.groups.map((group) => [
      group.collectorName,
      group.assignedAccountCount,
      group.paymentCount,
      group.collectedCentavos,
      group.cashCentavos,
      group.gcashCentavos,
      group.batchCount,
      group.expectedRemittanceCentavos,
      group.actualRemittanceCentavos,
      group.varianceCentavos,
    ]),
    totalsRows: [
      [
        "TOTAL",
        report.totals.assignedAccountCount,
        report.totals.paymentCount,
        report.totals.collectedCentavos,
        report.totals.cashCentavos,
        report.totals.gcashCentavos,
        report.totals.batchCount,
        report.totals.expectedRemittanceCentavos,
        report.totals.actualRemittanceCentavos,
        report.totals.varianceCentavos,
      ],
    ],
  };
}

/** R14 — Payment Adjustment / Reversal Report. */
export function paymentAdjustmentReportTable(report: PaymentAdjustmentReport): ReportTable {
  return {
    title: REPORT_TYPE_LABELS.payment_adjustments.toUpperCase(),
    subtitle: `${report.fromDate} to ${report.toDate} — ${report.totals.reversalCount} reversal(s)`,
    orientation: "landscape",
    columns: [
      { header: "Receipt #", format: "text" },
      { header: "Reversal #", format: "text" },
      { header: "Payment Date", format: "text" },
      { header: "Reversed", format: "text" },
      { header: "Subscriber", format: "text" },
      { header: "Account #", format: "text" },
      { header: "Method", format: "text" },
      { header: "Amount", format: "money" },
      { header: "Reason", format: "text" },
      { header: "Reversed By", format: "text" },
    ],
    rows: report.lines.map((line) => [
      line.receiptNumber,
      line.reversalReceiptNumber,
      line.paymentDate,
      formatDateOnly(line.reversedAt),
      line.subscriberName,
      line.serviceAccountNumber,
      PAYMENT_METHOD_LABELS[line.paymentMethod],
      line.amountCentavos,
      line.reason,
      line.reversedByName,
    ]),
    totalsRows: [
      ["Cash reversed", "", "", "", "", "", "", report.totals.cashReversedCentavos, "", ""],
      ["Non-cash reversed", "", "", "", "", "", "", report.totals.nonCashReversedCentavos, "", ""],
      ["TOTAL", "", "", "", "", "", "", report.totals.totalReversedCentavos, "", ""],
    ],
  };
}

/** R15 — Voided Receipt Report. */
export function voidedReceiptReportTable(report: VoidedReceiptReport): ReportTable {
  return {
    title: REPORT_TYPE_LABELS.voided_receipts.toUpperCase(),
    subtitle: `${report.fromDate} to ${report.toDate} — ${report.totals.receiptCount} voided receipt(s)`,
    orientation: "landscape",
    columns: [
      { header: "Receipt #", format: "text" },
      { header: "Payment Date", format: "text" },
      { header: "Voided", format: "text" },
      { header: "Subscriber", format: "text" },
      { header: "Account #", format: "text" },
      { header: "Method", format: "text" },
      { header: "Amount", format: "money" },
      { header: "Reversal #", format: "text" },
      { header: "Reason", format: "text" },
    ],
    rows: report.lines.map((line) => [
      line.receiptNumber,
      line.paymentDate,
      formatDateOnly(line.reversedAt),
      line.subscriberName,
      line.serviceAccountNumber,
      PAYMENT_METHOD_LABELS[line.paymentMethod],
      line.amountCentavos,
      line.reversalReceiptNumber,
      line.reason,
    ]),
    totalsRows: [
      ["Cash voided", "", "", "", "", "", report.totals.cashVoidedCentavos, "", ""],
      ["GCash voided", "", "", "", "", "", report.totals.gcashVoidedCentavos, "", ""],
      ["TOTAL", "", "", "", "", "", report.totals.totalVoidedCentavos, "", ""],
    ],
  };
}

/** R16 — User Activity Report. */
export function userActivityReportTable(report: UserActivityReport): ReportTable {
  // A truncated summary says so, in the same words the export cap uses, so the
  // reader can never mistake the rendered groups for the whole trail (D3).
  const truncation = report.isTruncated
    ? ` — showing the first ${report.renderedRows.toLocaleString("en-US")} of ${report.totalRows.toLocaleString("en-US")} audited action(s)`
    : "";

  return {
    title: REPORT_TYPE_LABELS.user_activity.toUpperCase(),
    subtitle: `${report.fromDate} to ${report.toDate} — ${report.totals.entryCount} audited action(s) by ${report.totals.userCount} user(s)${truncation}`,
    orientation: "portrait",
    columns: [
      { header: "User", format: "text" },
      { header: "Action", format: "text" },
      { header: "Count", format: "count" },
      { header: "Last Performed", format: "text" },
    ],
    rows: report.groups.map((group) => [
      group.username,
      group.action,
      group.actionCount,
      formatOfficeDateTime(group.lastPerformedAt),
    ]),
    totalsRows: [
      [
        "TOTAL",
        `${report.totals.distinctActionCount} distinct action(s)`,
        report.totals.entryCount,
        "",
      ],
    ],
  };
}

/** R17 — Subscriber Master List. */
export function subscriberMasterListReportTable(
  report: SubscriberMasterListReport
): ReportTable {
  return {
    title: REPORT_TYPE_LABELS.subscriber_master_list.toUpperCase(),
    subtitle: `${report.subscriberCount} subscriber(s), ${report.accountCount} service account(s)`,
    orientation: "landscape",
    columns: [
      { header: "Subscriber", format: "text" },
      { header: "Account No", format: "text" },
      { header: "Phone", format: "text" },
      { header: "Email", format: "text" },
      { header: "Service Address", format: "text" },
      { header: "Area", format: "text" },
      { header: "Service Account", format: "text" },
      { header: "Plan", format: "text" },
      { header: "Service Type", format: "text" },
      { header: "Status", format: "text" },
      { header: "Collector", format: "text" },
    ],
    rows: report.rows.map((row) => [
      row.subscriberName,
      row.subscriberAccountNumber,
      row.primaryPhone,
      row.emailAddress ?? "",
      row.serviceAddress,
      row.areaName ?? "",
      row.serviceAccountNumber ?? "",
      row.planName ?? "",
      row.serviceType === null ? "" : SERVICE_TYPE_LABELS[row.serviceType],
      row.accountStatus === null ? "" : SERVICE_ACCOUNT_STATUS_LABELS[row.accountStatus],
      row.collectorName ?? "",
    ]),
    totalsRows: [
      [
        "TOTAL",
        `${report.subscriberCount} subscriber(s)`,
        "",
        "",
        "",
        "",
        `${report.accountCount} account(s)`,
        "",
        "",
        "",
        "",
      ],
    ],
  };
}

/** R18 / S6-5 — Audit Trail Report. */
export function auditLogReportTable(report: AuditLogReport): ReportTable {
  const truncation = report.isTruncated
    ? ` — first ${report.rowLimit.toLocaleString("en-US")} of ${report.totalRows.toLocaleString("en-US")} rows`
    : "";

  return {
    title: REPORT_TYPE_LABELS.audit_log.toUpperCase(),
    subtitle: `${report.fromDate} to ${report.toDate} — ${report.totalRows} entr(ies)${truncation}`,
    orientation: "landscape",
    columns: [
      { header: "Performed At", format: "text" },
      { header: "User", format: "text" },
      { header: "Action", format: "text" },
      { header: "Entity", format: "text" },
      { header: "Entity Id", format: "text" },
      { header: "Description", format: "text" },
      { header: "Client IP", format: "text" },
    ],
    rows: report.rows.map((row) => [
      formatOfficeDateTime(row.performedAt),
      auditActorLabel(row),
      row.action,
      row.entityType,
      row.entityId,
      row.description,
      row.clientIpAddress ?? "",
    ]),
    totalsRows: [["TOTAL", `${report.rowLimit.toLocaleString("en-US")} row cap`, "", "", "", `${report.totalRows} entr(ies)`, ""]],
  };
}
