// Handlers for the payment endpoints.
// Each handler validates input, calls a payment service, and writes the reply.

import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  listPaymentsQuerySchema,
  paymentIdParamsSchema,
  postPaymentSchema,
  receiptNumberParamsSchema,
  reversePaymentSchema,
  uploadGcashScreenshotSchema,
} from "@bcis/shared";
import { sendSuccess } from "../../shared/response";
import { parseOrThrow } from "../../shared/validate";
import { requestActor } from "../../shared/audit/audit-logger";
import { postPayment } from "./post-payment.service";
import { reversePayment } from "./reverse-payment.service";
import { readGcashScreenshot, storeGcashScreenshot } from "./gcash-screenshot.service";
import {
  getPaymentByReceiptNumber,
  getPaymentById,
  getServiceAccountPaymentSummary,
  listPayments,
  listPaymentsForServiceAccount,
} from "./payments.service";

/** A service account id path parameter. */
const serviceAccountIdParamsSchema = z.object({
  serviceAccountId: z.string().uuid("A valid service account id is required"),
});

/** A payment id path parameter, named after the GCash screenshot route. */
const gcashScreenshotParamsSchema = z.object({
  paymentId: z.string().uuid("A valid payment id is required"),
});

/** POST /api/payments — posts a Cash or GCash payment. */
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

/** GET /api/payments — payment history filtered by date, method, or status. */
export async function listPaymentsHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const query = parseOrThrow(listPaymentsQuerySchema, request.query);
  const items = await listPayments({
    serviceAccountId: query.serviceAccountId,
    method: query.method,
    status: query.status,
    dateFrom: query.dateFrom,
    dateTo: query.dateTo,
  });
  return sendSuccess(reply, { items, page: query.page, pageSize: query.pageSize });
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
  const items = await listPaymentsForServiceAccount(serviceAccountId);
  return sendSuccess(reply, { items });
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
