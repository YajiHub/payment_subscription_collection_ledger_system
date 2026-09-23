// Route table for the subscriber module.
// Only paths, preHandlers, and their handlers live here.
//
// Authorization is enforced here, on the server. A hidden button in the UI is a
// convenience, never a control.

import type { FastifyInstance } from "fastify";

import { authenticate } from "../../shared/middleware/authenticate";
import { authorize } from "../../shared/middleware/authorize";
import {
  getSubscriber,
  getSubscriberSearch,
  getSubscriberStatementOfAccount,
  getSubscribers,
  postSubscriber,
  putSubscriber,
} from "./subscribers.handler";

export async function registerSubscriberRoutes(server: FastifyInstance): Promise<void> {
  const read = { preHandler: [authenticate, authorize("subscribers:read")] };
  const create = { preHandler: [authenticate, authorize("subscribers:create")] };
  const update = { preHandler: [authenticate, authorize("subscribers:update")] };

  server.get("/api/subscribers", read, getSubscribers);

  // Registered before "/api/subscribers/:id" would not matter — Fastify prefers a
  // static segment over a parameter — but the order is kept readable on purpose.
  server.get("/api/subscribers/search", read, getSubscriberSearch);

  server.get("/api/subscribers/:id", read, getSubscriber);
  server.get("/api/subscribers/:id/statement", read, getSubscriberStatementOfAccount);

  server.post("/api/subscribers", create, postSubscriber);
  server.put("/api/subscribers/:id", update, putSubscriber);
}
