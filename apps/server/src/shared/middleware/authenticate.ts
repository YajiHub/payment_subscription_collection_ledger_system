// Runs on every protected route BEFORE the route handler.
// It verifies the JWT and attaches the caller to `request.user`.
//
// The token is never trusted on its face: this function checks the signature,
// the expiry, whether the token's `jti` was explicitly revoked by a logout, and
// whether the account still exists and is still active. A valid signature alone
// is not enough: deactivating an account must end its live tokens immediately,
// not at their natural 8-hour expiry.

import type { FastifyReply, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import { eq, sql } from "drizzle-orm";

import { config } from "../../config";
import { db } from "../../db/connection";
import { revokedTokens, users } from "../../db/schema/users";
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

  // One statement answers both security questions, so the hot path stays a single
  // round trip:
  //   • the token's `jti` was revoked by a logout, and
  //   • the account still exists and is still active.
  // A one-row probe is joined to the account and to its revocation row, and the
  // result is filtered to refusals only. An empty result is therefore positive
  // proof that the account is present, active, and the token is live. The account
  // id lives in the join, so this query never touches a handler's own filters.
  let refusal:
    | { jti: string | null; accountMissing: boolean; accountInactive: boolean }
    | undefined;
  try {
    refusal = await db
      .select({
        jti: revokedTokens.jti,
        accountMissing: sql<boolean>`${users.id} IS NULL`,
        accountInactive: sql<boolean>`${users.isActive} = false`,
      })
      .from(sql`(SELECT 1) AS token_probe`)
      .leftJoin(users, eq(users.id, payload.sub))
      .leftJoin(revokedTokens, eq(revokedTokens.jti, payload.jti))
      .where(
        sql`${users.id} IS NULL OR ${users.isActive} = false OR ${revokedTokens.jti} IS NOT NULL`
      )
      .limit(1)
      .then((rows) => rows[0]);
  } catch (error) {
    // The database is the only authority on both checks. If it cannot be read,
    // no token can be trusted, so the request is refused rather than let through.
    console.error("[auth] Could not verify the token against the database", error);
    return sendError(reply, 401, "UNAUTHORIZED", "Authentication is temporarily unavailable");
  }

  if (refusal !== undefined) {
    // A logout writes the token's jti here; reject it even though the signature is valid.
    if (refusal.jti != null) {
      return sendError(reply, 401, "UNAUTHORIZED", "Token has been revoked. Please log in again.");
    }

    // The account was deleted, or the id in the token never existed.
    if (refusal.accountMissing === true) {
      return sendError(
        reply,
        401,
        "UNAUTHORIZED",
        "The account for this token no longer exists. Please log in again."
      );
    }

    // Same refusal a fresh login gets, so a deactivated account cannot keep acting
    // on a token minted before it was switched off.
    if (refusal.accountInactive === true) {
      return sendError(
        reply,
        403,
        "FORBIDDEN",
        "Account is deactivated. Contact your administrator."
      );
    }

    // A refusal row that names no known cause cannot be trusted.
    return sendError(reply, 401, "UNAUTHORIZED", "Authentication required");
  }

  // Attach to the request so route handlers can read `request.user.role`.
  request.user = {
    id: payload.sub,
    // A token signed before the username was added to the payload has none, so
    // this stays null rather than inventing a name the trail cannot vouch for.
    username: payload.username ?? null,
    role: payload.role,
    jti: payload.jti,
    tokenExpiresAt: new Date(payload.exp * 1000),
  };
}

