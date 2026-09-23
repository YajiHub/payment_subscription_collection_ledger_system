// Handlers for the billing endpoints.
// Each handler validates input, calls the billing service, and writes the reply.

import type { FastifyReply, FastifyRequest } from "fastify";

import { applyLateFeesSchema, billingPeriodQuerySchema, DEFAULT_LATE_FEE_CENTAVOS, postAllDraftSchema, runBillingSchema } from "@bcis/shared";
import { sendSuccess } from "../../shared/response";
import { parseOrThrow } from "../../shared/validate";
import { applyLateFeesToOverdueInvoices } from "./late-fee.service";
import {
  listBillingRuns,
  postAllDraftInvoices,
  previewMonthlyBilling,
  runMonthlyBilling,
} from "./monthly-billing.service";

/** GET /api/billing/run-preview — what the billing job would generate, dry run. */
export async function getBillingRunPreview(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const period = parseOrThrow(billingPeriodQuerySchema, request.query);
  const preview = await previewMonthlyBilling(period.year, period.month);
  return sendSuccess(reply, preview);
}

/** POST /api/billing/run — generates draft invoices for a period. */
export async function postBillingRun(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const period = parseOrThrow(runBillingSchema, request.body);
  const initiatedByUserId = request.user?.id ?? "";
  const result = await runMonthlyBilling(period.year, period.month, initiatedByUserId);
  return sendSuccess(reply, result, 201);
}

/** POST /api/billing/post-all-draft — posts every draft invoice for a period. */
export async function postAllDraftInvoicesHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const period = parseOrThrow(postAllDraftSchema, request.body);
  const postedByUserId = request.user?.id ?? "";
  const posted = await postAllDraftInvoices(period.year, period.month, postedByUserId);
  return sendSuccess(reply, { posted });
}

/** GET /api/billing/runs — the billing run history, newest first. */
export async function getBillingRuns(
  _request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const runs = await listBillingRuns();
  return sendSuccess(reply, { items: runs });
}

/** POST /api/billing/apply-late-fees — charges a late fee to overdue invoices. */
export async function postApplyLateFees(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const body = parseOrThrow(applyLateFeesSchema, request.body);
  const appliedByUserId = request.user?.id ?? "";
  const lateFeeCentavos = body.lateFeeCentavos ?? DEFAULT_LATE_FEE_CENTAVOS;
  const invoicesCharged = await applyLateFeesToOverdueInvoices(lateFeeCentavos, appliedByUserId);
  return sendSuccess(reply, { invoicesCharged, lateFeeCentavos });
}
