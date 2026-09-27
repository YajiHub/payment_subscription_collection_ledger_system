// Builds the AR aging workbook for export.
//
// The money columns carry INTEGER CENTAVOS and are written as formatted peso cells
// (S6-4), so the spreadsheet shows human-readable amounts without any floating-point
// arithmetic on the way.

import type { ArAgingReport } from "./ar-aging.service";
import { buildXlsxWorkbook, moneyCell, type XlsxRow } from "../../shared/xlsx/xlsx-writer";

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
    "Current",
    "1-30 Days",
    "31-60 Days",
    "61-90 Days",
    "90+ Days",
    "Total",
  ];

  const detailRows: XlsxRow[] = report.entries.map((entry) => [
    entry.subscriberName,
    entry.serviceAccountNumber,
    entry.planName,
    moneyCell(entry.currentCentavos),
    moneyCell(entry.bucket_1_30_centavos),
    moneyCell(entry.bucket_31_60_centavos),
    moneyCell(entry.bucket_61_90_centavos),
    moneyCell(entry.over_90_centavos),
    moneyCell(entry.totalOutstandingCentavos),
  ]);

  const totalsRow: XlsxRow = [
    "TOTAL",
    `${report.entries.length} account(s)`,
    "",
    moneyCell(report.totals.current),
    moneyCell(report.totals.bucket_1_30),
    moneyCell(report.totals.bucket_31_60),
    moneyCell(report.totals.bucket_61_90),
    moneyCell(report.totals.over_90),
    moneyCell(report.totals.grandTotal),
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
