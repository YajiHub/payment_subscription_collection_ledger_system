// Route table for the ledger module.
// Only paths, preHandlers, and their handlers live here.
//
// Reading a ledger is a financial-data action, so it needs `ledger:read`. The
// integrity check and manual adjustments are administrative and need `ledger:verify`
// and `ledger:adjust`, which only the Admin holds.

import type { FastifyInstance } from "fastify";

import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import {
  getServiceAccountBalanceHandler,
  getServiceAccountLedgerHandler,
  getServiceAccountStatementHandler,
  postManualLedgerEntryHandler,
  verifyLedgerIntegrityHandler,
} from "./ledger.handler";

export async function registerLedgerRoutes(server: FastifyInstance): Promise<void> {
  const read = { preHandler: [authenticate, authorize("ledger:read")] };
  const verify = { preHandler: [authenticate, authorize("ledger:verify")] };
  const adjust = { preHandler: [authenticate, authorize("ledger:adjust")] };

  // The static "/api/ledger" paths are declared before the ":id" routes so a literal
  // segment is never mistaken for a service account id.
  server.get("/api/ledger/verify/:serviceAccountId", verify, verifyLedgerIntegrityHandler);
  server.post("/api/ledger/manual-entry", adjust, postManualLedgerEntryHandler);

  server.get("/api/service-accounts/:id/ledger", read, getServiceAccountLedgerHandler);
  server.get("/api/service-accounts/:id/balance", read, getServiceAccountBalanceHandler);
  server.get("/api/service-accounts/:id/statement", read, getServiceAccountStatementHandler);
}
