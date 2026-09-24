// Report vocabulary shared by the client and the server.
//
// The strings here are the contract between the Reports Center and the report
// endpoints: a report is chosen by one of these names, and an export is asked for
// in one of these formats. Neither side invents a name of its own.
//
// Money never appears here. Every amount in a report is an integer number of
// centavos (see types/money.ts); the client formats them for display and the
// export generators format them for the document they produce.

// ─── Report types ─────────────────────────────────────────────────────────────

/** Every report the Reports Center can produce. */
export const REPORT_TYPES = [
  "daily_collection", // R1 — everything collected on one day, for the cash count
  "monthly_billing", // R2 — every invoice generated for one billing period
  "ar_aging", // R3 — outstanding balances by how long they are past due
  "subscriber_soa", // R4 — one subscriber's statement of account, for printing
  "collector_remittance", // R5 — one batch, for the remittance reconciliation
  "outstanding_by_collector", // R6 — receivables grouped by the assigned collector
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

/** Human-readable report names, used in the Reports Center sidebar. */
export const REPORT_TYPE_LABELS = {
  daily_collection: "Daily Collection Summary",
  monthly_billing: "Monthly Billing Summary",
  ar_aging: "AR Aging Report",
  subscriber_soa: "Subscriber Statement of Account",
  collector_remittance: "Collector Remittance Report",
  outstanding_by_collector: "Outstanding Receivables by Collector",
} as const satisfies Record<ReportType, string>;

/** What each report answers — the one-line purpose shown under its name. */
export const REPORT_TYPE_DESCRIPTIONS = {
  daily_collection: "Every payment posted on one day, for the end-of-day cash count.",
  monthly_billing: "Every invoice generated for one billing period, for management review.",
  ar_aging: "Outstanding balances bucketed by how long they are past due.",
  subscriber_soa: "One subscriber's full financial history, for printing and handing over.",
  collector_remittance: "What a collector collected and handed in, with the variance.",
  outstanding_by_collector: "Which collector's assigned accounts carry the most overdue balance.",
} as const satisfies Record<ReportType, string>;

// ─── Export formats ───────────────────────────────────────────────────────────

/** The file formats a report can be exported to. */
export const REPORT_EXPORT_FORMATS = ["pdf", "xlsx"] as const;
export type ReportExportFormat = (typeof REPORT_EXPORT_FORMATS)[number];

/** Human-readable format names, used on the export buttons. */
export const REPORT_EXPORT_FORMAT_LABELS = {
  pdf: "PDF",
  xlsx: "XLSX",
} as const satisfies Record<ReportExportFormat, string>;

/** The file extension for each export format, without the leading dot. */
export const REPORT_EXPORT_FORMAT_EXTENSIONS = {
  pdf: "pdf",
  xlsx: "xlsx",
} as const satisfies Record<ReportExportFormat, string>;
