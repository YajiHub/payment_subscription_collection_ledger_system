// Usage in a route: preHandler: [authenticate, authorize("payments:post")]
// If the caller's role does not have the required permission → 403 Forbidden.
//
// This is where authorization actually lives. A missing button in the UI is a
// convenience, not a security control: a Cashier who calls a billing endpoint
// directly still passes through this function and is rejected.

import type { FastifyReply, FastifyRequest } from "fastify";
import { roleHasPermission, type Permission } from "@bcis/shared";

import { sendError } from "../response";

export function authorize(requiredPermission: Permission): AuthorizeHandler {
  const authorizeRequest = async function authorizeRequest(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    if (request.user === undefined) {
      return sendError(reply, 401, "UNAUTHORIZED", "Authentication required");
    }

    if (!roleHasPermission(request.user.role, requiredPermission)) {
      return sendError(
        reply,
        403,
        "FORBIDDEN",
        `Access denied. Your role (${request.user.role}) cannot perform: ${requiredPermission}`
      );
    }
  };

  // Exposing the permission on the function lets the RBAC sweep test read the
  // permission a route actually declared, rather than trusting a hand-written
  // list that could drift from the route table.
  authorizeRequest.permission = requiredPermission;
  return authorizeRequest;
}

/** A preHandler that carries the permission it enforces. */
export interface AuthorizeHandler {
  (request: FastifyRequest, reply: FastifyReply): Promise<void>;
  permission: Permission;
}
