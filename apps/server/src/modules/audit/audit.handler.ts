// Handler for the audit-log endpoint.
// Reading the audit trail is an administrative, read-only action.

import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { queryNumber } from "@bcis/shared";
import { sendSuccess } from "../../shared/response";
import { parseOrThrow } from "../../shared/validate";
import { listAuditLogs } from "./audit.service";

// Exported so the route table can declare it as the route's Zod schema, which
// makes Fastify reject an invalid query before this handler runs.
export const listAuditLogsQuerySchema = z.object({
  page: queryNumber("page", (schema) => schema.int().min(1)).default(1),
  pageSize: queryNumber("pageSize", (schema) => schema.int().min(1).max(100)).default(20),
  action: z.string().trim().max(100).optional(),
  entityType: z.string().trim().max(50).optional(),
  entityId: z.string().uuid("A valid entity id is required").optional(),
  performedBy: z.string().uuid("A valid user id is required").optional(),
  // What an operator actually has is a name, not a user id: the filter screens
  // offer this rather than asking a person to type a UUID from memory.
  performedByUsername: z.string().trim().min(1).max(50).optional(),
});

/** GET /api/audit-logs — one page of the audit trail, newest first. */
export async function getAuditLogs(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const query = parseOrThrow(listAuditLogsQuerySchema, request.query);
  const result = await listAuditLogs(query);
  return sendSuccess(reply, result);
}
