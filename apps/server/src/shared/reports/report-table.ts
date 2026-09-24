// Shared report infrastructure: the shape every report takes before it is printed
// or written to a spreadsheet.
//
// A report is built once, as a table. The PDF generator and the XLSX generator
// both read that one table, so a printed report and a spreadsheet can never show
// different numbers — the difference between them is presentation only.
//
// A money column holds an INTEGER NUMBER OF CENTAVOS and says so through its
// `format`. Each generator decides how to render it (the PDF writes "PHP 1,234.56";
// the spreadsheet writes the exact integer centavos and labels the column), but
// neither of them ever converts money through a floating-point peso amount.

/** How a column's values should be rendered. */
export type ReportColumnFormat = "text" | "money" | "count";

export interface ReportColumn {
  header: string;
  format: ReportColumnFormat;
}

/** One cell: text for a "text" column, a whole number for "money" and "count". */
export type ReportCell = string | number;

/** One row, in the same order as the table's columns. */
export type ReportRow = readonly ReportCell[];

export interface ReportTable {
  title: string;
  /** Printed under the title, e.g. the period the report covers. */
  subtitle: string | null;
  columns: readonly ReportColumn[];
  rows: readonly ReportRow[];
  /**
   * The totals lines. A list rather than one row because some reports need more
   * than one — a daily collection summary shows a cash total, a GCash total, and a
   * grand total, and each must be readable on its own line.
   */
  totalsRows: readonly ReportRow[];
  /** Landscape keeps a wide report (several money columns) readable on paper. */
  orientation: "portrait" | "landscape";
}
