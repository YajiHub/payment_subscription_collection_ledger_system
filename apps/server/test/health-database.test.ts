// The database health endpoint must say WHICH database answered, so an operator
// can tell one install from another without psql — and it must never expose the
// credentials in the connection string.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../src/db/connection", async () => {
  const { fakeDatabase } = await import("./support/fake-database");
  return {
    db: fakeDatabase.db,
    pool: {},
    checkDatabaseConnection: async () => ({
      isReachable: true,
      latencyMs: 2,
      errorMessage: null,
    }),
    closeDatabaseConnection: async () => {},
  };
});

import { DATABASE_TARGET } from "../src/config";
import { buildServer } from "../src/index.ts";

describe("GET /health/db", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it("reports the connected database name from DATABASE_URL", async () => {
    const response = await server.inject({ method: "GET", url: "/health/db" });

    expect(response.statusCode).toBe(200);
    expect(response.json().database_name).toBe(DATABASE_TARGET.name);
  });

  it("never leaks the connection string or its credentials", async () => {
    const response = await server.inject({ method: "GET", url: "/health/db" });
    const body = response.body;

    expect(body).not.toContain("postgresql://");
    expect(body).not.toContain("bcis_user");
    expect(body).not.toContain("change_this");
  });
});
