// Request validation schemas for the dashboard and the report endpoints.
//
// These schemas are the contract between the client and the server: the server
// parses every query string and body with one of them before touching the
// database, so a malformed request always becomes a readable 400.
//
// Every monetary value in a report is an integer number of centavos. Nothing in
// this file performs arithmetic; the report services own that.

import { z } from "zod";

import { REPORT_EXPORT_FORMATS, REPORT_TYPES } from "../constants/reports";

/** A calendar day in the office's local timezone, e.g. "2025-01-24". */
const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "A date is required in YYYY-MM-DD format");

/** A calendar month filter: a plausible four-digit year and a 1–12 month. */
const monthFilterFields = {
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
};

/**
 * GET /api/reports/daily-collection — the day to summarise.
 * Defaults to today when omitted, so the end-of-day cash count needs no argument.
 */
export const dailyCollectionReportQuerySchema = z.object({
  date: dateOnlySchema.optional(),
});
export type DailyCollectionReportQuery = z.infer<typeof dailyCollectionReportQuerySchema>;

/** GET /api/reports/monthly-billing — the billing period to summarise. */
export const monthlyBillingReportQuerySchema = z.object(monthFilterFields);
export type MonthlyBillingReportQuery = z.infer<typeof monthlyBillingReportQuerySchema>;

/**
 * GET /api/reports/ar-aging — the "as of" day for the aging buckets.
 *
 * `asOf` is the name Phase 8 documents; `asOfDate` is accepted as well so the
 * Phase 7 receivables route and this one can be called with the same parameters.
 */
export const arAgingReportQuerySchema = z.object({
  asOf: dateOnlySchema.optional(),
  asOfDate: dateOnlySchema.optional(),
});
export type ArAgingReportQuery = z.infer<typeof arAgingReportQuerySchema>;

/** GET /api/reports/collector-remittance — the batch to report on. */
export const collectorRemittanceQuerySchema = z.object({
  batchId: z.string().uuid("A collector batch id is required"),
});
export type CollectorRemittanceQuery = z.infer<typeof collectorRemittanceQuerySchema>;

/** The filters a report export may carry. Only the chosen report reads them. */
const reportExportParamsSchema = z.object({
  date: dateOnlySchema.optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  asOf: dateOnlySchema.optional(),
  batchId: z.string().uuid("The batch id must be a UUID").optional(),
  serviceAccountId: z.string().uuid("The service account id must be a UUID").optional(),
  fromDate: dateOnlySchema.optional(),
  toDate: dateOnlySchema.optional(),
});

/**
 * POST /api/reports/export-pdf and POST /api/reports/export-xlsx.
 *
 * Each report needs its own parameters, so the body is rejected with a readable
 * message when a report is asked for without the parameters it reads: a monthly
 * billing export without a period would silently produce an empty file.
 */
export const reportExportBodySchema = z
  .object({
    reportType: z.enum(REPORT_TYPES),
    params: reportExportParamsSchema.default({}),
  })
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
  });
export type ReportExportBody = z.infer<typeof reportExportBodySchema>;

/** The export format a download URL asks for, as a query parameter. */
export const reportExportFormatSchema = z.enum(REPORT_EXPORT_FORMATS);
