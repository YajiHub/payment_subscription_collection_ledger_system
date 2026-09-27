// The report vocabulary shared by the client and the server.
//
// The strings here are the contract between the Reports Center and the report
// endpoints: a report is chosen by one of these names, and an export is asked for
// in one of these formats. Neither side invents a name of its own.
//
// Money never appears here. Every amount in a report is an integer number of
// centavos (see types/money.ts); the client formats them for display and the
// export generators format them for the document they produce.

import type { Permission } from "./permissions";

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

/**
 * The reports added by S6-1 and S6-5.
 *
 * They are declared separately from `REPORT_TYPES` on purpose. The Reports Center
 * switches exhaustively on `ReportType`; widening that union in this pass would
 * break the renderer before the client half of S6-1 lands, and the client half is
 * a later work package. Every map below covers `AnyReportType`, so a new report has
 * a label, a description, a view permission and an export name from the moment it
 * exists — it is first-class in the catalogue, only the renderer's switch statements
 * still name the original six. When the client catches up it merges the two unions
 * and deletes this comment.
 */
export const EXTENDED_REPORT_TYPES = [
  "weekly_collection", // R7 — collections for one week, day by day
  "annual_collection", // R8 — collections for one year, month by month
  "revenue_by_plan", // R9 — billed revenue per subscription plan
  "revenue_by_service_type", // R10 — billed revenue per service type
  "revenue_by_area", // R11 — billed revenue per collection area
  "collector_assignment", // R12 — which accounts each collector covers
  "collector_performance", // R13 — what each collector collected and remitted
  "payment_adjustments", // R14 — every payment reversal in a period
  "voided_receipts", // R15 — every receipt that no longer stands
  "user_activity", // R16 — audit entries per user and action
  "subscriber_master_list", // R17 — every subscriber and their account
  "audit_log", // R18 — the audit trail as an exportable report (S6-5)
] as const;
export type ExtendedReportType = (typeof EXTENDED_REPORT_TYPES)[number];

/** The whole catalogue: the six original families plus every report added since. */
export const ALL_REPORT_TYPES = [...REPORT_TYPES, ...EXTENDED_REPORT_TYPES] as const;
export type AnyReportType = (typeof ALL_REPORT_TYPES)[number];

/** Human-readable report names, used in the Reports Center sidebar. */
export const REPORT_TYPE_LABELS = {
  daily_collection: "Daily Collection Summary",
  monthly_billing: "Monthly Billing Summary",
  ar_aging: "AR Aging Report",
  subscriber_soa: "Subscriber Statement of Account",
  collector_remittance: "Collector Remittance Report",
  outstanding_by_collector: "Outstanding Receivables by Collector",
  weekly_collection: "Weekly Collection Summary",
  annual_collection: "Annual Collection Summary",
  revenue_by_plan: "Revenue by Plan",
  revenue_by_service_type: "Revenue by Service Type",
  revenue_by_area: "Revenue by Area",
  collector_assignment: "Collector Assignment List",
  collector_performance: "Collector Performance",
  payment_adjustments: "Payment Adjustment / Reversal Report",
  voided_receipts: "Voided Receipt Report",
  user_activity: "User Activity Report",
  subscriber_master_list: "Subscriber Master List",
  audit_log: "Audit Trail Report",
} as const satisfies Record<AnyReportType, string>;
export const REPORT_TYPE_DESCRIPTIONS = {
  daily_collection: "Every payment posted on one day, for the end-of-day cash count.",
  monthly_billing: "Every invoice generated for one billing period, for management review.",
  ar_aging: "Outstanding balances bucketed by how long they are past due.",
  subscriber_soa: "One subscriber's full financial history, for printing and handing over.",
  collector_remittance: "What a collector collected and handed in, with the variance.",
  outstanding_by_collector: "Which collector's assigned accounts carry the most overdue balance.",
  weekly_collection: "Collections for one week, day by day, for the weekly cash review.",
  annual_collection: "Collections for one year, month by month, for the year-end review.",
  revenue_by_plan: "Billed revenue per subscription plan for a date range.",
  revenue_by_service_type: "Billed revenue per service type (Internet, Cable TV, Bundle).",
  revenue_by_area: "Billed revenue per collection area, for route planning.",
  collector_assignment: "Which service accounts each collector is responsible for.",
  collector_performance: "What each collector collected and remitted over a date range.",
  payment_adjustments: "Every payment reversal in a period, with its reason.",
  voided_receipts: "Every receipt that was voided by a payment reversal.",
  user_activity: "How many auditable actions each user performed, by action.",
  subscriber_master_list: "Every subscriber with their contact, address, plan and balance.",
  audit_log: "The audit trail over a date range, filtered by user, action or entity.",
} as const satisfies Record<AnyReportType, string>;

/**
 * The permission a role needs to view each report (Phase 8 §9).
 *
 * Daily collection and the collector remittance are operational reports: the Cashier
 * runs the cash count and reviews the batch, and the Collector reads their own batch.
 * The monthly billing, AR aging, and outstanding-by-collector reports summarise the
 * business's money, so they are management views — a Cashier may not read them.
 * The server enforces this per route; the Reports Center uses the same map to hide
 * the sidebar entries a role cannot open.
 *
 * The weekly collection is operational (the same cash count, one week long). Every
 * other new report either exposes the whole ledger (revenue, adjustments, voided
 * receipts, collector coverage) or bulk personal data (the subscriber master list),
 * so it is a management view. User activity and the audit trail need `audit:read`,
 * exactly as the audit screen does.
 */
export const REPORT_TYPE_VIEW_PERMISSIONS = {
  daily_collection: "reports:view",
  monthly_billing: "reports:management_view",
  ar_aging: "reports:management_view",
  subscriber_soa: "reports:view",
  collector_remittance: "reports:view",
  outstanding_by_collector: "reports:management_view",
  weekly_collection: "reports:view",
  annual_collection: "reports:management_view",
  revenue_by_plan: "reports:management_view",
  revenue_by_service_type: "reports:management_view",
  revenue_by_area: "reports:management_view",
  collector_assignment: "reports:management_view",
  collector_performance: "reports:management_view",
  payment_adjustments: "reports:management_view",
  voided_receipts: "reports:management_view",
  user_activity: "audit:read",
  subscriber_master_list: "reports:management_view",
  audit_log: "audit:read",
} as const satisfies Record<AnyReportType, Permission>;

/**
 * The reports that read the audit trail and therefore need `audit:read` in
 * addition to `reports:export` when they are exported (S6-5).
 *
 * The export route is shared by every report, so the extra check lives in the
 * export handler rather than in a separate route: a Manager holds `reports:export`
 * but not `audit:read`, and must not be able to take the audit trail out of the
 * building through the export path.
 */
export const REPORT_TYPES_NEEDING_AUDIT_READ = ["user_activity", "audit_log"] as const;
export type AuditReadReportType = (typeof REPORT_TYPES_NEEDING_AUDIT_READ)[number];

/** True when a report reads the audit trail and so needs `audit:read`. */
export function reportNeedsAuditRead(reportType: AnyReportType): reportType is AuditReadReportType {
  return (REPORT_TYPES_NEEDING_AUDIT_READ as readonly string[]).includes(reportType);
}

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
