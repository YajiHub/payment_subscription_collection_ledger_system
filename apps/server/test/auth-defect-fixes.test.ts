// Regression tests for the auth / RBAC defects fixed together.
//
//   • a deactivated (or deleted) account's EXISTING token is refused at the token
//     check, not only at a fresh login;
//   • a refusal names the real cause: "no resolved permissions" is not the same as
//     "this role does not have this permission";
//   • the audit-report export follows the resolved grants, so an `audit:read`
//     holder whose grant lives only in the RBAC tables is allowed.
//
// The suite runs the real Fastify application against the in-memory database, so
// no PostgreSQL is required. The grant-less and export cases switch the resolver
// to the database-backed path the way production runs it.

import { randomUUID } from "node:crypto";

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
import { invalidatePermissionCache } from "../src/shared/rbac/permission-resolver";
import { setPermissionSourcePreferenceForTests } from "../src/shared/rbac/permission-source";
import { fakeDatabase } from "./support/fake-database";
import { authorizationHeader, signTestToken } from "./support/tokens";

const AUDITOR_ID = "33333333-3333-3333-3333-333333333333";

describe("auth and RBAC defect fixes", () => {
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
    invalidatePermissionCache();
    setPermissionSourcePreferenceForTests("compiled");
  });

  // DEFECT 1 — a live token must stop working the moment its account is switched off.
  it("refuses a deactivated account's existing token on a protected route", async () => {
    const { token } = signTestToken({ role: "cashier", sub: randomUUID() });
    // The token check is one statement; this is the refusal row it returns for a
    // token that is signed, unexpired, never revoked — but deactivated.
    fakeDatabase.queueSelectRows([
      { jti: null, accountMissing: false, accountInactive: true },
    ]);

    const response = await server.inject({
      method: "GET",
      url: "/api/payments",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain("deactivated");
  });

  it("refuses a token whose account no longer exists", async () => {
    const { token } = signTestToken({ role: "cashier", sub: randomUUID() });
    fakeDatabase.queueSelectRows([
      { jti: null, accountMissing: true, accountInactive: false },
    ]);

    const response = await server.inject({
      method: "GET",
      url: "/api/payments",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.message).toContain("no longer exists");
  });

  it("keeps refusing a revoked token with the revoked message", async () => {
    const { token } = signTestToken({ role: "cashier", sub: randomUUID() });
    fakeDatabase.queueSelectRows([
      { jti: randomUUID(), accountMissing: false, accountInactive: false },
    ]);

    const response = await server.inject({
      method: "GET",
      url: "/api/payments",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.message).toContain("revoked");
  });

  // DEFECT 3 — the refusal must name the real cause.
  it("names 'no permissions assigned' when the caller has no resolved grants", async () => {
    setPermissionSourcePreferenceForTests("auto");
    const { token } = signTestToken({ role: "admin", sub: randomUUID() });

    fakeDatabase.queueSelectRows([]); // authenticate: the token is live and active
    fakeDatabase.queueSelectRows([{ value: "true" }]); // RBAC source switch: database
    fakeDatabase.queueSelectRows([]); // resolved grants: none for this caller

    const response = await server.inject({
      method: "GET",
      url: "/api/users",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(403);
    const message = response.json().error.message as string;
    expect(message).toContain("no permissions assigned");
    expect(message).not.toContain("Your role");
  });

  it("keeps the ordinary role message when the role simply lacks the permission", async () => {
    setPermissionSourcePreferenceForTests("auto");
    const userId = randomUUID();
    const { token } = signTestToken({ role: "cashier", sub: userId });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([{ value: "true" }]); // RBAC source switch
    fakeDatabase.queueSelectRows([{ userId, code: "payments:post" }]); // no users:read

    const response = await server.inject({
      method: "GET",
      url: "/api/users",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toBe(
      "Access denied. Your role (cashier) cannot perform: users:read"
    );
  });

  // DEFECT 4 — the export follows the same authority as every other route guard.
  it("lets an audit:read holder export the audit report", async () => {
    setPermissionSourcePreferenceForTests("auto");
    // A `collector` legacy role, so the compiled matrix would refuse this export.
    // The grants below exist only in the RBAC tables.
    const { token } = signTestToken({ role: "collector", sub: AUDITOR_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([{ value: "true" }]); // RBAC source switch
    fakeDatabase.queueSelectRows([
      { userId: AUDITOR_ID, code: "reports:export" },
      { userId: AUDITOR_ID, code: "audit:read" },
    ]); // the resolved grants
    fakeDatabase.queueSelectRows([]); // the audit report rows

    const response = await server.inject({
      method: "POST",
      url: "/api/reports/export-xlsx",
      headers: authorizationHeader(token),
      payload: { reportType: "audit_log", params: {} },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("spreadsheetml");
  });
});
