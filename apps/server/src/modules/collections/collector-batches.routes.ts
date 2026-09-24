// Route table for the collector batch module.
// Only paths, preHandlers, and their handlers live here.
//
// The permissions enforce the reverse-side rule of field collection:
//   • creating batches and assigning accounts → collector_batches:create
//   • recording and submitting field money    → collector_batches:remit
//   • voiding and reconciling at the office   → collector_batches:reconcile
// A Collector holds create/remit but not reconcile; a Cashier holds read/reconcile
// but neither create nor remit; the Admin holds all four. The service additionally
// restricts a Collector to their own batches.

import type { FastifyInstance } from "fastify";

import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import {
  getAssignableCollectors,
  getCollectorBatch,
  getCollectorBatches,
  postBatchAssignments,
  postBatchCancelled,
  postBatchReconciled,
  postBatchSubmitted,
  postCollectorBatch,
  putCollectionResult,
  putCollectionVoided,
} from "./collector-batches.handler";

export async function registerCollectorBatchRoutes(server: FastifyInstance): Promise<void> {
  const read = { preHandler: [authenticate, authorize("collector_batches:read")] };
  const create = { preHandler: [authenticate, authorize("collector_batches:create")] };
  const remit = { preHandler: [authenticate, authorize("collector_batches:remit")] };
  const reconcile = { preHandler: [authenticate, authorize("collector_batches:reconcile")] };

  // Declared before the ":id" routes so the literal "collectors" segment is never
  // mistaken for a batch id.
  server.get("/api/collector-batches/collectors", create, getAssignableCollectors);
  server.get("/api/collector-batches", read, getCollectorBatches);
  server.post("/api/collector-batches", create, postCollectorBatch);
  server.get("/api/collector-batches/:id", read, getCollectorBatch);
  server.post("/api/collector-batches/:id/assignments", create, postBatchAssignments);

  // The void path is declared before the record path so the literal "void" segment
  // is never mistaken for part of a service account id.
  server.put(
    "/api/collector-batches/:id/assignments/:serviceAccountId/void",
    reconcile,
    putCollectionVoided
  );
  server.put(
    "/api/collector-batches/:id/assignments/:serviceAccountId",
    remit,
    putCollectionResult
  );

  server.post("/api/collector-batches/:id/submit", remit, postBatchSubmitted);
  server.post("/api/collector-batches/:id/reconcile", reconcile, postBatchReconciled);
  server.post("/api/collector-batches/:id/cancel", create, postBatchCancelled);
}