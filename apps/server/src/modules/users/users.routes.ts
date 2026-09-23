// Route table for the user management module.
// Every route is Admin-only, enforced by the `authorize` middleware on the server.

import type { FastifyInstance } from "fastify";

import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import {
  getUser,
  getUsers,
  postUser,
  putUser,
  putUserActiveState,
  putUserPassword,
} from "./users.handler";

export async function registerUserRoutes(server: FastifyInstance): Promise<void> {
  const adminOnly = {
    preHandler: [authenticate, authorize("users:read")],
  };

  server.get("/api/users", adminOnly, getUsers);
  server.get("/api/users/:id", adminOnly, getUser);

  server.post("/api/users", { preHandler: [authenticate, authorize("users:create")] }, postUser);
  server.put("/api/users/:id", { preHandler: [authenticate, authorize("users:update")] }, putUser);
  server.put(
    "/api/users/:id/password",
    { preHandler: [authenticate, authorize("users:update")] },
    putUserPassword
  );
  server.put(
    "/api/users/:id/deactivate",
    { preHandler: [authenticate, authorize("users:deactivate")] },
    putUserActiveState
  );
}
