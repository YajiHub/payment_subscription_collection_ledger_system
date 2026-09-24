// Route table for the receivables module (AR aging and overdue accounts).
// Only paths, preHandlers, and their handlers live here.
//
// Reading reports needs `reports:view` (every role holds it); downloading a report
// file needs `reports:export` (Admin and Manager only). Suspending overdue accounts
// reuses `subscribers:suspend`, so only the Admin and Billing Clerk may do it.

import type { FastifyInstance } from "fastify";

import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import {
  getArAging,
  getArAgingExport,
  getOverdueAccounts,
  getOverdueSummary,
  postSuspendOverdueAccounts,
} from "./receivables.handler";

export async function registerReceivablesRoutes(server: FastifyInstance): Promise<void> {
  const view = { preHandler: [authenticate, authorize("reports:view")] };
  const exportReports = { preHandler: [authenticate, authorize("reports:export")] };
  const suspend = { preHandler: [authenticate, authorize("subscribers:suspend")] };

  // The export path is declared before the plain aging path so the literal
  // "export" segment is never mistaken for an as-of date.
  server.get("/api/receivables/ar-aging/export", exportReports, getArAgingExport);
  server.get("/api/receivables/ar-aging", view, getArAging);
  server.get("/api/receivables/overdue", view, getOverdueAccounts);
  server.get("/api/receivables/overdue-summary", view, getOverdueSummary);
  server.post("/api/receivables/overdue/suspend", suspend, postSuspendOverdueAccounts);
}