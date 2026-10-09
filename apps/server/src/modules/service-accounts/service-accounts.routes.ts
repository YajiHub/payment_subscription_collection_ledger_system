// Route table for the service account module.
// Only paths, preHandlers, and their handlers live here.
//
// Suspension and reconnection have their own permissions: they change whether a
// household receives service, so they are granted separately from ordinary edits.

import type { FastifyInstance } from "fastify";

import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import {
  getServiceAccount,
  getServiceAccounts,
  getSuspensionCandidates,
  postServiceAccount,
  postSuspensionRun,
  putServiceAccountActivated,
  putServiceAccountCollector,
  putServiceAccountPlan,
  putServiceAccountReconnected,
  putServiceAccountSuspended,
  putServiceAccountTerminated,
} from "./service-accounts.handler";

export async function registerServiceAccountRoutes(server: FastifyInstance): Promise<void> {
  const read = { preHandler: [authenticate, authorize("subscribers:read")] };
  const create = { preHandler: [authenticate, authorize("subscribers:create")] };
  const suspend = { preHandler: [authenticate, authorize("subscribers:suspend")] };
  const reconnect = { preHandler: [authenticate, authorize("subscribers:reconnect")] };
  const update = { preHandler: [authenticate, authorize("subscribers:update")] };

  // S4-7: threshold preview and the explicit run. Both are declared before the
  // ":id" routes so the literal "suspension-candidates" segment is never mistaken
  // for a service account id. Looking at the candidates is a read; running the
  // suspensions needs the suspend permission.
  server.get(
    "/api/service-accounts/suspension-candidates",
    read,
    getSuspensionCandidates
  );
  server.post(
    "/api/service-accounts/suspension-candidates/run",
    suspend,
    postSuspensionRun
  );

  // S3.2: the account list and its search. Registered before the ":id" route for
  // readability; Fastify prefers a static segment regardless.
  server.get("/api/service-accounts", read, getServiceAccounts);

  server.get("/api/service-accounts/:id", read, getServiceAccount);

  // Adding a service to an existing subscriber is a subscriber-creation action.
  server.post("/api/subscribers/:id/service-accounts", create, postServiceAccount);

  server.put("/api/service-accounts/:id/suspend", suspend, putServiceAccountSuspended);
  server.put("/api/service-accounts/:id/activate", suspend, putServiceAccountActivated);
  server.put("/api/service-accounts/:id/reconnect", reconnect, putServiceAccountReconnected);
  server.put("/api/service-accounts/:id/terminate", suspend, putServiceAccountTerminated);
  server.put("/api/service-accounts/:id/plan", update, putServiceAccountPlan);
  server.put("/api/service-accounts/:id/collector", update, putServiceAccountCollector);
}
