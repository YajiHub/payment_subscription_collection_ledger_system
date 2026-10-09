// Route table for the payments module.
// Only paths, preHandlers, and their handlers live here.

import type { FastifyInstance } from "fastify";

import { GCASH_SCREENSHOT_MAX_REQUEST_BYTES } from "@bcis/shared";

import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import { requireGcashProofViewer } from "./gcash-proof-access";
import {
  downloadGcashScreenshotHandler,
  getPaymentByReceiptHandler,
  getPaymentHandler,
  getServiceAccountPaymentSummaryHandler,
  listPaymentsHandler,
  listPendingGcashPaymentsHandler,
  listServiceAccountPaymentsHandler,
  postManualAllocationHandler,
  postPaymentHandler,
  rejectGcashPaymentHandler,
  reversePaymentHandler,
  uploadGcashScreenshotHandler,
  verifyGcashPaymentHandler,
} from "./payments.handler";

export async function registerPaymentRoutes(server: FastifyInstance): Promise<void> {
  const post = { preHandler: [authenticate, authorize("payments:post")] };
  const read = { preHandler: [authenticate, authorize("payments:read")] };
  const reverse = { preHandler: [authenticate, authorize("payments:reverse")] };
  // S3-2/S3-3: confirming or refusing a GCash claim are separate permissions, so a
  // clerk who may record a GCash payment cannot also wave it through.
  const verifyGcash = { preHandler: [authenticate, authorize("payments:verify_gcash")] };
  const rejectGcash = { preHandler: [authenticate, authorize("payments:reject_gcash")] };
  // A proof screenshot is customer evidence, so it is NOT readable under the
  // general `payments:read`. Only whoever may act on the claim (verify/reject) or
  // whoever recorded it may download the image — see gcash-proof-access.ts.
  const gcashProofView = { preHandler: [authenticate, requireGcashProofViewer()] };
  // S3-5: directing a payment at chosen invoices is its own authority.
  const manualAllocation = {
    preHandler: [authenticate, authorize("payments:allocate_manually")],
  };

  // Static paths are declared first so a literal segment (receipt, gcash) is never
  // swallowed by the :id route.
  server.get("/api/payments/receipt/:receiptNumber", read, getPaymentByReceiptHandler);
  // The 1 MB general body limit is smaller than a 5 MB image once base64-encoded,
  // so this one route raises its limit to let the upload reach the 5 MB size check
  // that actually enforces the documented cap.
  server.post(
    "/api/payments/gcash/upload-screenshot",
    { ...post, bodyLimit: GCASH_SCREENSHOT_MAX_REQUEST_BYTES },
    uploadGcashScreenshotHandler
  );
  server.get("/api/payments/gcash/screenshot/:paymentId", gcashProofView, downloadGcashScreenshotHandler);
  server.get("/api/payments/gcash/pending", verifyGcash, listPendingGcashPaymentsHandler);
  server.post("/api/payments/gcash/:id/verify", verifyGcash, verifyGcashPaymentHandler);
  server.post("/api/payments/gcash/:id/reject", rejectGcash, rejectGcashPaymentHandler);

  server.post("/api/payments/manual-allocation", manualAllocation, postManualAllocationHandler);
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
