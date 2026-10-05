// Route table for the health module.
// Only paths and their handlers live here.

import type { FastifyInstance } from "fastify";

import { getDatabaseHealth, getServiceHealth } from "./health.handler";

export async function registerHealthRoutes(server: FastifyInstance): Promise<void> {
  // The liveness probes are exempt from the general rate limit. They are not
  // user work: the desktop client polls them on a timer, so charging them to the
  // same per-IP budget spent a quarter of it on asking whether the server was up,
  // and a busy screen would then exhaust the budget and stall its own data.
  // Nothing here is expensive or sensitive enough to need throttling.
  const withoutRateLimit = { config: { rateLimit: false } } as const;

  server.get("/health", withoutRateLimit, getServiceHealth);
  server.get("/health/db", withoutRateLimit, getDatabaseHealth);
}