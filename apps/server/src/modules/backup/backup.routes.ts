// Route table for the backup and restore module (S5-3).
//
// Only the Owner/Administrator hold `backup:create` and `backup:restore`, so
// producing an archive and overwriting the database are administrative acts.
// `backup:restore` is deliberately separate from `backup:create`.

import type { FastifyInstance } from "fastify";

import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import {
  getBackupsHandler,
  postBackupHandler,
  postBackupRestoreHandler,
  postBackupVerifyHandler,
} from "./backup.handler";

export async function registerBackupRoutes(server: FastifyInstance): Promise<void> {
  const create = { preHandler: [authenticate, authorize("backup:create")] };
  const restore = { preHandler: [authenticate, authorize("backup:restore")] };

  server.get("/api/backups", create, getBackupsHandler);
  server.post("/api/backups", create, postBackupHandler);
  server.post("/api/backups/:id/verify", create, postBackupVerifyHandler);
  server.post("/api/backups/:id/restore", restore, postBackupRestoreHandler);
}
