// Handlers for the subscription plan endpoints.
// Each handler validates input, calls plans.service, and writes the reply.

import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { SERVICE_TYPES } from "@bcis/shared";
import { createPlanSchema, updatePlanSchema } from "@bcis/shared";
import { audit, requestActor } from "../../shared/audit/audit-logger";
import { sendSuccess } from "../../shared/response";
import { parseOrThrow } from "../../shared/validate";
import { createPlan, getPlanById, listPlans, retirePlan, updatePlan } from "./plans.service";

// Query strings arrive as text. An explicit "true"/"false" enum keeps
// `?includeInactive=false` from being read as a truthy value.
const booleanQueryParam = z.enum(["true", "false"]).transform((value) => value === "true");

const listPlansQuerySchema = z.object({
  serviceType: z.enum(SERVICE_TYPES).optional(),
  includeInactive: booleanQueryParam.optional(),
});

const planIdParamsSchema = z.object({ id: z.string().uuid("A valid plan id is required") });

/** GET /api/plans — active plans, optionally filtered by service type. */
export async function getPlans(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const query = parseOrThrow(listPlansQuerySchema, request.query);
  const plans = await listPlans({
    serviceType: query.serviceType,
    includeInactive: query.includeInactive,
  });
  return sendSuccess(reply, { items: plans });
}

/** POST /api/plans — creates a plan. */
export async function postPlan(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const body = parseOrThrow(createPlanSchema, request.body);
  const createdBy = request.user?.id ?? "";
  const plan = await createPlan({ ...body, createdBy });
  await audit.planCreated({ ...plan }, requestActor(request));
  return sendSuccess(reply, plan, 201);
}

/** GET /api/plans/:id — a single plan. */
export async function getPlan(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const { id } = parseOrThrow(planIdParamsSchema, request.params);
  const plan = await getPlanById(id);
  return sendSuccess(reply, plan);
}

/** PUT /api/plans/:id — updates a plan's name, speed, or package description. */
export async function putPlan(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const { id } = parseOrThrow(planIdParamsSchema, request.params);
  const body = parseOrThrow(updatePlanSchema, request.body);

  // Snapshot the previous state so the audit trail can show what changed (S5-6).
  const previous = await getPlanById(id);
  const plan = await updatePlan(id, body);
  await audit.planUpdated({ ...plan }, previous, requestActor(request));
  return sendSuccess(reply, plan);
}

/** PUT /api/plans/:id/retire — deactivates a plan so it takes no new signups. */
export async function putPlanRetired(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(planIdParamsSchema, request.params);
  const plan = await retirePlan(id);
  await audit.planRetired({ ...plan }, requestActor(request));
  return sendSuccess(reply, plan);
}
