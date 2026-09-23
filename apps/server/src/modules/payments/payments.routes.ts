// Route table for the payments module.
// Only paths, preHandlers, and their handlers live here.

import type { FastifyInstance } from "fastify";

import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import {
  downloadGcashScreenshotHandler,
  getPaymentByReceiptHandler,
  getPaymentHandler,
  getServiceAccountPaymentSummaryHandler,
  listPaymentsHandler,
  listServiceAccountPaymentsHandler,
  postPaymentHandler,
  reversePaymentHandler,
  uploadGcashScreenshotHandler,
} from "./payments.handler";

export async function registerPaymentRoutes(server: FastifyInstance): Promise<void> {
  const post = { preHandler: [authenticate, authorize("payments:post")] };
  const read = { preHandler: [authenticate, authorize("payments:read")] };
  const reverse = { preHandler: [authenticate, authorize("payments:reverse")] };

  // Static paths are declared first so a literal segment (receipt, gcash) is never
  // swallowed by the :id route.
  server.get("/api/payments/receipt/:receiptNumber", read, getPaymentByReceiptHandler);
  server.post("/api/payments/gcash/upload-screenshot", post, uploadGcashScreenshotHandler);
  server.get("/api/payments/gcash/screenshot/:paymentId", read, downloadGcashScreenshotHandler);

  server.post("/api/payments", post, postPaymentHandler);
  server.get("/api/payments", read, listPaymentsHandler);
  server.get("/api/payments/:id", read, getPaymentHandler);
  server.post("/api/payments/:id/reverse", reverse, reversePaymentHandler);

  server.get(
    "/api/service-accounts/:serviceAccountId/payments",
    read,
    listServiceAccountPaymentsHandler
  );
  server.get(
    "/api/service-accounts/:serviceAccountId/payment-summary",
    read,
    getServiceAccountPaymentSummaryHandler
  );
}
