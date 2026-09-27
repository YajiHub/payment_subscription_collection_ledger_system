// The row cap that keeps a report export bounded (S6-6).
//
// A report is assembled in memory before it is written to a PDF or a spreadsheet,
// so an unbounded result set is an unbounded allocation. The cap below is the
// largest number of data rows an export will render. It is deliberately generous —
// it is a guard rail, not a pagination scheme — and, just as importantly, it is
// VISIBLE: a truncated export says so in its own header and in the response, so it
// can never quietly present a partial answer as the whole one.
//
// Why 5000: the section 4.5 scale target is 20,000 subscribers, and the densest
// reports (the subscriber master list and the audit trail) are the ones that would
// reach four or five digits on a real deployment. 5,000 rows is a ~2 MB spreadsheet
// and a manageable PDF, which the dependency-free writers render without a stall,
// while a whole-book dump of tens of thousands of rows is exactly the case the cap
// exists to stop. A caller who needs more narrows the filters — a date range, an
// area, a collector — and exports again.

import type { ReportRow } from "../../shared/reports/report-table";

/** The largest number of data rows one export will render. */
export const MAX_REPORT_EXPORT_ROWS = 5000;

export interface CappedRows {
  rows: readonly ReportRow[];
  /** The number of rows the report had before the cap was applied. */
  totalRows: number;
  /** True when rows had to be dropped to stay within the cap. */
  isTruncated: boolean;
}

/**
 * Keeps at most `maxRows` rows, reporting what was dropped.
 *
 * The caller is expected to render `isTruncated` into the document — the cap is a
 * promise about the file's size, not a licence to lie about its contents.
 */
export function capReportRows(
  rows: readonly ReportRow[],
  maxRows: number = MAX_REPORT_EXPORT_ROWS
): CappedRows {
  if (rows.length <= maxRows) {
    return { rows, totalRows: rows.length, isTruncated: false };
  }
  return { rows: rows.slice(0, maxRows), totalRows: rows.length, isTruncated: true };
}

/** The sentence a truncated report carries, in the same words in every format. */
export function truncationNotice(renderedRows: number, totalRows: number): string {
  return `Showing the first ${renderedRows.toLocaleString("en-US")} of ${totalRows.toLocaleString("en-US")} rows — narrow the filters to export the rest.`;
}
