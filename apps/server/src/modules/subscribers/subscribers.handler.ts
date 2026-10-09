// Handlers for the subscriber endpoints.
// Each handler validates input, calls subscribers.service, and writes the reply.

import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  SERVICE_ACCOUNT_STATUSES,
  createServiceAccountSchema,
  createSubscriberSchema,
  queryNumber,
  updateSubscriberSchema,
} from "@bcis/shared";
import { sendSuccess } from "../../shared/response";
import { parseOrThrow } from "../../shared/validate";
import { audit, requestActor } from "../../shared/audit/audit-logger";
import {
  createSubscriber,
  getSubscriberById,
  getSubscriberStatement,
  listSubscribers,
  searchSubscribers,
  updateSubscriber,
} from "./subscribers.service";

// Query strings arrive as text, so numeric filters are coerced and bounded here.
const listSubscribersQuerySchema = z.object({
  page: queryNumber("page", (schema) => schema.int().min(1)).default(1),
  pageSize: queryNumber("pageSize", (schema) => schema.int().min(1).max(100)).default(20),
  search: z.string().trim().max(200).optional(),
  status: z.enum(SERVICE_ACCOUNT_STATUSES).optional(),
  municipality: z.string().trim().max(100).optional(),
});

const searchSubscribersQuerySchema = z.object({
  q: z.string().trim().min(1, "A search term is required").max(200),
  page: queryNumber("page", (schema) => schema.int().min(1)).default(1),
  pageSize: queryNumber("pageSize", (schema) => schema.int().min(1).max(100)).default(20),
});

const subscriberIdParamsSchema = z.object({
  id: z.string().uuid("A valid subscriber id is required"),
});

// The Add Subscriber screen saves the customer and their first service together.
const createSubscriberBodySchema = createSubscriberSchema.extend({
  serviceAccount: createServiceAccountSchema.optional(),
});

/** GET /api/subscribers — paginated, searchable, filterable list. */
export async function getSubscribers(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const query = parseOrThrow(listSubscribersQuerySchema, request.query);
  const result = await listSubscribers(query);
  return sendSuccess(reply, result);
}

/** GET /api/subscribers/search — search by name, account number, or phone. */
export async function getSubscriberSearch(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const query = parseOrThrow(searchSubscribersQuerySchema, request.query);
  const result = await searchSubscribers(query.q, query.page, query.pageSize);
  return sendSuccess(reply, result);
}

/** GET /api/subscribers/:id — a subscriber with all their service accounts. */
export async function getSubscriber(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(subscriberIdParamsSchema, request.params);
  const subscriber = await getSubscriberById(id);
  return sendSuccess(reply, subscriber);
}

/** POST /api/subscribers — creates a subscriber, optionally with a first service account. */
export async function postSubscriber(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const body = parseOrThrow(createSubscriberBodySchema, request.body);
  const { serviceAccount, ...subscriberFields } = body;
  const createdBy = request.user?.id ?? "";

  const created = await createSubscriber({
    subscriber: subscriberFields,
    serviceAccount,
    createdBy,
  });

  await audit.subscriberCreated({ ...created }, requestActor(request));

  return sendSuccess(reply, created, 201);
}

/** PUT /api/subscribers/:id — updates contact and address details. */
export async function putSubscriber(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(subscriberIdParamsSchema, request.params);
  const body = parseOrThrow(updateSubscriberSchema, request.body);
  const updatedBy = request.user?.id ?? "";

  const updated = await updateSubscriber(id, body, updatedBy);
  await audit.subscriberUpdated({ ...updated }, requestActor(request));
  return sendSuccess(reply, updated);
}

/** GET /api/subscribers/:id/statement — statement of account for all services. */
export async function getSubscriberStatementOfAccount(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const { id } = parseOrThrow(subscriberIdParamsSchema, request.params);
  const statement = await getSubscriberStatement(id);
  return sendSuccess(reply, statement);
}
