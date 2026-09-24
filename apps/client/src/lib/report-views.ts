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
} from "@bcis/shared";
import { formatCentavos, formatDateOnly } from "./format";
import type {
  CollectorRemittanceReport,
  DailyCollectionReport,
  MonthlyBillingReport,
  OutstandingByCollectorReport,
  ArAgingReport,
  ServiceAccountStatement,
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
