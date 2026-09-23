// Route table for the subscription plan module.
// Only paths, preHandlers, and their handlers live here.

import type { FastifyInstance } from "fastify";

import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { getPlan, getPlans, postPlan, putPlan, putPlanRetired } from "./plans.handler";

export async function registerPlanRoutes(server: FastifyInstance): Promise<void> {
  server.get("/api/plans", { preHandler: [authenticate, authorize("plans:read")] }, getPlans);
  server.get("/api/plans/:id", { preHandler: [authenticate, authorize("plans:read")] }, getPlan);

  // Creating, editing, and retiring a plan changes what the office can sell, so
  // each of these requires the matching plan permission (Admin in the current matrix).
  server.post("/api/plans", { preHandler: [authenticate, authorize("plans:create")] }, postPlan);
  server.put("/api/plans/:id", { preHandler: [authenticate, authorize("plans:update")] }, putPlan);
  server.put(
    "/api/plans/:id/retire",
    { preHandler: [authenticate, authorize("plans:update")] },
    putPlanRetired
  );
}
