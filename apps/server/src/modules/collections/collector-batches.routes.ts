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
  getBatchRemittances,
  getBatchRouteSheet,
  getBatchRouteSheetExport,
  getCollectorBatch,
  getCollectorBatches,
  postBatchAssignments,
  postBatchCancelled,
  postBatchClosed,
  postBatchReconciled,
  postBatchRemitted,
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
  // Reading a route sheet is a batch read; taking the file out of the building is
  // an export, so it needs the same `reports:export` permission as every other
  // report download.
  const exportReport = { preHandler: [authenticate, authorize("reports:export")] };

  // Declared before the ":id" routes so the literal "collectors" segment is never
  // mistaken for a batch id.
  // S5-8: listing the collectors a batch COULD be for is a read, so it requires the
  // read permission. It used to demand `collector_batches:create`, which wrongly
  // refused office staff who may read batches but may not create them.
  server.get("/api/collector-batches/collectors", read, getAssignableCollectors);
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

  // S4-2: the cash hand-in is its own step, writing a `collector_remittances` row;
  // a batch may be remitted more than once (instalments or a correction).
  server.post("/api/collector-batches/:id/remit", remit, postBatchRemitted);
  server.get("/api/collector-batches/:id/remittances", read, getBatchRemittances);

  server.post("/api/collector-batches/:id/reconcile", reconcile, postBatchReconciled);

  // S4-1: the final close is a SEPARATE authorized action from reconciliation.
  // It needs the reconciliation permission (the supervisor who reconciles the
  // money is the one who signs the batch off), but it is a different endpoint and
  // the state machine refuses to close a batch that was not reconciled first.
  server.post("/api/collector-batches/:id/close", reconcile, postBatchClosed);

  // S4-3: the printable route sheet for the batch and the file download. The sheet
  // is read with the batch, and the download needs the report-export permission.
  server.get("/api/collector-batches/:id/route-sheet", read, getBatchRouteSheet);
  server.get(
    "/api/collector-batches/:id/route-sheet/export",
    exportReport,
    getBatchRouteSheetExport
  );

  server.post("/api/collector-batches/:id/cancel", create, postBatchCancelled);
}