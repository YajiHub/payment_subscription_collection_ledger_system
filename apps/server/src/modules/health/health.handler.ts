// Handlers for the health endpoints.
// A handler receives the parsed request and writes the reply — nothing else.

import type { FastifyReply, FastifyRequest } from "fastify";

import { SERVICE_VERSION } from "../../config";
import { checkDatabaseConnection } from "../../db/connection";

/** GET /health — answers whether the API process itself is alive. */
export async function getServiceHealth(
  _request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  return reply.send({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: SERVICE_VERSION,
  });
}

/** GET /health/db — proves PostgreSQL is reachable by running a real query. */
export async function getDatabaseHealth(
  _request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
  const result = await checkDatabaseConnection();

  if (!result.isReachable) {
    return reply.status(503).send({
      status: "error",
      latency_ms: result.latencyMs,
      error: result.errorMessage,
    });
  }

  return reply.send({
    status: "ok",
    latency_ms: result.latencyMs,
  });
}