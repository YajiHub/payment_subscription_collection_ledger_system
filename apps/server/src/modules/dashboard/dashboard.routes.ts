// Route table for the management dashboard.
// Only paths, preHandlers, and their handlers live here.
//
// Every dashboard figure counts subscribers, invoices, payments, or batches and
// exposes the whole ledger, so the route is a management view: it requires
// `reports:management_view`, held by the Administrator, Billing Clerk, and Manager.
// The server is the authority, so hiding the screen is only a convenience.

import type { FastifyInstance } from "fastify";

import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { getDashboardKpisHandler } from "./dashboard.handler";

export async function registerDashboardRoutes(server: FastifyInstance): Promise<void> {
  const view = { preHandler: [authenticate, authorize("reports:management_view")] };

  server.get("/api/dashboard/kpis", view, getDashboardKpisHandler);
}
