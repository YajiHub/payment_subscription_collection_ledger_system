// Handlers for the payment endpoints.
// Each handler validates input, calls a payment service, and writes the reply.

import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  listPaymentsQuerySchema,
  manualAllocationPaymentSchema,
  paymentIdParamsSchema,
  postPaymentSchema,
  receiptNumberParamsSchema,
  rejectGcashPaymentSchema,
  reversePaymentSchema,
  uploadGcashScreenshotSchema,
} from "@bcis/shared";
import { sendSuccess } from "../../shared/response";
import { parseOrThrow } from "../../shared/validate";
import { audit, requestActor } from "../../shared/audit/audit-logger";
import { postPayment } from "./post-payment.service";
import { rejectGcashPayment, verifyGcashPayment } from "./verify-gcash-payment.service";
import { reversePayment } from "./reverse-payment.service";
import { readGcashScreenshot, storeGcashScreenshot } from "./gcash-screenshot.service";
import {
  getPaymentByReceiptNumber,
  getPaymentById,
  getServiceAccountPaymentSummary,
  listPayments,
  listPaymentsForServiceAccount,
  listPendingGcashPayments,
} from "./payments.service";

/** A service account id path parameter. */
const serviceAccountIdParamsSchema = z.object({
  serviceAccountId: z.string().uuid("A valid service account id is required"),
});

/** A payment id path parameter, named after the GCash screenshot route. */
const gcashScreenshotParamsSchema = z.object({
  paymentId: z.string().uuid("A valid payment id is required"),
});

/** POST /api/payments — records a payment.
 *
 * Cash, bank transfer, cheque and other are posted and allocated at once. A GCash
 * payment is recorded as pending verification and moves no balance until a verifier
 * confirms it (S3-1, S3-2).
 */
export async function postPaymentHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const body = parseOrThrow(postPaymentSchema, request.body);
  const postedByUserId = request.user?.id ?? "";

  const result = await postPayment({
    serviceAccountId: body.serviceAccountId,
    paymentMethod: body.paymentMethod,
    amountCentavos: body.amountCentavos,
    paymentDate: body.paymentDate,
    notes: body.notes,
    postedByUserId,
    actor: requestActor(request),
    gcash: body.gcash,
  });

  return sendSuccess(
    reply,
    {
      payment: result.payment,
      allocations: result.allocations,
      allocatedCentavos: result.allocatedCentavos,
      advanceCreditCentavos: result.advanceCreditCentavos,
    },
    201
  );
}

/**
 * POST /api/payments/manual-allocation — S3-5.
 *
 * Posts a payment whose money is already in hand and directs it at the invoices the
 * operator chose, instead of the default oldest-unpaid-first sweep. The reason and
 * the chosen split are audited with the payment.
 */
export async function postManualAllocationHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const body = parseOrThrow(manualAllocationPaymentSchema, request.body);
  const postedByUserId = request.user?.id ?? "";

  const result = await postPayment({
    serviceAccountId: body.serviceAccountId,
    paymentMethod: body.paymentMethod,
    amountCentavos: body.amountCentavos,
    paymentDate: body.paymentDate,
    notes: body.notes,
    postedByUserId,
    actor: requestActor(request),
    manualAllocation: body.manualAllocation,
  });

  return sendSuccess(
    reply,
    {
      payment: result.payment,
      allocations: result.allocations,
      allocatedCentavos: result.allocatedCentavos,
      advanceCreditCentavos: result.advanceCreditCentavos,
    },
    201
  );
}

/**
 * POST /api/payments/gcash/:id/verify — S3-2, S3-3.
 *
 * Confirms a pending GCash payment, which posts and allocates it oldest-invoice-first
 * and records the verifier's identity and the time on the GCash detail row.
 */
export async function verifyGcashPaymentHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(paymentIdParamsSchema, request.params);
  const verifiedByUserId = request.user?.id ?? "";

  const result = await verifyGcashPayment({
    paymentId: id,
    verifiedByUserId,
    actor: requestActor(request),
  });

  return sendSuccess(reply, {
    payment: result.payment,
    gcash: result.gcash,
    allocations: result.allocations,
    allocatedCentavos: result.allocatedCentavos,
    advanceCreditCentavos: result.advanceCreditCentavos,
  });
}

/** POST /api/payments/gcash/:id/reject — S3-2, S3-3. The reason is mandatory. */
export async function rejectGcashPaymentHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(paymentIdParamsSchema, request.params);
  const body = parseOrThrow(rejectGcashPaymentSchema, request.body);

  const result = await rejectGcashPayment({
    paymentId: id,
    reason: body.reason,
    rejectedByUserId: request.user?.id ?? "",
    actor: requestActor(request),
  });

  return sendSuccess(reply, { payment: result.payment, gcash: result.gcash });
}

/** GET /api/payments/gcash/pending — the verification queue, oldest claim first. */
export async function listPendingGcashPaymentsHandler(
  _request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  return sendSuccess(reply, await listPendingGcashPayments());
}

/** GET /api/payments — payment history filtered by date, method, or status. */
export async function listPaymentsHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const query = parseOrThrow(listPaymentsQuerySchema, request.query);
  const page = await listPayments({
    serviceAccountId: query.serviceAccountId,
    subscriberId: query.subscriberId,
    method: query.method,
    status: query.status,
    dateFrom: query.dateFrom,
    dateTo: query.dateTo,
    page: query.page,
    pageSize: query.pageSize,
  });
  return sendSuccess(reply, page);
}

/** GET /api/payments/:id — one payment with its allocations. */
export async function getPaymentHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(paymentIdParamsSchema, request.params);
  return sendSuccess(reply, await getPaymentById(id));
}

/** GET /api/payments/receipt/:receiptNumber — lookup by Official Receipt number. */
export async function getPaymentByReceiptHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { receiptNumber } = parseOrThrow(receiptNumberParamsSchema, request.params);
  return sendSuccess(reply, await getPaymentByReceiptNumber(receiptNumber));
}

/** POST /api/payments/:id/reverse — reverses a payment (Admin only). */
export async function reversePaymentHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(paymentIdParamsSchema, request.params);
  const body = parseOrThrow(reversePaymentSchema, request.body);
  const reversedByUserId = request.user?.id ?? "";

  const result = await reversePayment(id, body.reason, reversedByUserId, requestActor(request));
  return sendSuccess(reply, result);
}

/** GET /api/service-accounts/:serviceAccountId/payments — payments for one account. */
export async function listServiceAccountPaymentsHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { serviceAccountId } = parseOrThrow(serviceAccountIdParamsSchema, request.params);
  const page = await listPaymentsForServiceAccount(serviceAccountId);
  return sendSuccess(reply, page);
}

/** GET /api/service-accounts/:serviceAccountId/payment-summary — outstanding invoices. */
export async function getServiceAccountPaymentSummaryHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { serviceAccountId } = parseOrThrow(serviceAccountIdParamsSchema, request.params);
  return sendSuccess(reply, await getServiceAccountPaymentSummary(serviceAccountId));
}

/** POST /api/payments/gcash/upload-screenshot — stores a GCash proof screenshot. */
export async function uploadGcashScreenshotHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const body = parseOrThrow(uploadGcashScreenshotSchema, request.body);
  const stored = await storeGcashScreenshot({
    contentType: body.contentType,
    dataBase64: body.dataBase64,
  });

  // Attaching evidence to a claim is attributable: the upload is recorded with the
  // actor and the server-generated file name. The claim itself does not exist yet
  // (its path is attached when the payment is posted), so the row carries the nil
  // entity id used for events with no single row.
  await audit.gcashScreenshotUploaded({ ...stored, contentType: body.contentType }, requestActor(request));

  return sendSuccess(reply, stored, 201);
}

/** GET /api/payments/gcash/screenshot/:paymentId — streams a stored screenshot. */
export async function downloadGcashScreenshotHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { paymentId } = parseOrThrow(gcashScreenshotParamsSchema, request.params);
  const payment = await getPaymentById(paymentId);

  if (payment.gcash?.screenshotFilePath == null) {
    return sendSuccess(reply, { screenshotFilePath: null });
  }

  const screenshot = await readGcashScreenshot(payment.gcash.screenshotFilePath);
  return reply.header("Content-Type", screenshot.contentType).send(screenshot.contents);
}
