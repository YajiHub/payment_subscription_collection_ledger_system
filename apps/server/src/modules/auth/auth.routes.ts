// Route table for the authentication module.
// Only paths, preHandlers, and their handlers live here.

import type { FastifyInstance } from "fastify";

import { config } from "../../config";
import { authenticate } from "../../shared/middleware/authenticate";
import { getCurrentUser, postLogin, postLogout } from "./auth.handler";

export async function registerAuthRoutes(server: FastifyInstance): Promise<void> {
  // Public: a caller cannot present a token before they have one.
  //
  // Phase 9 §4: login carries a much stricter rate limit than the rest of the
  // API, per client IP, so a password cannot be brute-forced. The option is set
  // on the route so the general limit registered by securityPlugin still governs
  // every other route.
  server.post(
    "/api/auth/login",
    {
      config: {
        rateLimit: { max: config.LOGIN_RATE_LIMIT_MAX, timeWindow: "5 minutes" },
      },
    },
    postLogin
  );

  // Protected: these require a valid, non-revoked token.
  server.post("/api/auth/logout", { preHandler: [authenticate] }, postLogout);
  server.get("/api/auth/me", { preHandler: [authenticate] }, getCurrentUser);
}
