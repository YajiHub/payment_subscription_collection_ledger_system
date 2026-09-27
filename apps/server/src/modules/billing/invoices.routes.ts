// Route table for the invoice module.
// Only paths, preHandlers, and their handlers live here.

import type { FastifyInstance } from "fastify";

import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import {
  getInvoice,
  getInvoices,
  postInstallationFee,
  postInvoiceDiscount,
  postInvoicePosted,
  postInvoiceVoided,
  postReconnectionFee,
} from "./invoices.handler";

export async function registerInvoiceRoutes(server: FastifyInstance): Promise<void> {
  const read = { preHandler: [authenticate, authorize("invoices:read")] };
  const generate = { preHandler: [authenticate, authorize("invoices:generate")] };
  const voidInvoiceRoute = { preHandler: [authenticate, authorize("invoices:void")] };

  server.get("/api/invoices", read, getInvoices);
  server.get("/api/invoices/:id", read, getInvoice);
  server.post("/api/invoices/reconnection-fee", generate, postReconnectionFee);
  // An installation fee creates a NEW draft invoice, exactly like a reconnection
  // fee, so it takes the same permission that already guards invoice generation.
  server.post("/api/invoices/installation-fee", generate, postInstallationFee);
  server.post("/api/invoices/:id/post", generate, postInvoicePosted);
  server.post("/api/invoices/:id/void", voidInvoiceRoute, postInvoiceVoided);
  // A discount WRITES DOWN an existing invoice's chargeable total, so it takes the
  // narrowest invoice-mutation permission that already exists. `invoices:void` is
  // that permission: voiding an invoice removes its whole financial effect, so the
  // authority to do that is the authority to reduce it in part. It deliberately
  // is NOT `invoices:generate` — a Cashier holds that one (so a counter operator
  // can bill) but does not hold `invoices:void`, and a cashier must not gain the
  // ability to discount an invoice. A dedicated `invoices:discount` permission
  // would be cleaner but the permission catalogue is seeded by a migration, which
  // is outside this change; this reuse grants no one anything new.
  server.post("/api/invoices/:id/discount", voidInvoiceRoute, postInvoiceDiscount);
}
