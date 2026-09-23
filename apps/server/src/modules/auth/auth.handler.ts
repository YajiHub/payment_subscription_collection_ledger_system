// Handlers for the authentication endpoints.
// A handler validates its input, calls the service, and writes the reply — nothing else.

import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { sendSuccess } from "../../shared/response";
import { ValidationError } from "../../shared/errors";
import { getUserProfile, loginUser, logoutUser } from "./auth.service";

const loginBodySchema = z.object({
  username: z.string().trim().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

/** POST /api/auth/login — exchanges credentials for a JWT. */
export async function postLogin(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const parsedBody = loginBodySchema.safeParse(request.body);
  if (!parsedBody.success) {
    throw new ValidationError(parsedBody.error.issues[0]?.message ?? "Invalid login request");
  }

  const { token, user } = await loginUser(
    parsedBody.data.username,
    parsedBody.data.password,
    request.ip
  );

  return sendSuccess(reply, { token, user });
}

/** POST /api/auth/logout — revokes the token used for this request. */
export async function postLogout(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  // `authenticate` runs first, so these values are guaranteed to be present.
  const authenticatedUser = request.user;
  if (authenticatedUser === undefined) {
    throw new ValidationError("Authentication required");
  }

  await logoutUser(authenticatedUser.jti, authenticatedUser.id, authenticatedUser.tokenExpiresAt);

  return sendSuccess(reply, { success: true });
}

/** GET /api/auth/me — returns the profile of the currently authenticated user. */
export async function getCurrentUser(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const authenticatedUser = request.user;
  if (authenticatedUser === undefined) {
    throw new ValidationError("Authentication required");
  }

  const profile = await getUserProfile(authenticatedUser.id);
  return sendSuccess(reply, profile);
}
