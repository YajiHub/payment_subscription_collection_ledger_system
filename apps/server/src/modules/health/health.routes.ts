// Route table for the health module.
// Only paths and their handlers live here.

import type { FastifyInstance } from "fastify";

import { getDatabaseHealth, getServiceHealth } from "./health.handler";

export async function registerHealthRoutes(server: FastifyInstance): Promise<void> {
  server.get("/health", getServiceHealth);
  server.get("/health/db", getDatabaseHealth);
}