// Handlers for the report endpoints.
//
// Every handler here READS. The report and export routes issue no INSERT, an
// UPDATE, or a DELETE — a report is a view of money, and a view that can change the
// money is not a view. A test pins that by asserting the database saw no write while
// the reports ran.
//
// Every report handler parses the shared filter set and passes it straight to its
// loader, so a filter a caller supplies is a filter the query applies (S6-2).

import type { FastifyReply, FastifyRequest } from "fastify";

import {
  annualCollectionReportQuerySchema,
  arAgingReportQuerySchema,
  auditLogReportQuerySchema,
  collectorAssignmentReportQuerySchema,
  collectorPerformanceReportQuerySchema,
  collectorRemittanceQuerySchema,
  dailyCollectionReportQuerySchema,
  monthlyBillingReportQuerySchema,
  paymentAdjustmentReportQuerySchema,
  reportExportBodySchema,
  revenueReportQuerySchema,
  subscriberMasterListReportQuerySchema,
  userActivityReportQuerySchema,
  voidedReceiptReportQuerySchema,
  weeklyCollectionReportQuerySchema,
  reportNeedsAuditRead,
  roleHasPermission,
  type ReportExportFormat,
} from "@bcis/shared";
import { PDF_CONTENT_TYPE, generateReportPdf } from "../../shared/pdf/report-generator";
import { XLSX_CONTENT_TYPE, generateReportXlsx } from "../../shared/xlsx/report-generator";
import { ForbiddenError, UnauthorizedError } from "../../shared/errors";
import { sendSuccess } from "../../shared/response";
import { parseOrThrow } from "../../shared/validate";
import { addDaysToDay, formatDateOnly, utcMidnightOfDay } from "../../shared/date";
import type { BatchActor } from "../collections/collector-batches.service";
import { getCollectorBatchDetail } from "../collections/collector-batches.service";
import { computeArAging } from "../receivables/ar-aging.service";
import {
  buildAuditLogReport,
  buildUserActivityReport,
  defaultAuditReportRange,
  loadAuditReportRows,
  resolveAuditReportRange,
} from "./audit-reports.service";
import { buildCollectorRemittanceReport } from "./collector-remittance.service";
import {
  buildAnnualCollectionReport,
  buildWeeklyCollectionReport,
  loadCollectionSummaryRows,
  resolveMonthlyRange,
  resolveWeeklyRange,
} from "./collection-summary.service";
import {
  buildCollectorAssignmentReport,
  buildCollectorPerformanceReport,
  loadAssignedAccountCounts,
  loadCollectorAssignmentRows,
  loadCollectorBatchRows,
  loadCollectorPaymentRows,
  withAssignedAccountCounts,
} from "./collector-reports.service";
import { buildDailyCollectionReport, loadPaymentsBetween } from "./daily-collection.service";
import { buildMonthlyBillingReport, loadInvoicesForPeriod } from "./monthly-billing.service";
import {
  buildOutstandingByCollector,
  loadOutstandingInvoicesWithCollector,
} from "./outstanding-by-collector.service";
import {
  buildPaymentAdjustmentReport,
  buildVoidedReceiptReport,
  loadPaymentAdjustmentRows,
} from "./payment-adjustment.service";
import { MAX_REPORT_EXPORT_ROWS } from "./report-limits";
import type { ReportFilters } from "./report-filters";
import {
  buildSubscriberMasterListReport,
  loadSubscriberMasterListRows,
} from "./subscriber-master-list.service";
import { buildRevenueReport, loadRevenueInvoiceRows, type RevenueDimension } from "./revenue.service";
import { buildReportExportDocument, reportExportFileName } from "./report-export.service";

/** Today as the office's calendar day, used when a report is asked for without a date. */
function today(): string {
  return formatDateOnly(new Date());
}

/**
 * The authenticated caller, needed only to scope a collector to their own batches.
 *
 * The routes run `authenticate` first, so a missing caller means the route was
 * misconfigured; answering 401 is safer than silently reporting on someone else's
 * work.
 */
function requireActor(request: FastifyRequest): BatchActor {
  if (request.user === undefined) {
    throw new UnauthorizedError();
  }
  return { id: request.user.id, role: request.user.role };
}

/** The shared report filters, carried from a parsed query to a loader. */
function filtersOf(query: ReportFilters): ReportFilters {
  return {
    fromDate: query.fromDate,
    toDate: query.toDate,
    collectorId: query.collectorId,
    areaId: query.areaId,
    planId: query.planId,
    serviceType: query.serviceType,
  };
}

/** GET /api/reports/daily-collection — R1, everything collected on one day. */
export async function getDailyCollectionReportHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const query = parseOrThrow(dailyCollectionReportQuerySchema, request.query);
  const date = query.date ?? today();

  const paymentRows = await loadPaymentsBetween(date, addDaysToDay(date, 1));

  return sendSuccess(reply, buildDailyCollectionReport(paymentRows, date));
}

/** GET /api/reports/monthly-billing — R2, every invoice raised for a period. */
export async function getMonthlyBillingReportHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const query = parseOrThrow(monthlyBillingReportQuerySchema, request.query);

  const invoiceRows = await loadInvoicesForPeriod(query.year, query.month);

  return sendSuccess(reply, buildMonthlyBillingReport(invoiceRows, query.year, query.month));
}

/** GET /api/reports/ar-aging — R3, the AR aging report as of a day, filtered. */
export async function getArAgingReportHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const query = parseOrThrow(arAgingReportQuerySchema, request.query);
  const asOf = query.asOf ?? query.asOfDate ?? today();

  return sendSuccess(reply, await computeArAging(utcMidnightOfDay(asOf), undefined, filtersOf(query)));
}

/**
 * GET /api/reports/collector-remittance — R5, one batch's remittance reconciliation.
 *
 * The batch detail service is used directly, so a Collector is restricted to their
 * own batches exactly as they are on the batch screens.
 */
export async function getCollectorRemittanceReportHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const query = parseOrThrow(collectorRemittanceQuerySchema, request.query);

  const batch = await getCollectorBatchDetail(query.batchId, requireActor(request));

  return sendSuccess(reply, buildCollectorRemittanceReport(batch));
}

/** GET /api/reports/outstanding-by-collector — R6, receivables per collector, filtered. */
export async function getOutstandingByCollectorHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const query = parseOrThrow(arAgingReportQuerySchema, request.query);
  const asOf = query.asOf ?? query.asOfDate ?? today();

  const report = buildOutstandingByCollector(
    await loadOutstandingInvoicesWithCollector(undefined, filtersOf(query)),
    utcMidnightOfDay(asOf)
  );

  return sendSuccess(reply, report);
}

/** GET /api/reports/weekly-collection — R7, collections for a week, day by day. */
export async function getWeeklyCollectionReportHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const query = parseOrThrow(weeklyCollectionReportQuerySchema, request.query);
  const filters = filtersOf(query);
  const range = resolveWeeklyRange(filters, today());

  return sendSuccess(
    reply,
    buildWeeklyCollectionReport(await loadCollectionSummaryRows(range, filters), range)
  );
}

/** GET /api/reports/annual-collection — R8, collections for a year, month by month. */
export async function getAnnualCollectionReportHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const query = parseOrThrow(annualCollectionReportQuerySchema, request.query);
  const filters = filtersOf(query);
  const year = query.year ?? Number.parseInt(today().slice(0, 4), 10);
  const rows = await loadCollectionSummaryRows(
    { fromDate: `${year}-01-01`, toDate: `${year}-12-31` },
    filters
  );

  return sendSuccess(reply, buildAnnualCollectionReport(rows, year));
}

/** Builds one of the three revenue decompositions of the same invoice set. */
async function sendRevenueReport(
  request: FastifyRequest,
  reply: FastifyReply,
  dimension: RevenueDimension
): Promise<FastifyReply> {
  const query = parseOrThrow(revenueReportQuerySchema, request.query);
  const filters = filtersOf(query);
  const range = resolveMonthlyRange(filters, today());
  const rows = await loadRevenueInvoiceRows(range, filters);

  return sendSuccess(reply, buildRevenueReport(rows, dimension, range));
}

/** GET /api/reports/revenue-by-plan — R9. */
export async function getRevenueByPlanHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  return sendRevenueReport(request, reply, "plan");
}

/** GET /api/reports/revenue-by-service-type — R10. */
export async function getRevenueByServiceTypeHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  return sendRevenueReport(request, reply, "service_type");
}

/** GET /api/reports/revenue-by-area — R11. */
export async function getRevenueByAreaHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  return sendRevenueReport(request, reply, "area");
}

/** GET /api/reports/collector-assignment — R12, an assignment snapshot. */
export async function getCollectorAssignmentReportHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const query = parseOrThrow(collectorAssignmentReportQuerySchema, request.query);

  return sendSuccess(
    reply,
    buildCollectorAssignmentReport(await loadCollectorAssignmentRows(filtersOf(query)))
  );
}

/** GET /api/reports/collector-performance — R13. */
export async function getCollectorPerformanceReportHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const query = parseOrThrow(collectorPerformanceReportQuerySchema, request.query);
  const filters = filtersOf(query);
  const range = resolveMonthlyRange(filters, today());

  const [paymentRows, batchRows, accountCounts] = await Promise.all([
    loadCollectorPaymentRows(range, filters),
    loadCollectorBatchRows(range, filters),
    loadAssignedAccountCounts(),
  ]);

  return sendSuccess(
    reply,
    withAssignedAccountCounts(
      buildCollectorPerformanceReport(paymentRows, batchRows, range),
      accountCounts
    )
  );
}

/** GET /api/reports/payment-adjustments — R14, every reversal in the range. */
export async function getPaymentAdjustmentReportHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const query = parseOrThrow(paymentAdjustmentReportQuerySchema, request.query);
  const filters = filtersOf(query);
  const range = resolveMonthlyRange(filters, today());

  return sendSuccess(
    reply,
    buildPaymentAdjustmentReport(await loadPaymentAdjustmentRows(range, filters), range)
  );
}

/** GET /api/reports/voided-receipts — R15. */
export async function getVoidedReceiptReportHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const query = parseOrThrow(voidedReceiptReportQuerySchema, request.query);
  const filters = filtersOf(query);
  const range = resolveMonthlyRange(filters, today());

  return sendSuccess(
    reply,
    buildVoidedReceiptReport(await loadPaymentAdjustmentRows(range, filters), range)
  );
}

/** GET /api/reports/user-activity — R16. */
export async function getUserActivityReportHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const query = parseOrThrow(userActivityReportQuerySchema, request.query);
  const auditFilters = {
    fromDate: query.fromDate,
    toDate: query.toDate,
    performedBy: query.performedBy,
    action: query.action,
  };
  const range = resolveAuditReportRange(auditFilters, defaultAuditReportRange(today()));

  return sendSuccess(
    reply,
    buildUserActivityReport(await loadAuditReportRows(range, auditFilters), range)
  );
}

/** GET /api/reports/subscriber-master-list — R17, a current snapshot. */
export async function getSubscriberMasterListReportHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const query = parseOrThrow(subscriberMasterListReportQuerySchema, request.query);

  return sendSuccess(
    reply,
    buildSubscriberMasterListReport(
      await loadSubscriberMasterListRows({
        collectorId: query.collectorId,
        areaId: query.areaId,
        planId: query.planId,
        serviceType: query.serviceType,
        serviceStatus: query.serviceStatus,
      })
    )
  );
}

/**
 * GET /api/reports/audit-log — R18/S6-5, the audit trail as a report.
 *
 * The trail grows without limit, so the query is capped: one row more than the
 * export cap is read, and the report says whether anything was dropped.
 */
export async function getAuditLogReportHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const query = parseOrThrow(auditLogReportQuerySchema, request.query);
  const auditFilters = {
    fromDate: query.fromDate,
    toDate: query.toDate,
    performedBy: query.performedBy,
    action: query.action,
    entityType: query.entityType,
  };
  const range = resolveAuditReportRange(auditFilters, defaultAuditReportRange(today()));
  const rows = await loadAuditReportRows(range, auditFilters, MAX_REPORT_EXPORT_ROWS + 1);

  return sendSuccess(reply, buildAuditLogReport(rows, range, MAX_REPORT_EXPORT_ROWS));
}

/** Builds the requested report and sends it as a file download. */
async function sendReportExport(
  request: FastifyRequest,
  reply: FastifyReply,
  format: ReportExportFormat
): Promise<FastifyReply> {
  const body = parseOrThrow(reportExportBodySchema, request.body);

  // The audit reports need `audit:read`, the same permission the audit screen
  // needs. The export route is shared, so the extra check lives here rather than in
  // a second route: a Manager holds `reports:export` but not `audit:read`.
  if (reportNeedsAuditRead(body.reportType)) {
    const role = request.user?.role;
    if (role === undefined || !roleHasPermission(role, "audit:read")) {
      throw new ForbiddenError("The audit trail needs the audit:read permission");
    }
  }

  const document = await buildReportExportDocument(
    body.reportType,
    body.params,
    requireActor(request)
  );

  const fileName = reportExportFileName(document.fileNameStem, format);

  const fileBytes =
    format === "pdf"
      ? await generateReportPdf(document.table)
      : Buffer.from(generateReportXlsx(document.table));

  // The cap is stated in headers as well as in the document, so a caller can tell a
  // complete file from a capped one without opening it (S6-6).
  return reply
    .header("Content-Type", format === "pdf" ? PDF_CONTENT_TYPE : XLSX_CONTENT_TYPE)
    .header("Content-Disposition", `attachment; filename="${fileName}"`)
    .header("X-Report-Row-Cap", String(document.rowLimit))
    .header("X-Report-Total-Rows", String(document.totalRows))
    .header("X-Report-Truncated", document.isTruncated ? "true" : "false")
    .send(fileBytes);
}

/** POST /api/reports/export-pdf — the report as a printable PDF document. */
export async function postExportPdfHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  return sendReportExport(request, reply, "pdf");
}

/** POST /api/reports/export-xlsx — the report as a spreadsheet. */
export async function postExportXlsxHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  return sendReportExport(request, reply, "xlsx");
}
