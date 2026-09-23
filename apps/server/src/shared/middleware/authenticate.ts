// Runs on every protected route BEFORE the route handler.
// It verifies the JWT and attaches the caller to `request.user`.
//
// The token is never trusted on its face: this function checks the signature,
// the expiry, and whether the token's `jti` was explicitly revoked by a logout.

import type { FastifyReply, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";

import { config } from "../../config";
import { db } from "../../db/connection";
import { revokedTokens } from "../../db/schema/users";
import { sendError } from "../response";
import type { JwtPayload } from "../../modules/auth/auth.service";

export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authHeader = request.headers.authorization;
  if (authHeader === undefined || !authHeader.startsWith("Bearer ")) {
    return sendError(reply, 401, "UNAUTHORIZED", "Authentication required");
  }

  const token = authHeader.slice("Bearer ".length);
  let payload: JwtPayload;

  try {
    payload = jwt.verify(token, config.JWT_SECRET) as JwtPayload;
  } catch {
    return sendError(reply, 401, "UNAUTHORIZED", "Invalid or expired token");
  }

  // A logout writes the token's jti here; reject it even though the signature is valid.
  const isRevoked = await db
    .select({ jti: revokedTokens.jti })
    .from(revokedTokens)
    .where(eq(revokedTokens.jti, payload.jti))
    .limit(1)
    .then((rows) => rows.length > 0);

  if (isRevoked) {
    return sendError(reply, 401, "UNAUTHORIZED", "Token has been revoked. Please log in again.");
  }

  // Attach to the request so route handlers can read `request.user.role`.
  request.user = {
    id: payload.sub,
    role: payload.role,
    jti: payload.jti,
    tokenExpiresAt: new Date(payload.exp * 1000),
  };
}
