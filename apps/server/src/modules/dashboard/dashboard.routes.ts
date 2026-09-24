// Route table for the management dashboard.
// Only paths, preHandlers, and their handlers live here.
//
// Every dashboard figure counts subscribers, invoices, payments, or batches, so the
// route requires `reports:view` — the same permission the Reports Center needs. The
// Administrator, Billing Clerk, Cashier, Collector, and Manager all hold it; the
// server is the authority, so hiding the screen is only a convenience.

import type { FastifyInstance } from "fastify";

import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { getDashboardKpisHandler } from "./dashboard.handler";

export async function registerDashboardRoutes(server: FastifyInstance): Promise<void> {
  const view = { preHandler: [authenticate, authorize("reports:view")] };

  server.get("/api/dashboard/kpis", view, getDashboardKpisHandler);
}
