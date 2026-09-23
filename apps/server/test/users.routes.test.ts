// Acceptance tests for user management (Admin only) and a representative
// cross-domain check that a Cashier cannot reach a billing endpoint.

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
import { authenticate } from "../src/shared/middleware/authenticate";
import { authorize } from "../src/shared/middleware/authorize";
import { fakeDatabase } from "./support/fake-database";
import { authorizationHeader, signTestToken, UUID_PATTERN } from "./support/tokens";

describe("user management routes", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = buildServer();
    // A stand-in for the Phase 4 billing route, guarded exactly as it will be,
    // to prove authorization is enforced on the server, not just in the UI.
    server.post(
      "/api/invoices/generate",
      { preHandler: [authenticate, authorize("invoices:generate")] },
      async () => ({ generated: true })
    );
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    fakeDatabase.reset();
  });

  it("allows an Admin to create a user and stores a bcrypt hash, never the plaintext", async () => {
    const { token } = signTestToken({ role: "admin" });
    const newUserId = randomUUID();

    fakeDatabase.queueSelectRows([]); // authenticate: token revocation lookup
    fakeDatabase.queueSelectRows([]); // createUser: username uniqueness check
    fakeDatabase.queueInsertRows([
      {
        id: newUserId,
        fullName: "New Clerk",
        username: "new.clerk",
        role: "billing_clerk",
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const response = await server.inject({
      method: "POST",
      url: "/api/users",
      headers: authorizationHeader(token),
      payload: {
        fullName: "New Clerk",
        username: "new.clerk",
        password: "plain-password",
        role: "billing_clerk",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({ id: newUserId, username: "new.clerk" });

    const inserted = fakeDatabase.insertedRows[0]?.values as Record<string, unknown>;
    expect(typeof inserted.passwordHash).toBe("string");
    expect(inserted.passwordHash).not.toBe("plain-password");
    expect(inserted.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(await bcrypt.compare("plain-password", inserted.passwordHash as string)).toBe(true);
  });

  it("returns 403 when a non-admin tries to create a user", async () => {
    const { token } = signTestToken({ role: "cashier" });
    fakeDatabase.queueSelectRows([]); // authenticate only; authorize stops the handler

    const response = await server.inject({
      method: "POST",
      url: "/api/users",
      headers: authorizationHeader(token),
      payload: {
        fullName: "Should Not Exist",
        username: "should.not.exist",
        password: "plain-password",
        role: "admin",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
    expect(fakeDatabase.insertedRows).toHaveLength(0);
  });

  it("returns 403 when a Cashier calls POST /api/invoices/generate", async () => {
    const { token } = signTestToken({ role: "cashier" });
    fakeDatabase.queueSelectRows([]); // authenticate

    const response = await server.inject({
      method: "POST",
      url: "/api/invoices/generate",
      headers: authorizationHeader(token),
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
  });

  it("allows an Admin to list users (paginated)", async () => {
    const { token } = signTestToken({ role: "admin" });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      {
        id: randomUUID(),
        fullName: "A",
        username: "a",
        role: "manager",
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]); // list items
    fakeDatabase.queueSelectRows([{ value: 1 }]); // total count

    const response = await server.inject({
      method: "GET",
      url: "/api/users?page=1&pageSize=20",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json().data;
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.page).toBe(1);
  });

  it("allows an Admin to edit a user", async () => {
    const { token } = signTestToken({ role: "admin" });
    const userId = randomUUID();

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueUpdateRows([
      {
        id: userId,
        fullName: "Renamed User",
        username: "user.x",
        role: "cashier",
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const response = await server.inject({
      method: "PUT",
      url: `/api/users/${userId}`,
      headers: authorizationHeader(token),
      payload: { fullName: "Renamed User" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.fullName).toBe("Renamed User");
    expect(fakeDatabase.updatedRows[0]?.values).toMatchObject({ fullName: "Renamed User" });
  });

  it("allows an Admin to deactivate a user (soft-disable, never delete)", async () => {
    const { token } = signTestToken({ role: "admin" });
    const userId = randomUUID();

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueUpdateRows([
      {
        id: userId,
        fullName: "Old User",
        username: "old.user",
        role: "collector",
        isActive: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const response = await server.inject({
      method: "PUT",
      url: `/api/users/${userId}/deactivate`,
      headers: authorizationHeader(token),
      payload: { isActive: false },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.isActive).toBe(false);
    expect(fakeDatabase.updatedRows[0]?.values).toMatchObject({ isActive: false });
  });

  it("allows an Admin to reset another user's password", async () => {
    const { token } = signTestToken({ role: "admin" });
    const userId = randomUUID();

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueUpdateRows([
      {
        id: userId,
        fullName: "User",
        username: "user",
        role: "cashier",
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const response = await server.inject({
      method: "PUT",
      url: `/api/users/${userId}/password`,
      headers: authorizationHeader(token),
      payload: { password: "brand-new-password" },
    });

    expect(response.statusCode).toBe(200);
    const setValues = fakeDatabase.updatedRows[0]?.values as Record<string, unknown>;
    expect(setValues.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(await bcrypt.compare("brand-new-password", setValues.passwordHash as string)).toBe(true);
  });

  it("rejects a malformed user id with a validation error", async () => {
    const { token } = signTestToken({ role: "admin" });
    fakeDatabase.queueSelectRows([]); // authenticate

    const response = await server.inject({
      method: "GET",
      url: "/api/users/not-a-uuid",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
    expect(UUID_PATTERN.test("not-a-uuid")).toBe(false);
  });
});
