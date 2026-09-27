// Handlers for the receivables endpoints (AR aging, overdue accounts, bulk suspend).
// Each handler validates input, calls a service, and writes the reply.

import type { FastifyReply, FastifyRequest } from "fastify";

import {
  arAgingExportQuerySchema,
  arAgingQuerySchema,
  overdueAccountsQuerySchema,
  suspendOverdueAccountsSchema,
} from "@bcis/shared";
import { sendSuccess } from "../../shared/response";
import { parseOrThrow } from "../../shared/validate";
import { formatDateOnly } from "../../shared/date";
import type { ReportFilters } from "../reports/report-filters";
import { suspendServiceAccount } from "../service-accounts/service-accounts.service";
import { computeArAging } from "./ar-aging.service";
import {
  AR_AGING_EXPORT_CONTENT_TYPE,
  arAgingExportFileName,
  buildArAgingWorkbook,
} from "./ar-aging-export.service";
import { listOverdueAccounts, summarizeOverdueBuckets } from "./overdue-accounts.service";

/**
 * A report's "as of" instant.
 *
 * The query carries a calendar day; it is anchored to UTC midnight so the day
 * count to a due date (also a calendar day read at UTC midnight) never shifts by a
 * timezone. With no query value, today's local calendar day is used.
 */
function resolveAsOfDate(queryDate: string | undefined): Date {
  const day = queryDate ?? formatDateOnly(new Date());
  return new Date(`${day}T00:00:00Z`);
}

/** GET /api/receivables/ar-aging — the AR aging report. */
export async function getArAging(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const query = parseOrThrow(arAgingQuerySchema, request.query);
  const report = await computeArAging(resolveAsOfDate(query.asOfDate), undefined, reportFiltersOf(query));
  return sendSuccess(reply, report);
}

/** The shared report filters, carried from a receivables query to the service. */
function reportFiltersOf(query: {
  collectorId?: string;
  areaId?: string;
  planId?: string;
  serviceType?: "internet" | "cable_tv" | "bundle";
}): ReportFilters {
  return {
    collectorId: query.collectorId,
    areaId: query.areaId,
    planId: query.planId,
    serviceType: query.serviceType,
  };
}

/** GET /api/receivables/ar-aging/export — the AR aging report as an .xlsx file. */
export async function getArAgingExport(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const query = parseOrThrow(arAgingExportQuerySchema, request.query);
  const report = await computeArAging(
    resolveAsOfDate(query.asOfDate),
    undefined,
    reportFiltersOf(query)
  );
  const workbook = buildArAgingWorkbook(report);

  return reply
    .header("Content-Type", AR_AGING_EXPORT_CONTENT_TYPE)
    .header("Content-Disposition", `attachment; filename="${arAgingExportFileName(report.asOfDate)}"`)
    .send(Buffer.from(workbook));
}

/** GET /api/receivables/overdue — the overdue service accounts. */
export async function getOverdueAccounts(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const query = parseOrThrow(overdueAccountsQuerySchema, request.query);
  const items = await listOverdueAccounts(
    {
      noPaymentInDays: query.noPaymentInDays,
      minConsecutiveOverdueMonths: query.minConsecutiveOverdueMonths,
      minOverdueDays: query.minOverdueDays,
      ...reportFiltersOf(query),
    },
    resolveAsOfDate(undefined)
  );

  return sendSuccess(reply, {
    items,
    totalOverdueCentavos: items.reduce(
      (runningTotal, account) => runningTotal + account.totalOverdueCentavos,
      0
    ),
  });
}

/** GET /api/receivables/overdue-summary — counts and totals by overdue duration. */
export async function getOverdueSummary(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const query = parseOrThrow(overdueAccountsQuerySchema, request.query);
  const items = await listOverdueAccounts(
    {
      noPaymentInDays: query.noPaymentInDays,
      minConsecutiveOverdueMonths: query.minConsecutiveOverdueMonths,
      minOverdueDays: query.minOverdueDays,
      ...reportFiltersOf(query),
    },
    resolveAsOfDate(undefined)
  );

  return sendSuccess(reply, {
    accountCount: items.length,
    totalOverdueCentavos: items.reduce(
      (runningTotal, account) => runningTotal + account.totalOverdueCentavos,
      0
    ),
    buckets: summarizeOverdueBuckets(items),
  });
}

/**
 * POST /api/receivables/overdue/suspend — suspends the selected accounts.
 *
 * Each account is suspended on its own; one account that cannot be suspended (for
 * example, already suspended) is reported in `failed` rather than aborting the
 * whole batch, because the operator selected several accounts at once.
 */
export async function postSuspendOverdueAccounts(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const body = parseOrThrow(suspendOverdueAccountsSchema, request.body);
  const changedByUserId = request.user?.id ?? "";

  const suspended: string[] = [];
  const failed: { serviceAccountId: string; message: string }[] = [];

  for (const serviceAccountId of body.serviceAccountIds) {
    try {
      await suspendServiceAccount(serviceAccountId, body.reason, changedByUserId);
      suspended.push(serviceAccountId);
    } catch (error) {
      failed.push({
        serviceAccountId,
        message: error instanceof Error ? error.message : "Account could not be suspended",
      });
    }
  }

  return sendSuccess(reply, { suspended, failed });
}