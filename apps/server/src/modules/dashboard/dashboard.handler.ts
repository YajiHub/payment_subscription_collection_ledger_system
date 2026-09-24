// Handlers for the management dashboard endpoints.
// A handler receives the parsed request and writes the reply — nothing else.

import type { FastifyReply, FastifyRequest } from "fastify";

import { sendSuccess } from "../../shared/response";
import { getDashboardKpis } from "./dashboard.service";

/** GET /api/dashboard/kpis — every KPI the dashboard shows, in one reply. */
export async function getDashboardKpisHandler(
  _request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  return sendSuccess(reply, await getDashboardKpis());
}
