// Handlers for the user management endpoints (Admin only).
// Each handler validates input, calls users.service, and writes the reply.

import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { USER_ROLES } from "@bcis/shared";
import { ValidationError } from "../../shared/errors";
import { sendSuccess } from "../../shared/response";
import {
  changeUserPassword,
  createUser,
  getUserById,
  listUsers,
  setUserActiveState,
  updateUser,
} from "./users.service";

const userIdParamsSchema = z.object({ id: z.string().uuid("A valid user id is required") });

const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const createUserBodySchema = z.object({
  fullName: z.string().trim().min(1, "Full name is required").max(100),
  username: z
    .string()
    .trim()
    .min(3, "Username must be at least 3 characters")
    .max(50)
    .regex(
      /^[a-zA-Z0-9._-]+$/,
      "Username may only contain letters, numbers, dots, dashes, underscores"
    ),
  password: z.string().min(8, "Password must be at least 8 characters"),
  role: z.enum(USER_ROLES),
});

const updateUserBodySchema = z
  .object({
    fullName: z.string().trim().min(1).max(100).optional(),
    role: z.enum(USER_ROLES).optional(),
  })
  .refine((value) => value.fullName !== undefined || value.role !== undefined, {
    message: "Provide at least one of fullName or role",
  });

const changePasswordBodySchema = z.object({
  password: z.string().min(8, "Password must be at least 8 characters"),
});

const setActiveBodySchema = z.object({
  isActive: z.boolean(),
});

/** Parses `data` with `schema` or throws a ValidationError carrying the first problem. */
function parseOrThrow<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  data: unknown
): z.infer<TSchema> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(result.error.issues[0]?.message ?? "Invalid request");
  }
  return result.data;
}

/** GET /api/users — paginated list of every user. */
export async function getUsers(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const query = parseOrThrow(listUsersQuerySchema, request.query);
  const result = await listUsers(query.page, query.pageSize);
  return sendSuccess(reply, result);
}

/** POST /api/users — creates a user account. */
export async function postUser(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const body = parseOrThrow(createUserBodySchema, request.body);
  const createdBy = request.user?.id ?? "";
  const created = await createUser({ ...body, createdBy });
  return sendSuccess(reply, created, 201);
}

/** GET /api/users/:id — a single user. */
export async function getUser(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const { id } = parseOrThrow(userIdParamsSchema, request.params);
  const user = await getUserById(id);
  return sendSuccess(reply, user);
}

/** PUT /api/users/:id — updates display name and/or role. */
export async function putUser(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const { id } = parseOrThrow(userIdParamsSchema, request.params);
  const body = parseOrThrow(updateUserBodySchema, request.body);
  const updated = await updateUser(id, body);
  return sendSuccess(reply, updated);
}

/** PUT /api/users/:id/password — admin-initiated password reset. */
export async function putUserPassword(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(userIdParamsSchema, request.params);
  const body = parseOrThrow(changePasswordBodySchema, request.body);
  const updated = await changeUserPassword(id, body.password);
  return sendSuccess(reply, updated);
}

/** PUT /api/users/:id/deactivate — toggles the account's active flag. */
export async function putUserActiveState(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(userIdParamsSchema, request.params);
  const body = parseOrThrow(setActiveBodySchema, request.body);
  const updated = await setUserActiveState(id, body.isActive);
  return sendSuccess(reply, updated);
}
