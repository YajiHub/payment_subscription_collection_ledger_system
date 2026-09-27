// Turns a report table into an .xlsx workbook.
//
// The low-level part-writing (see ./xlsx-writer.ts) is deliberately dependency-free.
// This file is the report-shaped layer on top of it: a title, a subtitle, the
// column headers, the data rows, and the totals row.
//
// MONEY (S6-4). A money cell holds an integer number of centavos all the way to this
// boundary and is then written as a decimal peso value carrying Excel's
// `"PHP" #,##0.00` number format. The centavos are split with integer arithmetic, so
// no calculation ever passes through a floating-point peso amount — only the cell's
// written form is a decimal. The column header no longer claims "(centavos)": the
// unit is in the cell's number format, where a reader of the spreadsheet can see it.
//
// A count column stays a plain whole number, because a count is not money.

import type { ReportColumn, ReportTable } from "../reports/report-table";
import { buildXlsxWorkbook, moneyCell, type XlsxCell, type XlsxRow } from "./xlsx-writer";

export const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * One row of cells, converting each money column's centavos into a formatted cell.
 *
 * The column order is the single source of truth for which cells are money, so a
 * value can never be formatted as money merely because it looks like a number.
 */
function rowCells(row: readonly (string | number)[], columns: readonly ReportColumn[]): XlsxCell[] {
  return row.map((value, columnIndex) =>
    columns[columnIndex]?.format === "money" && typeof value === "number"
      ? moneyCell(value)
      : value
  );
}

/** The workbook rows: title, subtitle, blank line, headers, data, totals. */
export function buildReportRows(table: ReportTable): XlsxRow[] {
  const rows: XlsxRow[] = [[table.title]];

  if (table.subtitle !== null) {
    rows.push([table.subtitle]);
  }
  rows.push([]);

  rows.push(table.columns.map((column) => column.header));
  rows.push(...table.rows.map((row) => rowCells(row, table.columns)));
  rows.push(...table.totalsRows.map((row) => rowCells(row, table.columns)));

  return rows;
}

/** The complete .xlsx bytes for a report. */
export function generateReportXlsx(table: ReportTable): Uint8Array {
  return buildXlsxWorkbook(table.title, buildReportRows(table));
}
