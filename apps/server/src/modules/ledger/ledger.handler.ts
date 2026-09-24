// Handlers for the ledger and statement-of-account endpoints.
// Each handler validates input, calls a ledger service, and writes the reply.

import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { listLedgerQuerySchema, manualLedgerEntrySchema, statementQuerySchema } from "@bcis/shared";
import { db } from "../../db/connection";
import { sendSuccess } from "../../shared/response";
import { parseOrThrow } from "../../shared/validate";
import {
  getLedgerHeader,
  getServiceAccountBalance,
  listLedgerEntries,
} from "./ledger-query.service";
import { recordManualEntry, verifyLedgerIntegrity } from "./ledger.service";
import { getStatementOfAccount } from "./statement-of-account.service";

/** A service account id path parameter, named as the subscriber module names it. */
const serviceAccountIdParamsSchema = z.object({
  id: z.string().uuid("A valid service account id is required"),
});

/** A service account id path parameter, named as the verify route names it. */
const serviceAccountIdPathSchema = z.object({
  serviceAccountId: z.string().uuid("A valid service account id is required"),
});

/** GET /api/service-accounts/:id/ledger — the account header and a page of entries. */
export async function getServiceAccountLedgerHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(serviceAccountIdParamsSchema, request.params);
  const query = parseOrThrow(listLedgerQuerySchema, request.query);

  const header = await getLedgerHeader(id);
  const entries = await listLedgerEntries(id, {
    fromDate: query.fromDate,
    toDate: query.toDate,
    page: query.page,
    pageSize: query.pageSize,
  });

  return sendSuccess(reply, { header, ...entries });
}

/** GET /api/service-accounts/:id/balance — the current balance only (fast). */
export async function getServiceAccountBalanceHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(serviceAccountIdParamsSchema, request.params);
  return sendSuccess(reply, await getServiceAccountBalance(id));
}

/** GET /api/service-accounts/:id/statement — the full statement of account. */
export async function getServiceAccountStatementHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(serviceAccountIdParamsSchema, request.params);
  const query = parseOrThrow(statementQuerySchema, request.query);
  return sendSuccess(
    reply,
    await getStatementOfAccount(id, { fromDate: query.fromDate, toDate: query.toDate })
  );
}

/** GET /api/ledger/verify/:serviceAccountId — integrity check (Admin only). */
export async function verifyLedgerIntegrityHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { serviceAccountId } = parseOrThrow(serviceAccountIdPathSchema, request.params);
  return sendSuccess(reply, await verifyLedgerIntegrity(serviceAccountId));
}

/**
 * POST /api/ledger/manual-entry — a manual debit or credit (Admin only).
 *
 * The entry is created inside a transaction so the per-account advisory lock is
 * held while the previous balance and sequence number are read, and the new balance
 * is returned for the caller to display.
 */
export async function postManualLedgerEntryHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const body = parseOrThrow(manualLedgerEntrySchema, request.body);
  const createdByUserId = request.user?.id ?? "";

  const result = await db.transaction(async (tx) => {
    const entryId = await recordManualEntry(tx, {
      serviceAccountId: body.serviceAccountId,
      entryType: body.entryType,
      amountCentavos: body.amountCentavos,
      reason: body.reason,
      createdByUserId,
    });

    const balance = await getServiceAccountBalance(body.serviceAccountId, tx);
    return { entryId, balanceCentavos: balance.balanceCentavos };
  });

  return sendSuccess(reply, result, 201);
}
