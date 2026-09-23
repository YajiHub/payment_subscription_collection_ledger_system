// Route table for the authentication module.
// Only paths, preHandlers, and their handlers live here.

import type { FastifyInstance } from "fastify";

import { authenticate } from "../../shared/middleware/authenticate";
import { getCurrentUser, postLogin, postLogout } from "./auth.handler";

export async function registerAuthRoutes(server: FastifyInstance): Promise<void> {
  // Public: a caller cannot present a token before they have one.
  server.post("/api/auth/login", postLogin);

  // Protected: these require a valid, non-revoked token.
  server.post("/api/auth/logout", { preHandler: [authenticate] }, postLogout);
  server.get("/api/auth/me", { preHandler: [authenticate] }, getCurrentUser);
}
