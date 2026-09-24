// Handlers for the report endpoints.
//
// Every handler here READS. The report and export routes issue no INSERT, an
// UPDATE, or a DELETE — a report is a view of money, and a view that can change the
// money is not a view. A test pins that by asserting the database saw no write while
// the reports ran.

import type { FastifyReply, FastifyRequest } from "fastify";

import {
  arAgingReportQuerySchema,
  collectorRemittanceQuerySchema,
  dailyCollectionReportQuerySchema,
  monthlyBillingReportQuerySchema,
  reportExportBodySchema,
  type ReportExportFormat,
} from "@bcis/shared";
import { PDF_CONTENT_TYPE, generateReportPdf } from "../../shared/pdf/report-generator";
import { XLSX_CONTENT_TYPE, generateReportXlsx } from "../../shared/xlsx/report-generator";
import { UnauthorizedError } from "../../shared/errors";
import { sendSuccess } from "../../shared/response";
import { parseOrThrow } from "../../shared/validate";
import { addDaysToDay, formatDateOnly, utcMidnightOfDay } from "../../shared/date";
import type { BatchActor } from "../collections/collector-batches.service";
import { getCollectorBatchDetail } from "../collections/collector-batches.service";
import { computeArAging } from "../receivables/ar-aging.service";
import { buildCollectorRemittanceReport } from "./collector-remittance.service";
import { buildDailyCollectionReport, loadPaymentsBetween } from "./daily-collection.service";
import { buildMonthlyBillingReport, loadInvoicesForPeriod } from "./monthly-billing.service";
import {
  buildOutstandingByCollector,
  loadOutstandingInvoicesWithCollector,
} from "./outstanding-by-collector.service";
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

/** GET /api/reports/ar-aging — R3, the AR aging report as of a day. */
export async function getArAgingReportHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const query = parseOrThrow(arAgingReportQuerySchema, request.query);
  const asOf = query.asOf ?? query.asOfDate ?? today();

  return sendSuccess(reply, await computeArAging(utcMidnightOfDay(asOf)));
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

/** GET /api/reports/outstanding-by-collector — R6, receivables per collector. */
export async function getOutstandingByCollectorHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const query = parseOrThrow(arAgingReportQuerySchema, request.query);
  const asOf = query.asOf ?? query.asOfDate ?? today();

  const report = buildOutstandingByCollector(
    await loadOutstandingInvoicesWithCollector(),
    utcMidnightOfDay(asOf)
  );

  return sendSuccess(reply, report);
}

/** Builds the requested report and sends it as a file download. */
async function sendReportExport(
  request: FastifyRequest,
  reply: FastifyReply,
  format: ReportExportFormat
): Promise<FastifyReply> {
  const body = parseOrThrow(reportExportBodySchema, request.body);

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

  return reply
    .header("Content-Type", format === "pdf" ? PDF_CONTENT_TYPE : XLSX_CONTENT_TYPE)
    .header("Content-Disposition", `attachment; filename="${fileName}"`)
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
