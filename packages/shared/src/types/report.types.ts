// Request validation schemas for the dashboard and the report endpoints.
//
// These schemas are the contract between the client and the server: the server
// parses every query string and body with one of them before touching the
// database, so a malformed request always becomes a readable 400.
//
// Every monetary value in a report is an integer number of centavos. Nothing in
// this file performs arithmetic; the report services own that.

import { z } from "zod";

import { ALL_REPORT_TYPES, REPORT_EXPORT_FORMATS } from "../constants/reports";
import { SERVICE_ACCOUNT_STATUSES, SERVICE_TYPES } from "../constants/service-accounts";
import { calendarDateSchema } from "./calendar-date";
import { queryNumber } from "./query-number";

/**
 * A calendar day in the office's local timezone, e.g. "2025-01-24".
 *
 * Validated for existence as well as shape: "2026-02-30" is refused rather than
 * silently rolling forward to 2 March or crashing the report downstream.
 */
const dateOnlySchema = calendarDateSchema;

/** A calendar month filter: a plausible four-digit year and a 1–12 month. */
const monthFilterFields = {
  year: queryNumber("year", (schema) => schema.int().min(2000).max(2100)),
  month: queryNumber("month", (schema) => schema.int().min(1).max(12)),
};

// ─── The filters every report shares (S6-2) ──────────────────────────────────
//
// Every one of these is optional, and every one that is present MUST narrow the
// SQL result. `fromDate` and `toDate` are BOTH INCLUSIVE calendar days; the report
// services convert them the way their own date column needs. A filter written into
// a query string and ignored by the query is the defect the audit flagged, so the
// services build their `where` clause from these fields directly.
//
// The ACCOUNT filters are separated from the date range because a snapshot report
// (AR aging, outstanding by collector, collector assignment) narrows by account
// but has no date range at all. Declaring the range on those reports would allow a
// filter the query cannot apply — an accepted-and-ignored filter is the very
// defect (S6-2) — so their schemas take `reportAccountFilterFields` and refuse a
// date range outright (D7).
export const reportAccountFilterFields = {
  /** Only rows whose account is assigned to this collector. */
  collectorId: z.string().uuid("The collector id must be a UUID").optional(),
  /** Only rows whose account sits in this collection area. */
  areaId: z.string().uuid("The area id must be a UUID").optional(),
  /** Only rows whose account is on this subscription plan. */
  planId: z.string().uuid("The plan id must be a UUID").optional(),
  /** Only rows whose plan is of this service type. */
  serviceType: z.enum(SERVICE_TYPES).optional(),
};

export const reportFilterFields = {
  /** First day of the range, inclusive. */
  fromDate: dateOnlySchema.optional(),
  /** Last day of the range, inclusive. */
  toDate: dateOnlySchema.optional(),
  ...reportAccountFilterFields,
};

/**
 * The filters a report endpoint accepts: the shared set, and nothing else.
 *
 * `.strict()` so a parameter the report does not read is a readable 400 rather
 * than being silently stripped — a caller can never believe a filter applied when
 * it did not.
 */
export const reportFiltersSchema = z.object(reportFilterFields).strict();
export type ReportFilterFields = z.infer<typeof reportFiltersSchema>;

/**
 * GET /api/reports/daily-collection — the day to summarise.
 * Defaults to today when omitted, so the end-of-day cash count needs no argument.
 */
export const dailyCollectionReportQuerySchema = z
  .object({
    date: dateOnlySchema.optional(),
  })
  .strict();
export type DailyCollectionReportQuery = z.infer<typeof dailyCollectionReportQuerySchema>;

/**
 * GET /api/reports/weekly-collection — collections for a week, day by day (R7).
 *
 * With neither date supplied the week is the current Monday..Sunday. Supply both to
 * report on a different week; the range is inclusive at both ends.
 */
export const weeklyCollectionReportQuerySchema = reportFiltersSchema;
export type WeeklyCollectionReportQuery = z.infer<typeof weeklyCollectionReportQuerySchema>;

/**
 * GET /api/reports/annual-collection — collections for a year, month by month (R8).
 * Defaults to the current calendar year.
 */
export const annualCollectionReportQuerySchema = z
  .object({
    year: queryNumber("year", (schema) => schema.int().min(2000).max(2100)).optional(),
    ...reportAccountFilterFields,
  })
  .strict();
export type AnnualCollectionReportQuery = z.infer<typeof annualCollectionReportQuerySchema>;

/** GET /api/reports/revenue-by-plan|service-type|area — the billed-revenue range. */
export const revenueReportQuerySchema = reportFiltersSchema;
export type RevenueReportQuery = z.infer<typeof revenueReportQuerySchema>;

/**
 * GET /api/reports/collector-assignment — a current snapshot, so no date range.
 *
 * The date range is NOT declared: an assignment is a current fact, and a report
 * that accepted a range it cannot apply would be the accepted-but-ignored filter
 * this module exists to prevent (D7). `.strict()` refuses a stray `fromDate`.
 */
export const collectorAssignmentReportQuerySchema = z
  .object(reportAccountFilterFields)
  .strict();
export type CollectorAssignmentReportQuery = z.infer<typeof collectorAssignmentReportQuerySchema>;

/** GET /api/reports/collector-performance — what each collector collected and remitted. */
export const collectorPerformanceReportQuerySchema = reportFiltersSchema;
export type CollectorPerformanceReportQuery = z.infer<
  typeof collectorPerformanceReportQuerySchema
>;

/** GET /api/reports/payment-adjustments — reversals inside a date range. */
export const paymentAdjustmentReportQuerySchema = reportFiltersSchema;
export type PaymentAdjustmentReportQuery = z.infer<typeof paymentAdjustmentReportQuerySchema>;

/** GET /api/reports/voided-receipts — voided receipts inside a date range. */
export const voidedReceiptReportQuerySchema = reportFiltersSchema;
export type VoidedReceiptReportQuery = z.infer<typeof voidedReceiptReportQuerySchema>;

/**
 * GET /api/reports/user-activity — auditable actions per user inside a date range.
 * The collector/area/plan/service-type filters do not apply: an audit row is about
 * a person and an action, not about a subscriber's account.
 */
export const userActivityReportQuerySchema = z
  .object({
    fromDate: dateOnlySchema.optional(),
    toDate: dateOnlySchema.optional(),
    performedBy: z.string().uuid("The user id must be a UUID").optional(),
    action: z.string().trim().max(100).optional(),
  })
  .strict();
export type UserActivityReportQuery = z.infer<typeof userActivityReportQuerySchema>;

/**
 * GET /api/reports/subscriber-master-list — every subscriber and their accounts.
 * A current snapshot, so it has no date range; the account filters still apply.
 */
export const subscriberMasterListReportQuerySchema = z
  .object({
    collectorId: z.string().uuid("The collector id must be a UUID").optional(),
    areaId: z.string().uuid("The area id must be a UUID").optional(),
    planId: z.string().uuid("The plan id must be a UUID").optional(),
    serviceType: z.enum(SERVICE_TYPES).optional(),
    serviceStatus: z.enum(SERVICE_ACCOUNT_STATUSES).optional(),
  })
  .strict();
export type SubscriberMasterListReportQuery = z.infer<
  typeof subscriberMasterListReportQuerySchema
>;

/**
 * GET /api/reports/audit-log — the audit trail as a report (S6-5).
 * Needs `audit:read`, exactly as the audit screen does.
 */
export const auditLogReportQuerySchema = z
  .object({
    fromDate: dateOnlySchema.optional(),
    toDate: dateOnlySchema.optional(),
    performedBy: z.string().uuid("The user id must be a UUID").optional(),
    action: z.string().trim().max(100).optional(),
    entityType: z.string().trim().max(50).optional(),
  })
  .strict();
export type AuditLogReportQuery = z.infer<typeof auditLogReportQuerySchema>;

/** GET /api/reports/monthly-billing — the billing period to summarise. */
export const monthlyBillingReportQuerySchema = z.object(monthFilterFields);
export type MonthlyBillingReportQuery = z.infer<typeof monthlyBillingReportQuerySchema>;

/**
 * GET /api/reports/ar-aging — the "as of" day for the aging buckets.
 *
 * `asOf` is the name Phase 8 documents; `asOfDate` is accepted as well so the
 * Phase 7 receivables route and this one can be called with the same parameters.
 */
export const arAgingReportQuerySchema = z
  .object({
    asOf: dateOnlySchema.optional(),
    asOfDate: dateOnlySchema.optional(),
    ...reportAccountFilterFields,
  })
  .strict();
export type ArAgingReportQuery = z.infer<typeof arAgingReportQuerySchema>;

/** GET /api/reports/collector-remittance — the batch to report on. */
export const collectorRemittanceQuerySchema = z.object({
  batchId: z.string().uuid("A collector batch id is required"),
});
export type CollectorRemittanceQuery = z.infer<typeof collectorRemittanceQuerySchema>;

/** The filters a report export may carry. Only the chosen report reads them. */
const reportExportParamsSchema = z.object({
  date: dateOnlySchema.optional(),
  // These two belong to a POST body (reportExportBodySchema), not a query string,
  // so they keep the plain coercing number: body values are already JSON numbers.
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  asOf: dateOnlySchema.optional(),
  batchId: z.string().uuid("The batch id must be a UUID").optional(),
  serviceAccountId: z.string().uuid("The service account id must be a UUID").optional(),
  fromDate: dateOnlySchema.optional(),
  toDate: dateOnlySchema.optional(),
  // The shared report filters (S6-2): the export path reads the same fields the
  // on-screen endpoint does, so a filtered screen and its export agree.
  collectorId: z.string().uuid("The collector id must be a UUID").optional(),
  areaId: z.string().uuid("The area id must be a UUID").optional(),
  planId: z.string().uuid("The plan id must be a UUID").optional(),
  serviceType: z.enum(SERVICE_TYPES).optional(),
  serviceStatus: z.enum(SERVICE_ACCOUNT_STATUSES).optional(),
  performedBy: z.string().uuid("The user id must be a UUID").optional(),
  action: z.string().trim().max(100).optional(),
  entityType: z.string().trim().max(50).optional(),
}).strict();

/**
 * The reports whose date range the export path must not accept, because no query
 * applies it.
 *
 * AR aging and outstanding by collector are "as of" snapshots, collector
 * assignment is a current snapshot, and annual collection is scoped by `year`.
 * A range on any of them would be accepted and ignored, so the export body refuses
 * it exactly as the on-screen schemas do (D7).
 */
const SNAPSHOT_OR_YEAR_SCOPED_REPORTS: readonly string[] = [
  "ar_aging",
  "outstanding_by_collector",
  "collector_assignment",
  "annual_collection",
];

/**
 * POST /api/reports/export-pdf and POST /api/reports/export-xlsx.
 *
 * Each report needs its own parameters, so the body is rejected with a readable
 * message when a report is asked for without the parameters it reads: a monthly
 * billing export without a period would silently produce an empty file.
 */
export const reportExportBodySchema = z
  .object({
    reportType: z.enum(ALL_REPORT_TYPES),
    params: reportExportParamsSchema.default({}),
  })
  .strict()
  .superRefine((value, context) => {
    function requireParameter(fieldName: string, isPresent: boolean, message: string): void {
      if (!isPresent) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["params", fieldName],
          message,
        });
      }
    }

    if (value.reportType === "monthly_billing") {
      requireParameter("year", value.params.year !== undefined, "A year is required");
      requireParameter("month", value.params.month !== undefined, "A month is required");
    }

    if (value.reportType === "collector_remittance") {
      requireParameter("batchId", value.params.batchId !== undefined, "A batch id is required");
    }

    if (value.reportType === "subscriber_soa") {
      requireParameter(
        "serviceAccountId",
        value.params.serviceAccountId !== undefined,
        "A service account id is required"
      );
    }

    // A snapshot or year-scoped report must not be handed a date range it cannot
    // apply: refusing it here is the same honesty the on-screen schema enforces.
    if (SNAPSHOT_OR_YEAR_SCOPED_REPORTS.includes(value.reportType)) {
      for (const fieldName of ["fromDate", "toDate"] as const) {
        if (value.params[fieldName] !== undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["params", fieldName],
            message: `The ${value.reportType} report is a snapshot and does not accept a date range`,
          });
        }
      }
    }
  });
export type ReportExportBody = z.infer<typeof reportExportBodySchema>;

/** The export format a download URL asks for, as a query parameter. */
export const reportExportFormatSchema = z.enum(REPORT_EXPORT_FORMATS);
