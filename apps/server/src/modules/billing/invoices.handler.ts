// Handlers for the invoice endpoints.
// Each handler validates input, calls the invoice service, and writes the reply.

import type { FastifyReply, FastifyRequest } from "fastify";

import {
  createReconnectionFeeSchema,
  invoiceIdParamsSchema,
  listInvoicesQuerySchema,
  voidInvoiceSchema,
} from "@bcis/shared";
import { sendSuccess } from "../../shared/response";
import { parseOrThrow } from "../../shared/validate";
import { audit, requestActor } from "../../shared/audit/audit-logger";
import {
  createReconnectionFeeInvoice,
  getInvoiceById,
  listInvoices,
  postInvoiceForId,
} from "./invoices.service";
import { voidInvoice } from "./void-invoice.service";

/** GET /api/invoices — invoices filtered by status, period, or subscriber. */
export async function getInvoices(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const query = parseOrThrow(listInvoicesQuerySchema, request.query);
  const items = await listInvoices({
    status: query.status,
    year: query.year,
    month: query.month,
    subscriberId: query.subscriberId,
  });
  return sendSuccess(reply, { items, page: query.page, pageSize: query.pageSize });
}

/** GET /api/invoices/:id — one invoice with its line items. */
export async function getInvoice(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(invoiceIdParamsSchema, request.params);
  const invoice = await getInvoiceById(id);
  return sendSuccess(reply, invoice);
}

/** POST /api/invoices/reconnection-fee — generates a reconnection fee invoice. */
export async function postReconnectionFee(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const body = parseOrThrow(createReconnectionFeeSchema, request.body);
  const createdByUserId = request.user?.id ?? "";
  const result = await createReconnectionFeeInvoice(
    body.serviceAccountId,
    body.reason,
    createdByUserId
  );
  return sendSuccess(reply, result, 201);
}

/** POST /api/invoices/:id/post — posts one draft invoice, creating a ledger debit. */
export async function postInvoicePosted(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(invoiceIdParamsSchema, request.params);
  const postedByUserId = request.user?.id ?? "";
  const invoice = await postInvoiceForId(id, postedByUserId);
  await audit.invoicePosted({ ...invoice }, requestActor(request));
  return sendSuccess(reply, invoice);
}

/** POST /api/invoices/:id/void — voids an invoice, creating a ledger credit. */
export async function postInvoiceVoided(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(invoiceIdParamsSchema, request.params);
  const body = parseOrThrow(voidInvoiceSchema, request.body);
  const voidedByUserId = request.user?.id ?? "";
  const invoice = await voidInvoice(id, body.reason, voidedByUserId);
  await audit.invoiceVoided({ ...invoice }, body.reason, requestActor(request));
  return sendSuccess(reply, invoice);
}
