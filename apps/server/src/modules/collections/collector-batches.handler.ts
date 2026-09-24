// Handlers for the collector batch endpoints.
// Each handler validates input, calls the batch service with the authenticated
// caller, and writes the reply.

import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  addBatchAssignmentsSchema,
  cancelBatchSchema,
  createCollectorBatchSchema,
  listCollectorBatchesQuerySchema,
  reconcileBatchSchema,
  recordCollectionSchema,
  submitBatchRemittanceSchema,
  voidCollectionSchema,
} from "@bcis/shared";
import { sendSuccess } from "../../shared/response";
import { parseOrThrow } from "../../shared/validate";
import {
  addBatchAssignments,
  cancelBatch,
  createCollectorBatch,
  getCollectorBatchDetail,
  listAssignableCollectors,
  listCollectorBatches,
  reconcileBatch,
  recordCollection,
  submitBatchRemittance,
  voidCollection,
  type BatchActor,
} from "./collector-batches.service";

/** The caller reduced to what the batch services need. */
function callerAsActor(request: FastifyRequest): BatchActor {
  return {
    id: request.user?.id ?? "",
    role: request.user?.role ?? "collector",
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

/** GET /api/collector-batches/collectors — the active collectors a batch can be for. */
export async function getAssignableCollectors(
  _request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  return sendSuccess(reply, { items: await listAssignableCollectors() });
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
    callerAsActor(request)
  );
  return sendSuccess(reply, result);
}

/** POST /api/collector-batches — creates a batch with its first accounts. */
export async function postCollectorBatch(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const body = parseOrThrow(createCollectorBatchSchema, request.body);
  const batch = await createCollectorBatch(body, callerAsActor(request));
  return sendSuccess(reply, batch, 201);
}

/** GET /api/collector-batches/:id — one batch with its assignments and totals. */
export async function getCollectorBatch(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(batchIdParamsSchema, request.params);
  return sendSuccess(reply, await getCollectorBatchDetail(id, callerAsActor(request)));
}

/** POST /api/collector-batches/:id/assignments — adds accounts to an open batch. */
export async function postBatchAssignments(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(batchIdParamsSchema, request.params);
  const body = parseOrThrow(addBatchAssignmentsSchema, request.body);
  const batch = await addBatchAssignments(id, body.serviceAccountIds, callerAsActor(request));
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
    callerAsActor(request)
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
    callerAsActor(request)
  );

  return sendSuccess(reply, result);
}

/** POST /api/collector-batches/:id/submit — declares the cash handed in. */
export async function postBatchSubmitted(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(batchIdParamsSchema, request.params);
  const body = parseOrThrow(submitBatchRemittanceSchema, request.body);

  const result = await submitBatchRemittance(id, body.actualRemittanceCentavos, callerAsActor(request));
  return sendSuccess(reply, result);
}

/** POST /api/collector-batches/:id/reconcile — closes a submitted batch. */
export async function postBatchReconciled(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(batchIdParamsSchema, request.params);
  const body = parseOrThrow(reconcileBatchSchema, request.body);

  const result = await reconcileBatch(id, body.varianceNotes, callerAsActor(request));
  return sendSuccess(reply, result);
}

/** POST /api/collector-batches/:id/cancel — abandons an open batch with no collections. */
export async function postBatchCancelled(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(batchIdParamsSchema, request.params);
  const body = parseOrThrow(cancelBatchSchema, request.body);

  const batch = await cancelBatch(id, body.reason, callerAsActor(request));
  return sendSuccess(reply, batch);
}