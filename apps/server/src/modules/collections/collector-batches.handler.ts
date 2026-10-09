// Handlers for the collector batch endpoints.
// Each handler validates input, calls the batch service with the authenticated
// caller, and writes the reply.

import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  addBatchAssignmentsSchema,
  cancelBatchSchema,
  closeBatchSchema,
  createCollectorBatchSchema,
  listCollectorBatchesQuerySchema,
  recordBatchRemittanceSchema,
  reconcileBatchSchema,
  recordCollectionSchema,
  submitBatchSchema,
  voidCollectionSchema,
} from "@bcis/shared";
import { sendSuccess } from "../../shared/response";
import { UnauthorizedError } from "../../shared/errors";
import { audit, logAuditEntry, requestActor, requestActorFields } from "../../shared/audit/audit-logger";
import { parseOrThrow } from "../../shared/validate";
import { generateReportPdf } from "../../shared/pdf/report-generator";
import { generateReportXlsx } from "../../shared/xlsx/report-generator";
import {
  buildRouteSheetTable,
  loadBatchRouteSheet,
} from "./collector-batch-route-sheet.service";
import {
  addBatchAssignments,
  cancelBatch,
  closeBatch,
  createCollectorBatch,
  getCollectorBatchDetail,
  listAssignableCollectors,
  listBatchRemittances,
  listCollectorBatches,
  reconcileBatch,
  recordBatchRemittance,
  recordCollection,
  submitBatch,
  voidCollection,
  type BatchActor,
} from "./collector-batches.service";
import { callerSeesEveryCollectorBatch } from "./collector-batch-visibility";

/**
 * The caller reduced to what the batch services need.
 *
 * The visibility scope is resolved here — once, at the edge — from the same RBAC
 * grants the route guards read, so the service never has to know a legacy role.
 */
async function callerAsActor(request: FastifyRequest): Promise<BatchActor> {
  const user = request.user;
  if (user === undefined) {
    // `authenticate` runs before every one of these routes, so a missing caller is
    // a misconfigured route; answering 401 is safer than inventing one.
    throw new UnauthorizedError();
  }

  return {
    id: user.id,
    username: user.username,
    seesEveryCollectorBatch: await callerSeesEveryCollectorBatch(user.id, user.role),
    clientIpAddress: request.ip,
  };
}

/** A batch id path parameter. */
const batchIdParamsSchema = z.object({
  id: z.string().uuid("A valid collector batch id is required"),
});

/** A batch id plus the assignment's service account id. */
const batchAssignmentParamsSchema = z.object({
  id: z.string().uuid("A valid collector batch id is required"),
  serviceAccountId: z.string().uuid("A valid service account id is required"),
});

/** GET /api/collector-batches/collectors — the collectors this caller may batch for. */
export async function getAssignableCollectors(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  return sendSuccess(reply, {
    items: await listAssignableCollectors(await callerAsActor(request)),
  });
}

/** GET /api/collector-batches — the batch list, filtered and scoped to the caller. */
export async function getCollectorBatches(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const query = parseOrThrow(listCollectorBatchesQuerySchema, request.query);
  const result = await listCollectorBatches(
    {
      collectorId: query.collectorId,
      status: query.status,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      page: query.page,
      pageSize: query.pageSize,
    },
    await callerAsActor(request)
  );
  return sendSuccess(reply, result);
}

/** POST /api/collector-batches — creates a batch with its first accounts. */
export async function postCollectorBatch(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const body = parseOrThrow(createCollectorBatchSchema, request.body);
  const batch = await createCollectorBatch(body, await callerAsActor(request));
  await audit.collectorBatchCreated({ ...batch }, batch.assignmentCount, requestActor(request));
  return sendSuccess(reply, batch, 201);
}

/** GET /api/collector-batches/:id — one batch with its assignments and totals. */
export async function getCollectorBatch(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(batchIdParamsSchema, request.params);
  return sendSuccess(reply, await getCollectorBatchDetail(id, await callerAsActor(request)));
}

/** POST /api/collector-batches/:id/assignments — adds accounts to an open batch. */
export async function postBatchAssignments(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(batchIdParamsSchema, request.params);
  const body = parseOrThrow(addBatchAssignmentsSchema, request.body);
  const batch = await addBatchAssignments(id, body.serviceAccountIds, await callerAsActor(request));
  return sendSuccess(reply, batch, 201);
}

/** PUT /api/collector-batches/:id/assignments/:serviceAccountId — records a visit. */
export async function putCollectionResult(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const params = parseOrThrow(batchAssignmentParamsSchema, request.params);
  const body = parseOrThrow(recordCollectionSchema, request.body);

  const result = await recordCollection(
    params.id,
    params.serviceAccountId,
    {
      result: body.result,
      collectedAmountCentavos: body.collectedAmountCentavos,
      collectedMethod: body.collectedMethod,
      collectorNotes: body.collectorNotes,
      gcash: body.gcash,
    },
    await callerAsActor(request)
  );

  return sendSuccess(reply, result);
}

/**
 * PUT /api/collector-batches/:id/assignments/:serviceAccountId/void — voids a
 * recorded collection, reversing the payment it created.
 */
export async function putCollectionVoided(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const params = parseOrThrow(batchAssignmentParamsSchema, request.params);
  const body = parseOrThrow(voidCollectionSchema, request.body);

  const result = await voidCollection(
    params.id,
    params.serviceAccountId,
    body.reason,
    await callerAsActor(request)
  );

  return sendSuccess(reply, result);
}

/** POST /api/collector-batches/:id/submit — declares the field run finished. */
export async function postBatchSubmitted(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(batchIdParamsSchema, request.params);
  parseOrThrow(submitBatchSchema, request.body ?? {});

  const result = await submitBatch(id, await callerAsActor(request));
  await audit.collectorBatchSubmitted(
    {
      batchId: result.batchId,
      expectedRemittanceCentavos: result.expectedRemittanceCentavos,
      actualRemittanceCentavos: 0,
      varianceCentavos: 0,
    },
    result.previousStatus,
    requestActor(request)
  );
  return sendSuccess(reply, result);
}

/**
 * POST /api/collector-batches/:id/remit — records the cash handed in (S4-2).
 *
 * Writes a `collector_remittances` row and keeps the batch total and variance
 * consistent with the sum of those rows. A batch may be remitted more than once.
 */
export async function postBatchRemitted(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(batchIdParamsSchema, request.params);
  const body = parseOrThrow(recordBatchRemittanceSchema, request.body);

  const result = await recordBatchRemittance(
    id,
    {
      amountCentavos: body.amountCentavos,
      cashAmountCentavos: body.cashAmountCentavos,
      gcashAmountCentavos: body.gcashAmountCentavos,
      notes: body.notes,
    },
    await callerAsActor(request)
  );

  await audit.collectorBatchRemitted(
    {
      batchId: result.batchId,
      expectedRemittanceCentavos: result.expectedRemittanceCentavos,
      actualRemittanceCentavos: result.actualRemittanceCentavos,
      varianceCentavos: result.varianceCentavos,
    },
    result.previousStatus,
    requestActor(request)
  );
  return sendSuccess(reply, result);
}

/** GET /api/collector-batches/:id/remittances — the batch's remittance history. */
export async function getBatchRemittances(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(batchIdParamsSchema, request.params);
  const items = await listBatchRemittances(id, await callerAsActor(request));
  return sendSuccess(reply, { items });
}

/** GET /api/collector-batches/:id/route-sheet — the printable route sheet (S4-3). */
export async function getBatchRouteSheet(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(batchIdParamsSchema, request.params);
  const sheet = await loadBatchRouteSheet(id, await callerAsActor(request));
  return sendSuccess(reply, sheet);
}

/** The route-sheet download format. */
const routeSheetExportQuerySchema = z.object({
  format: z.enum(["pdf", "xlsx"]).default("pdf"),
});

/**
 * GET /api/collector-batches/:id/route-sheet/export — the sheet as a file (S4-3).
 *
 * It renders through the SAME report table and PDF/XLSX generators every other
 * report uses, so a sheet that prints and a sheet that exports show one set of
 * numbers. Route sheet generation performs no write.
 */
export async function getBatchRouteSheetExport(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(batchIdParamsSchema, request.params);
  const { format } = parseOrThrow(routeSheetExportQuerySchema, request.query ?? {});

  const sheet = await loadBatchRouteSheet(id, await callerAsActor(request));
  const table = buildRouteSheetTable(sheet);
  const fileName = `route-sheet-${sheet.batchNumber}`;

  if (format === "xlsx") {
    const workbook = generateReportXlsx(table);
    return reply
      .header(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      )
      .header("Content-Disposition", `attachment; filename="${fileName}.xlsx"`)
      .send(Buffer.from(workbook));
  }

  const pdf = await generateReportPdf(table);
  return reply
    .header("Content-Type", "application/pdf")
    .header("Content-Disposition", `attachment; filename="${fileName}.pdf"`)
    .send(pdf);
}

/** POST /api/collector-batches/:id/reconcile — reconciles a remitted batch. */
export async function postBatchReconciled(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(batchIdParamsSchema, request.params);
  const body = parseOrThrow(reconcileBatchSchema, request.body ?? {});

  const result = await reconcileBatch(id, body.varianceNotes, await callerAsActor(request));
  await audit.collectorBatchReconciled(
    result,
    result.previousStatus,
    body.varianceNotes,
    requestActor(request)
  );
  return sendSuccess(reply, result);
}

/**
 * POST /api/collector-batches/:id/close — the supervisor's final sign-off (S4-1).
 *
 * A separate authorized action from reconciliation: only a reconciled batch may be
 * closed, and the state machine refuses any other source state.
 */
export async function postBatchClosed(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(batchIdParamsSchema, request.params);
  const body = parseOrThrow(closeBatchSchema, request.body ?? {});

  const result = await closeBatch(id, await callerAsActor(request));
  await audit.collectorBatchClosed(result, result.previousStatus, requestActor(request));
  if (body.notes !== undefined && body.notes.trim().length > 0) {
    await logAuditEntry({
      action: "collector_batch.closed",
      entityType: "collector_batch",
      entityId: result.batchId,
      description: `Close note: ${body.notes.trim()}`,
      ...requestActorFields(request),
    });
  }
  return sendSuccess(reply, result);
}

/** POST /api/collector-batches/:id/cancel — abandons an open batch with no collections. */
export async function postBatchCancelled(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(batchIdParamsSchema, request.params);
  const body = parseOrThrow(cancelBatchSchema, request.body);

  const batch = await cancelBatch(id, body.reason, await callerAsActor(request));
  await audit.collectorBatchCancelled({ ...batch }, body.reason, requestActor(request));
  return sendSuccess(reply, batch);
}