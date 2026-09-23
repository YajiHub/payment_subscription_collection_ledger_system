// Acceptance tests for the authentication endpoints.
// They run through the real Fastify application and mocked repository layer,
// so no PostgreSQL instance is required.

import { randomUUID } from "node:crypto";

import bcrypt from "bcrypt";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../src/db/connection", async () => {
  const { fakeDatabase } = await import("./support/fake-database");
  return {
    db: fakeDatabase.db,
    pool: {},
    checkDatabaseConnection: async () => ({ isReachable: true, latencyMs: 0, errorMessage: null }),
    closeDatabaseConnection: async () => {},
  };
});

import { buildServer } from "../src/index.ts";
import { fakeDatabase } from "./support/fake-database";
import { authorizationHeader, signTestToken } from "./support/tokens";

const PASSWORD = "correct-horse-battery";

async function buildTestUser(overrides: {
  id?: string;
  username?: string;
  password?: string;
  role?: "admin" | "cashier";
  isActive?: boolean;
}) {
  const id = overrides.id ?? randomUUID();
  const password = overrides.password ?? PASSWORD;
  return {
    id,
    fullName: "Test User",
    username: overrides.username ?? "test.user",
    passwordHash: await bcrypt.hash(password, 4),
    role: overrides.role ?? "admin",
    isActive: overrides.isActive ?? true,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: null,
  };
}

describe("authentication routes", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    fakeDatabase.reset();
  });

  it("POST /api/auth/login with correct credentials returns a JWT", async () => {
    const user = await buildTestUser({ username: "ana", role: "admin" });
    fakeDatabase.queueSelectRows([user]);

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ana", password: PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(typeof body.data.token).toBe("string");
    expect(body.data.token.split(".")).toHaveLength(3);
    expect(body.data.user).toEqual({ id: user.id, fullName: "Test User", role: "admin" });
  });

  it("records a successful login in the audit log", async () => {
    const user = await buildTestUser({ username: "ana" });
    fakeDatabase.queueSelectRows([user]);

    await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ana", password: PASSWORD },
    });

    const auditRow = fakeDatabase.insertedRows[0]?.values as Record<string, unknown>;
    expect(auditRow).toMatchObject({ username: "ana", success: true, userId: user.id });
  });

  it("POST /api/auth/login with a wrong password returns 401 and audits the failure", async () => {
    const user = await buildTestUser({ username: "ana" });
    fakeDatabase.queueSelectRows([user]);

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ana", password: "wrong-password" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");

    const auditRow = fakeDatabase.insertedRows[0]?.values as Record<string, unknown>;
    expect(auditRow).toMatchObject({ username: "ana", success: false });
    expect(auditRow.userId).toBeUndefined();
  });

  it("POST /api/auth/login for an unknown username returns 401 and still audits", async () => {
    fakeDatabase.queueSelectRows([]);

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ghost", password: PASSWORD },
    });

    expect(response.statusCode).toBe(401);
    expect(fakeDatabase.insertedRows[0]?.values).toMatchObject({
      username: "ghost",
      success: false,
    });
  });

  it("POST /api/auth/login for an inactive account returns 403", async () => {
    const user = await buildTestUser({ username: "ana", isActive: false });
    fakeDatabase.queueSelectRows([user]);

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ana", password: PASSWORD },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
    expect(fakeDatabase.insertedRows[0]?.values).toMatchObject({ success: false });
  });

  it("GET /api/auth/me with a valid token returns the current user", async () => {
    const userId = randomUUID();
    const { token } = signTestToken({ sub: userId, role: "cashier" });
    fakeDatabase.queueSelectRows([]); // token revocation lookup
    fakeDatabase.queueSelectRows([
      { id: userId, fullName: "Cashier One", username: "cashier", role: "cashier", isActive: true },
    ]);

    const response = await server.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ id: userId, role: "cashier" });
  });

  it("GET /api/auth/me with an expired token returns 401", async () => {
    const { token } = signTestToken({ expiresIn: "-10s" });

    const response = await server.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(401);
  });

  it("GET /api/auth/me without a token returns 401", async () => {
    const response = await server.inject({ method: "GET", url: "/api/auth/me" });
    expect(response.statusCode).toBe(401);
  });

  it("POST /api/auth/logout revokes the token so the same token is rejected afterwards", async () => {
    const { token, jti } = signTestToken({ role: "admin" });

    fakeDatabase.queueSelectRows([]); // logout: token revocation lookup
    const logoutResponse = await server.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: authorizationHeader(token),
    });

    expect(logoutResponse.statusCode).toBe(200);
    expect(logoutResponse.json().data).toEqual({ success: true });
    expect(fakeDatabase.insertedRows[0]?.values).toMatchObject({ jti });

    // The same token now presents a revoked jti.
    fakeDatabase.queueSelectRows([{ jti }]);
    const meResponse = await server.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: authorizationHeader(token),
    });

    expect(meResponse.statusCode).toBe(401);
  });
});
