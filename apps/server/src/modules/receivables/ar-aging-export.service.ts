// Builds the AR aging workbook for export.
//
// The numbers are written as WHOLE CENTAVOS so no peso amount is ever converted
// through a floating-point value. The column headers say so explicitly.

import type { ArAgingReport } from "./ar-aging.service";
import { buildXlsxWorkbook, type XlsxRow } from "./xlsx-writer";

export const AR_AGING_EXPORT_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** "AR-aging-2025-01-31.xlsx" for an as-of date. */
export function arAgingExportFileName(asOfDate: string): string {
  return `AR-aging-${asOfDate}.xlsx`;
}

/** The worksheet rows: a header, one row per service account, then the totals row. */
export function buildArAgingRows(report: ArAgingReport): XlsxRow[] {
  const header: XlsxRow = [
    "Subscriber",
    "Account #",
    "Plan",
    "Current (centavos)",
    "1-30 Days (centavos)",
    "31-60 Days (centavos)",
    "61-90 Days (centavos)",
    "90+ Days (centavos)",
    "Total (centavos)",
  ];

  const detailRows: XlsxRow[] = report.entries.map((entry) => [
    entry.subscriberName,
    entry.serviceAccountNumber,
    entry.planName,
    entry.currentCentavos,
    entry.bucket_1_30_centavos,
    entry.bucket_31_60_centavos,
    entry.bucket_61_90_centavos,
    entry.over_90_centavos,
    entry.totalOutstandingCentavos,
  ]);

  const totalsRow: XlsxRow = [
    "TOTAL",
    `${report.entries.length} account(s)`,
    "",
    report.totals.current,
    report.totals.bucket_1_30,
    report.totals.bucket_31_60,
    report.totals.bucket_61_90,
    report.totals.over_90,
    report.totals.grandTotal,
  ];

  return [
    [`Accounts Receivable Aging — as of ${report.asOfDate}`],
    [],
    header,
    ...detailRows,
    totalsRow,
  ];
}

/** The complete .xlsx bytes for an AR aging report. */
export function buildArAgingWorkbook(report: ArAgingReport): Uint8Array {
  return buildXlsxWorkbook("AR Aging", buildArAgingRows(report));
}