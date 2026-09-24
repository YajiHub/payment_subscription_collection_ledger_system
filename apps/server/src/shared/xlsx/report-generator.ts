// Turns a report table into an .xlsx workbook.
//
// The low-level part-writing (see ./xlsx-writer.ts) is deliberately dependency-free.
// This file is the report-shaped layer on top of it: a title, a subtitle, the
// column headers, the data rows, and the totals row.
//
// Money cells stay EXACT INTEGER CENTAVOS. A spreadsheet must not inherit a
// rounded peso figure, and the low-level writer has no number formats, so a money
// column's header says "(centavos)" instead. The PDF of the same report prints
// the formatted peso amount from the very same centavos value.

import type { ReportColumn, ReportTable } from "../reports/report-table";
import { buildXlsxWorkbook, type XlsxRow } from "./xlsx-writer";

export const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** The header text for a column, naming the unit a money column is stored in. */
function columnHeader(column: ReportColumn): string {
  return column.format === "money" ? `${column.header} (centavos)` : column.header;
}

/** The workbook rows: title, subtitle, blank line, headers, data, totals. */
export function buildReportRows(table: ReportTable): XlsxRow[] {
  const rows: XlsxRow[] = [[table.title]];

  if (table.subtitle !== null) {
    rows.push([table.subtitle]);
  }
  rows.push([]);

  rows.push(table.columns.map(columnHeader));
  rows.push(...table.rows.map((row) => [...row]));
  rows.push(...table.totalsRows.map((row) => [...row]));

  return rows;
}

/** The complete .xlsx bytes for a report. */
export function generateReportXlsx(table: ReportTable): Uint8Array {
  return buildXlsxWorkbook(table.title, buildReportRows(table));
}
