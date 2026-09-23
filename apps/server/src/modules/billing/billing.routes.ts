// Route table for the billing module.
// Only paths, preHandlers, and their handlers live here.

import type { FastifyInstance } from "fastify";

import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import {
  getBillingRunPreview,
  getBillingRuns,
  postAllDraftInvoicesHandler,
  postApplyLateFees,
  postBillingRun,
} from "./billing.handler";

export async function registerBillingRoutes(server: FastifyInstance): Promise<void> {
  const read = { preHandler: [authenticate, authorize("invoices:read")] };
  const generate = { preHandler: [authenticate, authorize("invoices:generate")] };

  // Previewing and reading history are read-only; generating invoices and charging
  // late fees change subscriber balances and need the billing permission.
  server.get("/api/billing/run-preview", read, getBillingRunPreview);
  server.get("/api/billing/runs", read, getBillingRuns);
  server.post("/api/billing/run", generate, postBillingRun);
  server.post("/api/billing/post-all-draft", generate, postAllDraftInvoicesHandler);
  server.post("/api/billing/apply-late-fees", generate, postApplyLateFees);
}
