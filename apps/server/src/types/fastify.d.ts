// Module augmentation for Fastify.
//
// The authenticate middleware attaches the verified caller to `request.user`.
// Route handlers and the authorize middleware read it from here, so the shape
// is declared once and every route gets the same strongly-typed property.

import type { UserRole } from "@bcis/shared";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Present only after `authenticate` has run for the current request.
     * `undefined` means the request did not pass authentication.
     */
    user?: AuthenticatedUser;
  }
}

/** The minimal, server-trusted facts about the caller carried by a valid JWT. */
export interface AuthenticatedUser {
  id: string;
  /**
   * The caller's username, carried on the token so the audit trail can name the
   * person who acted. Null for a token minted before the username was added to
   * the payload, so a caller must still fall back on `id`.
   */
  username: string | null;
  role: UserRole;
  jti: string;
  /** When the token expires — needed to expire the revocation record. */
  tokenExpiresAt: Date;
}
