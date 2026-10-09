// Handlers for the invoice endpoints.
// Each handler validates input, calls the invoice service, and writes the reply.

import type { FastifyReply, FastifyRequest } from "fastify";

import {
  applyDiscountSchema,
  createInstallationFeeSchema,
  createReconnectionFeeSchema,
  invoiceIdParamsSchema,
  listInvoicesQuerySchema,
  voidInvoiceSchema,
} from "@bcis/shared";
import { sendSuccess } from "../../shared/response";
import { parseOrThrow } from "../../shared/validate";
import { audit, logAuditEntry, requestActor } from "../../shared/audit/audit-logger";
import {
  applyDiscountToDraftInvoice,
  createInstallationFeeInvoice,
  createReconnectionFeeInvoice,
  getInvoiceById,
  listInvoices,
  postInvoiceForId,
} from "./invoices.service";
import { voidInvoice } from "./void-invoice.service";

/**
 * The actor fields an audit row carries for an authenticated request. The JWT
 * carries the username, so the trail names the real operator instead of an
 * anonymous "system".
 */
function requestAuditActorFields(request: FastifyRequest) {
  return {
    performedBy: request.user?.id ?? null,
    performedByUsername: request.user?.username ?? null,
    clientIpAddress: request.ip,
  };
}

/**
 * GET /api/invoices — invoices filtered by status, period, or subscriber.
 *
 * Paged (S8-1): `pageSize` is capped at 200 by the query schema, and the reply
 * carries `total` so a caller can page through everything. `items`, `page` and
 * `pageSize` keep their previous names, so an existing client keeps working; the
 * addition is `total`, and a client that wants later pages sends `page`/`pageSize`.
 */
export async function getInvoices(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const query = parseOrThrow(listInvoicesQuerySchema, request.query);
  const page = await listInvoices({
    status: query.status,
    year: query.year,
    month: query.month,
    subscriberId: query.subscriberId,
    page: query.page,
    pageSize: query.pageSize,
  });
  return sendSuccess(reply, page);
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

/**
 * POST /api/invoices/installation-fee — charges an installation fee (S2-3).
 *
 * The fee becomes a first-class `installation_fee` line item on a new DRAFT
 * invoice, so it feeds the invoice total and, once posted, the ledger debit. The
 * charge is audited with the actor and the new totals because a fee waiver is
 * exactly the kind of action an auditor asks about.
 */
export async function postInstallationFee(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const body = parseOrThrow(createInstallationFeeSchema, request.body);
  const chargedByUserId = request.user?.id ?? "";
  const result = await createInstallationFeeInvoice(
    body.serviceAccountId,
    body.installationFeeCentavos,
    body.reason,
    chargedByUserId
  );

  await logAuditEntry({
    action: "invoice.installation_fee_charged",
    entityType: "invoice",
    entityId: result.invoice.id,
    newState: {
      invoiceNumber: result.invoice.invoiceNumber,
      serviceAccountId: result.invoice.serviceAccountId,
      status: result.invoice.status,
      installationFeeCentavos: result.amountCentavos,
      subtotalCentavos: result.invoice.subtotalCentavos,
      totalAmountCentavos: result.invoice.totalAmountCentavos,
      remainingBalanceCentavos: result.invoice.remainingBalanceCentavos,
    },
    description: `Installation fee of ${result.amountCentavos} centavos charged on invoice ${
      result.invoice.invoiceNumber
    }. Reason: ${body.reason ?? "(none given)"}`,
    ...requestAuditActorFields(request),
  });

  return sendSuccess(reply, result, 201);
}

/**
 * POST /api/invoices/:id/discount — applies a discount to a DRAFT invoice (S2-3).
 *
 * Only a draft may be discounted (S8-2): a finalized invoice is immutable outside
 * the void and adjustment workflows, so the service refuses anything else with a
 * 409 rather than mutating it silently. The audit row carries the old and the new
 * totals and the mandatory reason.
 */
export async function postInvoiceDiscount(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(invoiceIdParamsSchema, request.params);
  const body = parseOrThrow(applyDiscountSchema, request.body);

  // Read the invoice before the change so the audit row can carry the totals the
  // operator saw. The service re-reads the row under a row lock, so this snapshot
  // is audit metadata only and never the basis of the money movement.
  const before = await getInvoiceById(id);

  const invoice = await applyDiscountToDraftInvoice(id, {
    discountCentavos: body.discountCentavos,
    discountRateBasisPoints: body.discountRateBasisPoints,
    reason: body.reason,
  });

  await logAuditEntry({
    action: "invoice.discount_applied",
    entityType: "invoice",
    entityId: invoice.id,
    previousState: {
      status: before.status,
      subtotalCentavos: before.subtotalCentavos,
      totalAmountCentavos: before.totalAmountCentavos,
      remainingBalanceCentavos: before.remainingBalanceCentavos,
    },
    newState: {
      status: invoice.status,
      subtotalCentavos: invoice.subtotalCentavos,
      totalAmountCentavos: invoice.totalAmountCentavos,
      remainingBalanceCentavos: invoice.remainingBalanceCentavos,
      discountCentavos: before.totalAmountCentavos - invoice.totalAmountCentavos,
    },
    description: `Discount applied to invoice ${invoice.invoiceNumber}. Reason: ${body.reason}`,
    ...requestAuditActorFields(request),
  });

  return sendSuccess(reply, invoice);
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
  const { invoice, previousStatus } = await voidInvoice(id, body.reason, voidedByUserId);
  await audit.invoiceVoided({ ...invoice }, previousStatus, body.reason, requestActor(request));
  return sendSuccess(reply, invoice);
}
