// Presentation builders for the Reports Center.
//
// Each report arrives from the API as data with integer centavos. These functions
// turn one report into the table the screen draws: the column headers, the rows,
// and the totals lines, with money already formatted.
//
// Formatting only. No total is recomputed here — every figure shown is the one the
// server sent, so the screen cannot disagree with the PDF or the spreadsheet of the
// same report.

import {
  COLLECTED_METHOD_LABELS,
  COLLECTION_RESULT_LABELS,
  INVOICE_STATUS_LABELS,
  PAYMENT_METHOD_LABELS,
  SERVICE_ACCOUNT_STATUS_LABELS,
  SERVICE_TYPE_LABELS,
} from "@bcis/shared";
import { formatCentavos, formatDateOnly } from "./format";
import type {
  AnnualCollectionReport,
  AuditLogReport,
  CollectorAssignmentReport,
  CollectorPerformanceReport,
  CollectorRemittanceReport,
  DailyCollectionReport,
  MonthlyBillingReport,
  OutstandingByCollectorReport,
  ArAgingReport,
  PaymentAdjustmentReport,
  RevenueReport,
  ServiceAccountStatement,
  SubscriberMasterListReport,
  UserActivityReport,
  VoidedReceiptReport,
  WeeklyCollectionReport,
} from "./api-client";

export interface DisplayColumn {
  header: string;
  align: "left" | "right";
}

export interface DisplayTable {
  title: string;
  subtitle: string;
  columns: DisplayColumn[];
  rows: string[][];
  /** The totals lines, each already formatted. */
  totalsRows: string[][];
  /** True when there is nothing to show, so the screen can say so. */
  isEmpty: boolean;
  /**
   * A warning shown above the table, when the report is not the whole of itself.
   *
   * The audit trail is capped server-side (S6-6); the cap is stated here so a
   * truncated report can never be mistaken for a complete one.
   */
  notice?: string;
}

function headings(headers: readonly [string, "left" | "right"][]): DisplayColumn[] {
  return headers.map(([header, align]) => ({ header, align }));
}

/** A whole number with thousands separators. */
function formatCount(value: number): string {
  return value.toLocaleString("en-PH");
}

/** R1 — Daily Collection Summary. */
export function buildDailyCollectionView(report: DailyCollectionReport): DisplayTable {
  return {
    title: "Daily Collection Summary",
    subtitle: `For ${formatDateOnly(report.date)}`,
    columns: headings([
      ["Receipt #", "left"],
      ["Time", "left"],
      ["Subscriber", "left"],
      ["Service Account", "left"],
      ["Method", "left"],
      ["Amount", "right"],
      ["Posted By", "left"],
    ]),
    rows: report.items.map((item) => [
      item.receiptNumber,
      new Date(item.postedAt).toLocaleTimeString("en-PH"),
      item.subscriberName,
      item.serviceAccountNumber,
      PAYMENT_METHOD_LABELS[item.paymentMethod],
      formatCentavos(item.amountCentavos),
      item.postedByName,
    ]),
    totalsRows: [
      [
        "Cash total",
        `${formatCount(report.totals.paymentCount)} payment(s)`,
        "",
        "",
        "",
        formatCentavos(report.totals.cashTotalCentavos),
        "",
      ],
      ["GCash total", "", "", "", "", formatCentavos(report.totals.gcashTotalCentavos), ""],
      ["Grand total", "", "", "", "", formatCentavos(report.totals.grandTotalCentavos), ""],
    ],
    isEmpty: report.items.length === 0,
  };
}

/** R2 — Monthly Billing Summary. */
export function buildMonthlyBillingView(report: MonthlyBillingReport): DisplayTable {
  return {
    title: "Monthly Billing Summary",
    subtitle: `Billing period ${report.periodLabel}`,
    columns: headings([
      ["Invoice #", "left"],
      ["Subscriber", "left"],
      ["Service Account", "left"],
      ["Plan", "left"],
      ["Invoice Date", "left"],
      ["Due Date", "left"],
      ["Amount", "right"],
      ["Paid", "right"],
      ["Balance", "right"],
      ["Status", "left"],
    ]),
    rows: report.items.map((item) => [
      item.invoiceNumber,
      item.subscriberName,
      item.serviceAccountNumber,
      item.planName,
      formatDateOnly(item.invoiceDate),
      formatDateOnly(item.dueDate),
      formatCentavos(item.totalAmountCentavos),
      formatCentavos(item.paidAmountCentavos),
      formatCentavos(item.remainingBalanceCentavos),
      INVOICE_STATUS_LABELS[item.status],
    ]),
    totalsRows: [
      [
        "TOTAL",
        `${formatCount(report.totals.invoiceCount)} invoice(s)`,
        "",
        "",
        "",
        "",
        formatCentavos(report.totals.totalInvoicedCentavos),
        formatCentavos(report.totals.totalPaidCentavos),
        formatCentavos(report.totals.totalOutstandingCentavos),
        "",
      ],
    ],
    isEmpty: report.items.length === 0,
  };
}

/** R3 — AR Aging Report. */
export function buildArAgingView(report: ArAgingReport): DisplayTable {
  return {
    title: "AR Aging Report",
    subtitle: `As of ${formatDateOnly(report.asOfDate)}`,
    columns: headings([
      ["Subscriber", "left"],
      ["Account #", "left"],
      ["Plan", "left"],
      ["Current", "right"],
      ["1-30 Days", "right"],
      ["31-60 Days", "right"],
      ["61-90 Days", "right"],
      ["90+ Days", "right"],
      ["Total", "right"],
    ]),
    rows: report.entries.map((entry) => [
      entry.subscriberName,
      entry.serviceAccountNumber,
      entry.planName,
      formatCentavos(entry.currentCentavos),
      formatCentavos(entry.bucket_1_30_centavos),
      formatCentavos(entry.bucket_31_60_centavos),
      formatCentavos(entry.bucket_61_90_centavos),
      formatCentavos(entry.over_90_centavos),
      formatCentavos(entry.totalOutstandingCentavos),
    ]),
    totalsRows: [
      [
        "TOTAL",
        `${formatCount(report.entries.length)} account(s)`,
        "",
        formatCentavos(report.totals.current),
        formatCentavos(report.totals.bucket_1_30),
        formatCentavos(report.totals.bucket_31_60),
        formatCentavos(report.totals.bucket_61_90),
        formatCentavos(report.totals.over_90),
        formatCentavos(report.totals.grandTotal),
      ],
    ],
    isEmpty: report.entries.length === 0,
  };
}

/** R5 — Collector Remittance Report. */
export function buildCollectorRemittanceView(report: CollectorRemittanceReport): DisplayTable {
  return {
    title: "Collector Remittance Report",
    subtitle: `Batch ${report.batchNumber} — ${report.collectorName} — ${formatDateOnly(report.collectionDate)}`,
    columns: headings([
      ["Subscriber", "left"],
      ["Account #", "left"],
      ["Collected", "right"],
      ["Method", "left"],
      ["Result", "left"],
    ]),
    rows: report.lines.map((line) => [
      line.subscriberName,
      line.serviceAccountNumber,
      formatCentavos(line.collectedAmountCentavos),
      line.collectedMethod === null ? "—" : COLLECTED_METHOD_LABELS[line.collectedMethod],
      collectionOutcomeLabel(line.collectionResult, line.isVoided),
    ]),
    totalsRows: [
      ["Expected remittance", "", formatCentavos(report.expectedRemittanceCentavos), "", ""],
      ["Actual remittance", "", formatCentavos(report.actualRemittanceCentavos ?? 0), "", ""],
      [
        `Variance${report.varianceCentavos === null ? "" : varianceLabel(report.varianceCentavos)}`,
        "",
        formatCentavos(report.varianceCentavos ?? 0),
        "",
        "",
      ],
    ],
    isEmpty: report.lines.length === 0,
  };
}

/** Names an overage or a shortage so the variance reads without arithmetic. */
function varianceLabel(varianceCentavos: number): string {
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
export function buildOutstandingByCollectorView(
  report: OutstandingByCollectorReport
): DisplayTable {
  return {
    title: "Outstanding Receivables by Collector",
    subtitle: `As of ${formatDateOnly(report.asOfDate)}`,
    columns: headings([
      ["Collector", "left"],
      ["Assigned Accounts", "right"],
      ["Total Outstanding", "right"],
      ["30-60 Days", "right"],
      ["60-90 Days", "right"],
      ["90+ Days", "right"],
    ]),
    rows: report.groups.map((group) => [
      group.collectorName,
      formatCount(group.assignedAccountCount),
      formatCentavos(group.totalOutstandingCentavos),
      formatCentavos(group.bucket_30_60_centavos),
      formatCentavos(group.bucket_60_90_centavos),
      formatCentavos(group.over_90_centavos),
    ]),
    totalsRows: [
      [
        "TOTAL",
        formatCount(report.totals.assignedAccountCount),
        formatCentavos(report.totals.totalOutstandingCentavos),
        formatCentavos(report.totals.bucket_30_60_centavos),
        formatCentavos(report.totals.bucket_60_90_centavos),
        formatCentavos(report.totals.over_90_centavos),
      ],
    ],
    isEmpty: report.groups.length === 0,
  };
}

/** R4 — Subscriber Statement of Account. */
export function buildStatementView(statement: ServiceAccountStatement): DisplayTable {
  const subscriberName = `${statement.subscriber.lastName}, ${statement.subscriber.firstName}`;
  const period =
    statement.periodFrom === null && statement.periodTo === null
      ? "from the beginning"
      : `${statement.periodFrom ?? "the beginning"} to ${statement.periodTo ?? "today"}`;

  return {
    title: "Statement of Account",
    subtitle: `${subscriberName} — ${statement.serviceAccount.serviceAccountNumber} — ${period}`,
    columns: headings([
      ["Date", "left"],
      ["Description", "left"],
      ["Reference", "left"],
      ["Debit", "right"],
      ["Credit", "right"],
      ["Balance", "right"],
    ]),
    rows: statement.lines.map((line) => [
      formatDateOnly(line.date),
      line.description,
      line.referenceNumber === "" ? "—" : line.referenceNumber,
      line.debitCentavos === 0 ? "" : formatCentavos(line.debitCentavos),
      line.creditCentavos === 0 ? "" : formatCentavos(line.creditCentavos),
      formatCentavos(line.balanceCentavos),
    ]),
    totalsRows: [
      ["Opening balance", "", "", "", "", formatCentavos(statement.openingBalanceCentavos)],
      [
        "Totals",
        "",
        "",
        formatCentavos(statement.totalDebitsCentavos),
        formatCentavos(statement.totalCreditsCentavos),
        "",
      ],
      ["Closing balance", "", "", "", "", formatCentavos(statement.closingBalanceCentavos)],
    ],
    isEmpty: statement.lines.length === 0,
  };
}

// ─── The reports added by S6-1 and S6-5 ───────────────────────────────────────

/** A timestamp as "DD/MM/YYYY HH:MM", for the rows that carry one. */
function formatTimestamp(value: string): string {
  const [datePart = "", timePart = ""] = value.split("T");
  return `${formatDateOnly(datePart)} ${timePart.slice(0, 5)}`;
}

/** R7 — Weekly Collection Summary, one line per day. */
export function buildWeeklyCollectionView(report: WeeklyCollectionReport): DisplayTable {
  return collectionSummaryView(
    "Weekly Collection Summary",
    `Week of ${formatDateOnly(report.weekStartDate)}`,
    "Date",
    report
  );
}

/** R8 — Annual Collection Summary, one line per month. */
export function buildAnnualCollectionView(report: AnnualCollectionReport): DisplayTable {
  return collectionSummaryView(
    "Annual Collection Summary",
    `Calendar year ${report.year}`,
    "Month",
    report
  );
}

/** The table shared by the weekly and annual summaries: one line per period. */
function collectionSummaryView(
  title: string,
  subtitle: string,
  periodHeader: string,
  report: WeeklyCollectionReport | AnnualCollectionReport
): DisplayTable {
  return {
    title,
    subtitle,
    columns: headings([
      [periodHeader, "left"],
      ["Payments", "right"],
      ["Cash", "right"],
      ["GCash", "right"],
      ["Total", "right"],
    ]),
    rows: report.periods.map((period) => [
      period.periodLabel,
      formatCount(period.totals.paymentCount),
      formatCentavos(period.totals.cashTotalCentavos),
      formatCentavos(period.totals.gcashTotalCentavos),
      formatCentavos(period.totals.grandTotalCentavos),
    ]),
    totalsRows: [
      [
        "TOTAL",
        formatCount(report.totals.paymentCount),
        formatCentavos(report.totals.cashTotalCentavos),
        formatCentavos(report.totals.gcashTotalCentavos),
        formatCentavos(report.totals.grandTotalCentavos),
      ],
    ],
    isEmpty: report.periods.length === 0,
  };
}

/** R9 / R10 / R11 — billed revenue grouped by plan, service type, or area. */
export function buildRevenueView(report: RevenueReport): DisplayTable {
  const dimensionHeader =
    report.dimension === "plan"
      ? "Plan"
      : report.dimension === "service_type"
        ? "Service Type"
        : "Area";

  return {
    title:
      report.dimension === "plan"
        ? "Revenue by Plan"
        : report.dimension === "service_type"
          ? "Revenue by Service Type"
          : "Revenue by Area",
    subtitle: `${formatDateOnly(report.fromDate)} to ${formatDateOnly(report.toDate)}`,
    columns: headings([
      [dimensionHeader, "left"],
      ["Invoices", "right"],
      ["Billed", "right"],
      ["Collected", "right"],
      ["Outstanding", "right"],
    ]),
    rows: report.groups.map((group) => [
      group.groupLabel,
      formatCount(group.invoiceCount),
      formatCentavos(group.billedCentavos),
      formatCentavos(group.collectedCentavos),
      formatCentavos(group.outstandingCentavos),
    ]),
    totalsRows: [
      [
        "TOTAL",
        formatCount(report.totals.invoiceCount),
        formatCentavos(report.totals.billedCentavos),
        formatCentavos(report.totals.collectedCentavos),
        formatCentavos(report.totals.outstandingCentavos),
      ],
    ],
    isEmpty: report.groups.length === 0,
  };
}

/** R12 — Collector Assignment List. */
export function buildCollectorAssignmentView(
  report: CollectorAssignmentReport
): DisplayTable {
  return {
    title: "Collector Assignment List",
    subtitle: `${formatCount(report.accountCount)} account(s) across ${formatCount(report.collectorCount)} collector(s) and ${formatCount(report.areaCount)} area(s)`,
    columns: headings([
      ["Collector", "left"],
      ["Account #", "left"],
      ["Subscriber", "left"],
      ["Plan", "left"],
      ["Service Type", "left"],
      ["Area", "left"],
      ["Status", "left"],
    ]),
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
        `${formatCount(report.accountCount)} account(s)`,
        "",
        "",
        "",
        `${formatCount(report.areaCount)} area(s)`,
        "",
      ],
    ],
    isEmpty: report.lines.length === 0,
  };
}

/** R13 — Collector Performance. */
export function buildCollectorPerformanceView(
  report: CollectorPerformanceReport
): DisplayTable {
  return {
    title: "Collector Performance",
    subtitle: `${formatDateOnly(report.fromDate)} to ${formatDateOnly(report.toDate)}`,
    columns: headings([
      ["Collector", "left"],
      ["Assigned", "right"],
      ["Payments", "right"],
      ["Collected", "right"],
      ["Cash", "right"],
      ["GCash", "right"],
      ["Batches", "right"],
      ["Expected", "right"],
      ["Actual", "right"],
      ["Variance", "right"],
    ]),
    rows: report.groups.map((group) => [
      group.collectorName,
      formatCount(group.assignedAccountCount),
      formatCount(group.paymentCount),
      formatCentavos(group.collectedCentavos),
      formatCentavos(group.cashCentavos),
      formatCentavos(group.gcashCentavos),
      formatCount(group.batchCount),
      formatCentavos(group.expectedRemittanceCentavos),
      formatCentavos(group.actualRemittanceCentavos),
      formatCentavos(group.varianceCentavos),
    ]),
    totalsRows: [
      [
        "TOTAL",
        formatCount(report.totals.assignedAccountCount),
        formatCount(report.totals.paymentCount),
        formatCentavos(report.totals.collectedCentavos),
        formatCentavos(report.totals.cashCentavos),
        formatCentavos(report.totals.gcashCentavos),
        formatCount(report.totals.batchCount),
        formatCentavos(report.totals.expectedRemittanceCentavos),
        formatCentavos(report.totals.actualRemittanceCentavos),
        formatCentavos(report.totals.varianceCentavos),
      ],
    ],
    isEmpty: report.groups.length === 0,
  };
}

/** R14 — Payment Adjustment / Reversal Report. */
export function buildPaymentAdjustmentView(report: PaymentAdjustmentReport): DisplayTable {
  return {
    title: "Payment Adjustment / Reversal Report",
    subtitle: `${formatDateOnly(report.fromDate)} to ${formatDateOnly(report.toDate)} — ${formatCount(report.totals.reversalCount)} reversal(s)`,
    columns: headings([
      ["Receipt #", "left"],
      ["Reversal #", "left"],
      ["Payment Date", "left"],
      ["Reversed", "left"],
      ["Subscriber", "left"],
      ["Account #", "left"],
      ["Method", "left"],
      ["Amount", "right"],
      ["Reason", "left"],
      ["Reversed By", "left"],
    ]),
    rows: report.lines.map((line) => [
      line.receiptNumber,
      line.reversalReceiptNumber,
      formatDateOnly(line.paymentDate),
      formatTimestamp(line.reversedAt),
      line.subscriberName,
      line.serviceAccountNumber,
      PAYMENT_METHOD_LABELS[line.paymentMethod],
      formatCentavos(line.amountCentavos),
      line.reason,
      line.reversedByName,
    ]),
    totalsRows: [
      ["Cash reversed", "", "", "", "", "", "", formatCentavos(report.totals.cashReversedCentavos), "", ""],
      ["Non-cash reversed", "", "", "", "", "", "", formatCentavos(report.totals.nonCashReversedCentavos), "", ""],
      ["TOTAL", "", "", "", "", "", "", formatCentavos(report.totals.totalReversedCentavos), "", ""],
    ],
    isEmpty: report.lines.length === 0,
  };
}

/** R15 — Voided Receipt Report. */
export function buildVoidedReceiptView(report: VoidedReceiptReport): DisplayTable {
  return {
    title: "Voided Receipt Report",
    subtitle: `${formatDateOnly(report.fromDate)} to ${formatDateOnly(report.toDate)} — ${formatCount(report.totals.receiptCount)} voided receipt(s)`,
    columns: headings([
      ["Receipt #", "left"],
      ["Payment Date", "left"],
      ["Voided", "left"],
      ["Subscriber", "left"],
      ["Account #", "left"],
      ["Method", "left"],
      ["Amount", "right"],
      ["Reversal #", "left"],
      ["Reason", "left"],
    ]),
    rows: report.lines.map((line) => [
      line.receiptNumber,
      formatDateOnly(line.paymentDate),
      formatTimestamp(line.reversedAt),
      line.subscriberName,
      line.serviceAccountNumber,
      PAYMENT_METHOD_LABELS[line.paymentMethod],
      formatCentavos(line.amountCentavos),
      line.reversalReceiptNumber,
      line.reason,
    ]),
    totalsRows: [
      ["Cash voided", "", "", "", "", "", formatCentavos(report.totals.cashVoidedCentavos), "", ""],
      ["GCash voided", "", "", "", "", "", formatCentavos(report.totals.gcashVoidedCentavos), "", ""],
      ["TOTAL", "", "", "", "", "", formatCentavos(report.totals.totalVoidedCentavos), "", ""],
    ],
    isEmpty: report.lines.length === 0,
  };
}

/** R16 — User Activity Report. */
export function buildUserActivityView(report: UserActivityReport): DisplayTable {
  return {
    title: "User Activity Report",
    subtitle: `${formatDateOnly(report.fromDate)} to ${formatDateOnly(report.toDate)} — ${formatCount(report.totals.entryCount)} action(s) by ${formatCount(report.totals.userCount)} user(s)`,
    columns: headings([
      ["User", "left"],
      ["Action", "left"],
      ["Count", "right"],
      ["Last Performed", "left"],
    ]),
    rows: report.groups.map((group) => [
      group.username,
      group.action,
      formatCount(group.actionCount),
      formatTimestamp(group.lastPerformedAt),
    ]),
    totalsRows: [
      [
        "TOTAL",
        `${formatCount(report.totals.distinctActionCount)} distinct action(s)`,
        formatCount(report.totals.entryCount),
        "",
      ],
    ],
    isEmpty: report.groups.length === 0,
  };
}

/** R17 — Subscriber Master List, one line per service account. */
export function buildSubscriberMasterListView(
  report: SubscriberMasterListReport
): DisplayTable {
  return {
    title: "Subscriber Master List",
    subtitle: `${formatCount(report.subscriberCount)} subscriber(s), ${formatCount(report.accountCount)} service account(s)`,
    columns: headings([
      ["Subscriber", "left"],
      ["Account No", "left"],
      ["Phone", "left"],
      ["Email", "left"],
      ["Service Address", "left"],
      ["Area", "left"],
      ["Service Account", "left"],
      ["Plan", "left"],
      ["Service Type", "left"],
      ["Status", "left"],
      ["Collector", "left"],
    ]),
    rows: report.rows.map((row) => [
      row.subscriberName,
      row.subscriberAccountNumber,
      row.primaryPhone,
      row.emailAddress ?? "—",
      row.serviceAddress,
      row.areaName ?? "—",
      row.serviceAccountNumber ?? "—",
      row.planName ?? "—",
      row.serviceType === null ? "—" : SERVICE_TYPE_LABELS[row.serviceType],
      row.accountStatus === null ? "—" : SERVICE_ACCOUNT_STATUS_LABELS[row.accountStatus],
      row.collectorName ?? "—",
    ]),
    totalsRows: [
      [
        "TOTAL",
        `${formatCount(report.subscriberCount)} subscriber(s)`,
        "",
        "",
        "",
        "",
        `${formatCount(report.accountCount)} account(s)`,
        "",
        "",
        "",
        "",
      ],
    ],
    isEmpty: report.rows.length === 0,
  };
}

/** R18 / S6-5 — Audit Trail Report, with the export-cap notice when it applies. */
export function buildAuditLogView(report: AuditLogReport): DisplayTable {
  const omitted = report.totalRows - report.rows.length;
  const notice = report.isTruncated
    ? `Showing the first ${formatCount(report.rows.length)} of ${formatCount(report.totalRows)} entries — the ${formatCount(report.rowLimit)}-row cap omitted ${formatCount(omitted)}. Narrow the filters to see the rest.`
    : undefined;

  return {
    title: "Audit Trail Report",
    subtitle: `${formatDateOnly(report.fromDate)} to ${formatDateOnly(report.toDate)} — ${formatCount(report.totalRows)} entr(ies)`,
    columns: headings([
      ["Performed At", "left"],
      ["User", "left"],
      ["Action", "left"],
      ["Entity", "left"],
      ["Entity Id", "left"],
      ["Description", "left"],
      ["Client IP", "left"],
    ]),
    rows: report.rows.map((row) => [
      formatTimestamp(row.performedAt),
      row.performedByUsername ?? "—",
      row.action,
      row.entityType,
      row.entityId,
      row.description,
      row.clientIpAddress ?? "—",
    ]),
    totalsRows: [
      [
        "TOTAL",
        `${formatCount(report.rowLimit)}-row cap`,
        "",
        "",
        "",
        `${formatCount(report.totalRows)} entr(ies)`,
        "",
      ],
    ],
    isEmpty: report.rows.length === 0,
    ...(notice === undefined ? {} : { notice }),
  };
}
