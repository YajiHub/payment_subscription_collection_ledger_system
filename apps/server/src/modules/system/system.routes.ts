// Route table for the system module.
//
// Reading the settings is available to any authenticated user: the values are
// non-sensitive business rules (the late fee, the due day) that screens such as
// the billing dashboard display. CHANGING a setting and reading the extended
// health check are administrative and need `system:settings`, which only the
// Administrator holds.

import type { FastifyInstance } from "fastify";

import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import {
  getExtendedHealthHandler,
  getSystemSettingsHandler,
  putSystemSettingsHandler,
  updateSystemSettingsBodySchema,
} from "./system.handler";

export async function registerSystemRoutes(server: FastifyInstance): Promise<void> {
  // Authentication runs in `onRequest` (not `preHandler`) on these routes so an
  // unauthenticated caller is answered 401 BEFORE Fastify runs a declared Zod
  // schema. Validation must never respond to a caller who has not identified.
  server.get(
    "/api/system/settings",
    { onRequest: [authenticate] },
    getSystemSettingsHandler
  );

  server.put(
    "/api/system/settings",
    {
      onRequest: [authenticate, authorize("system:settings")],
      schema: { body: updateSystemSettingsBodySchema },
    },
    putSystemSettingsHandler
  );

  server.get(
    "/api/system/health/extended",
    { onRequest: [authenticate, authorize("system:settings")] },
    getExtendedHealthHandler
  );
}
