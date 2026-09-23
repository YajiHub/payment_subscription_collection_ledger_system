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
import {
  assignCollector,
  changeServiceAccountPlan,
  createServiceAccountForSubscriber,
  getServiceAccountById,
  reconnectServiceAccount,
  suspendServiceAccount,
  terminateServiceAccount,
} from "./service-accounts.service";

const serviceAccountIdParamsSchema = z.object({
  id: z.string().uuid("A valid service account id is required"),
});

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
  const { reason } = parseOrThrow(suspendServiceAccountSchema, request.body);
  const changedBy = request.user?.id ?? "";

  const suspended = await suspendServiceAccount(id, reason, changedBy);
  return sendSuccess(reply, suspended);
}

/** PUT /api/service-accounts/:id/reconnect — restores service and reports the fee. */
export async function putServiceAccountReconnected(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(serviceAccountIdParamsSchema, request.params);
  const { reason } = parseOrThrow(reconnectServiceAccountSchema, request.body);
  const changedBy = request.user?.id ?? "";

  const result = await reconnectServiceAccount(id, reason, changedBy);
  return sendSuccess(reply, result);
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
