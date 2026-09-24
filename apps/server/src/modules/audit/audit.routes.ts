// Route table for the audit-trail module.
//
// Only the Administrator may read the audit trail (`audit:read`), which is why
// the permission is granted to no other role in the canonical matrix.

import type { FastifyInstance } from "fastify";

import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { getAuditLogs, listAuditLogsQuerySchema } from "./audit.handler";

export async function registerAuditRoutes(server: FastifyInstance): Promise<void> {
  server.get(
    "/api/audit-logs",
    {
      // Authentication is an `onRequest` hook, not a `preHandler`, so an
      // unauthenticated caller is rejected with 401 BEFORE Fastify runs the
      // declared Zod schema — validation must never answer a request that has
      // not proved who it is.
      onRequest: [authenticate, authorize("audit:read")],
      schema: { querystring: listAuditLogsQuerySchema },
    },
    getAuditLogs
  );
}
