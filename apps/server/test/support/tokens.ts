import { randomUUID } from "node:crypto";

import jwt, { type SignOptions } from "jsonwebtoken";

import type { UserRole } from "@bcis/shared";
import { config } from "../../src/config";

interface TokenOverrides {
  sub?: string;
  role?: UserRole;
  jti?: string;
  // jsonwebtoken accepts a number of seconds or an ms-style string like "8h".
  expiresIn?: SignOptions["expiresIn"];
}

/**
 * Signs a token the server will accept, so a test can pretend to be a given role
 * without going through login (which would need a real user row).
 */
export function signTestToken(overrides: TokenOverrides = {}): { token: string; jti: string } {
  const jti = overrides.jti ?? randomUUID();
  const token = jwt.sign(
    {
      sub: overrides.sub ?? randomUUID(),
      role: overrides.role ?? "admin",
      jti,
    },
    config.JWT_SECRET,
    { expiresIn: overrides.expiresIn ?? "8h" }
  );
  return { token, jti };
}

export function authorizationHeader(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
