// Route table for the invoice module.
// Only paths, preHandlers, and their handlers live here.

import type { FastifyInstance } from "fastify";

import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import {
  getInvoice,
  getInvoices,
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
  server.post("/api/invoices/:id/post", generate, postInvoicePosted);
  server.post("/api/invoices/:id/void", voidInvoiceRoute, postInvoiceVoided);
}
