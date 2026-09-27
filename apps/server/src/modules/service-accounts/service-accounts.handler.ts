// Handlers for the service account endpoints.
// Each handler validates input, calls service-accounts.service, and writes the reply.

import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  assignCollectorSchema,
  changeServiceAccountPlanSchema,
  createServiceAccountSchema,
  reconnectServiceAccountSchema,
  suspendServiceAccountSchema,
  terminateServiceAccountSchema,
} from "@bcis/shared";
import { sendSuccess } from "../../shared/response";
import { parseOrThrow } from "../../shared/validate";
import { audit, logAuditEntry, requestActor } from "../../shared/audit/audit-logger";
import { createReconnectionFeeInvoice } from "../billing/invoices.service";
import {
  assignCollector,
  changeServiceAccountPlan,
  createServiceAccountForSubscriber,
  getServiceAccountById,
  recordReconnection,
  reconnectServiceAccount,
  suspendServiceAccount,
  terminateServiceAccount,
} from "./service-accounts.service";

const serviceAccountIdParamsSchema = z.object({
  id: z.string().uuid("A valid service account id is required"),
});

import { formatDateOnly } from "../../shared/date";
import {
  automaticSuspensionReason,
  findSuspensionCandidates,
  resolveSuspensionThresholdDays,
  suspendQualifyingAccounts,
} from "./suspension-threshold.service";

const subscriberIdParamsSchema = z.object({
  id: z.string().uuid("A valid subscriber id is required"),
});

/** GET /api/service-accounts/:id — the account, its plan, and its status history. */
export async function getServiceAccount(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(serviceAccountIdParamsSchema, request.params);
  const serviceAccount = await getServiceAccountById(id);
  return sendSuccess(reply, serviceAccount);
}

/** POST /api/subscribers/:id/service-accounts — adds another service to a subscriber. */
export async function postServiceAccount(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id: subscriberId } = parseOrThrow(subscriberIdParamsSchema, request.params);
  const body = parseOrThrow(createServiceAccountSchema, request.body);
  const createdBy = request.user?.id ?? "";

  const created = await createServiceAccountForSubscriber(subscriberId, body, createdBy);
  return sendSuccess(reply, created, 201);
}

/** PUT /api/service-accounts/:id/suspend — cuts off service. A reason is required. */
export async function putServiceAccountSuspended(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(serviceAccountIdParamsSchema, request.params);
  const body = parseOrThrow(suspendServiceAccountSchema, request.body);
  const changedBy = request.user?.id ?? "";

  const suspended = await suspendServiceAccount(id, body.reason, changedBy, {
    technicianId: body.technicianId,
    effectiveDate: body.effectiveDate,
    requestDate: body.requestDate,
    completionDate: body.completionDate,
    notes: body.notes,
  });
  await audit.serviceAccountSuspended({ ...suspended }, body.reason, requestActor(request));
  return sendSuccess(reply, suspended);
}

/** PUT /api/service-accounts/:id/reconnect — restores service and bills the fee. */
export async function putServiceAccountReconnected(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(serviceAccountIdParamsSchema, request.params);
  const body = parseOrThrow(reconnectServiceAccountSchema, request.body);
  const changedBy = request.user?.id ?? "";

  const result = await reconnectServiceAccount(id, body.reason, changedBy);

  // The reconnection fee is charged as an invoice, so reconnecting a suspended
  // account always produces the documented reconnection fee invoice. A plan with
  // no fee simply produces no invoice.
  const reconnectionFeeInvoice =
    result.reconnectionFeeEntry.amountCentavos > 0
      ? await createReconnectionFeeInvoice(
          id,
          `Reconnection fee — ${body.reason ?? "service restored"}`,
          changedBy
        )
      : null;

  // S4-8: the operating record sits beside the fee invoice — technician, request
  // date and completion date — and points at the invoice it accompanied.
  const reconnectionRecord = await recordReconnection(
    id,
    body.reason,
    reconnectionFeeInvoice?.amountCentavos ?? 0,
    changedBy,
    {
      technicianId: body.technicianId,
      effectiveDate: body.effectiveDate,
      requestDate: body.requestDate,
      completionDate: body.completionDate,
      notes: body.notes,
      invoiceId: reconnectionFeeInvoice?.invoice.id ?? null,
    }
  );

  await logAuditEntry({
    action: "service_account.reconnected",
    entityType: "service_account",
    entityId: id,
    newState: reconnectionRecord,
    description: `Service account reconnected. Reason: ${body.reason ?? "service restored"}`,
    performedBy: changedBy,
    clientIpAddress: request.ip,
  });

  return sendSuccess(reply, { ...result, reconnectionFeeInvoice, reconnectionRecord });
}

/** PUT /api/service-accounts/:id/terminate — permanently ends service. */
export async function putServiceAccountTerminated(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(serviceAccountIdParamsSchema, request.params);
  const { reason } = parseOrThrow(terminateServiceAccountSchema, request.body);
  const changedBy = request.user?.id ?? "";

  const terminated = await terminateServiceAccount(id, reason, changedBy);
  return sendSuccess(reply, terminated);
}

/** PUT /api/service-accounts/:id/plan — moves the account onto another plan. */
export async function putServiceAccountPlan(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(serviceAccountIdParamsSchema, request.params);
  const { planId } = parseOrThrow(changeServiceAccountPlanSchema, request.body);

  const result = await changeServiceAccountPlan(id, planId);
  return sendSuccess(reply, result);
}

/** PUT /api/service-accounts/:id/collector — assigns or clears the field collector. */
export async function putServiceAccountCollector(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(serviceAccountIdParamsSchema, request.params);
  const { assignedCollectorId } = parseOrThrow(assignCollectorSchema, request.body);

  const updated = await assignCollector(id, assignedCollectorId);
  return sendSuccess(reply, updated);
}

/** The threshold override an on-demand run may carry (S4-7). */
const suspensionRunSchema = z.object({
  thresholdDays: z.coerce.number().int().min(1).max(3650).optional(),
  reason: z.string().trim().min(10, "A suspension reason is required").max(500).optional(),
});

/**
 * GET /api/service-accounts/suspension-candidates — who WOULD be suspended (S4-7).
 *
 * A preview, not an action: it reads the configured threshold and reports the active
 * accounts whose oldest unpaid invoice is past due by at least that many days. It is
 * registered before the `:id` route so the literal segment is never read as an id.
 */
export async function getSuspensionCandidates(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const query = parseOrThrow(suspensionRunSchema, request.query ?? {});
  const thresholdDays = await resolveSuspensionThresholdDays(query.thresholdDays);
  const candidates = await findSuspensionCandidates(thresholdDays);

  return sendSuccess(reply, {
    thresholdDays,
    asOfDate: formatDateOnly(new Date()),
    candidates,
    candidateCount: candidates.length,
    totalOverdueCentavos: candidates.reduce(
      (runningTotal, candidate) => runningTotal + candidate.totalOverdueCentavos,
      0
    ),
  });
}

/**
 * POST /api/service-accounts/suspension-candidates/run — performs the suspensions.
 *
 * Explicit: nothing is suspended by reading the preview. Each suspension is a real
 * status change with a `suspension_records` row and an audit entry.
 */
export async function postSuspensionRun(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const body = parseOrThrow(suspensionRunSchema, request.body ?? {});
  const thresholdDays = await resolveSuspensionThresholdDays(body.thresholdDays);
  const actorId = request.user?.id ?? "";

  const result = await suspendQualifyingAccounts(thresholdDays, actorId);

  // One audit row per suspended account: the actor and the reason are on each, so
  // an auditor can see exactly who was cut and why (S4-7 and the S5-6 audit rule).
  for (const candidate of result.suspended) {
    await audit.serviceAccountSuspended(
      { id: candidate.serviceAccountId, serviceAccountNumber: candidate.serviceAccountNumber },
      automaticSuspensionReason(candidate.daysPastDue, result.thresholdDays),
      requestActor(request)
    );
  }

  return sendSuccess(reply, result);
}
