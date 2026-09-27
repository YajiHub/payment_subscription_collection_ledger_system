// Handlers for the backup and restore endpoints.
//
// Each handler validates input, calls the backup service, and writes the reply.
// The audit row is written AFTER the operation succeeded, as everywhere else.

import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { requestActor } from "../../shared/audit/audit-logger";
import { audit } from "../../shared/audit/audit-logger";
import { ValidationError } from "../../shared/errors";
import { sendSuccess } from "../../shared/response";
import { parseOrThrow } from "../../shared/validate";
import { createBackup, listBackups, restoreBackup, verifyBackup } from "./backup.service";

const backupIdParamsSchema = z.object({
  id: z.string().uuid("A valid backup id is required"),
});

/**
 * A restore overwrites the entire database, so the caller must confirm explicitly.
 * `z.literal(true)` means the field must be present and `true`; anything else is a
 * validation error and the restore never starts.
 */
const restoreBackupBodySchema = z.object({
  confirm: z.literal(true, {
    errorMap: () => ({ message: "Restoring overwrites the database; send { confirm: true } to proceed" }),
  }),
});

function requireUserId(request: FastifyRequest): string {
  const userId = request.user?.id;
  if (userId === undefined) {
    throw new ValidationError("Authentication required");
  }
  return userId;
}

/** GET /api/backups — the recorded backup history, newest first. */
export async function getBackupsHandler(
  _request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  return sendSuccess(reply, { items: await listBackups() });
}

/** POST /api/backups — create and verify a backup, then record it. */
export async function postBackupHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const created = await createBackup(requireUserId(request));
  await audit.backupCreated({ ...created }, requestActor(request));
  return sendSuccess(reply, created, 201);
}

/** POST /api/backups/:id/verify — re-check a recorded archive's integrity. */
export async function postBackupVerifyHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(backupIdParamsSchema, request.params);
  const verified = await verifyBackup(id);
  await audit.backupVerified({ ...verified }, requestActor(request));
  return sendSuccess(reply, verified);
}

/** POST /api/backups/:id/restore — restore from a verified archive. */
export async function postBackupRestoreHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(backupIdParamsSchema, request.params);
  // Parsing the body first makes the explicit confirmation a precondition of the
  // service call, so no code path can reach pg_restore without it.
  parseOrThrow(restoreBackupBodySchema, request.body);

  const restored = await restoreBackup(id);
  await audit.backupRestored({ ...restored }, requestActor(request));
  return sendSuccess(reply, restored);
}
