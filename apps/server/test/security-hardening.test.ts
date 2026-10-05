// Phase 9 security hardening: real attacks against the running Fastify app.
//
// Every test here performs an attack and asserts the observed defence. The
// database is mocked, so no PostgreSQL is required; the middleware, validation,
// and handlers are the real ones.
//
// Covered:
//   • JWT — expired, forged signature, wrong secret, and revoked tokens
//   • privilege escalation — a non-administrator trying to change a role
//   • mass assignment — a client-supplied role or isActive must not be trusted
//   • secrets — no password or hash may appear in a response
//   • rate limiting, security headers, CORS, and the JSON body limit

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import Fastify, { type FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db/connection", async () => {
  const { fakeDatabase } = await import("./support/fake-database");
  return {
    db: fakeDatabase.db,
    pool: {},
    checkDatabaseConnection: async () => ({ isReachable: true, latencyMs: 0, errorMessage: null }),
    closeDatabaseConnection: async () => {},
  };
});

import { config } from "../src/config";
import { buildServer } from "../src/index.ts";
import { users } from "../src/db/schema/users";
import { subscribers } from "../src/db/schema/subscribers";
import { registerHealthRoutes } from "../src/modules/health/health.routes";
import { securityPlugin } from "../src/shared/plugins/security.plugin";
import { fakeDatabase } from "./support/fake-database";
import { authorizationHeader, signTestToken } from "./support/tokens";

const servers: FastifyInstance[] = [];

async function createServer(): Promise<FastifyInstance> {
  const server = buildServer();
  await server.ready();
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

beforeEach(() => {
  fakeDatabase.reset();
});

describe("JWT handling", () => {
  it("rejects an expired token with 401", async () => {
    const server = await createServer();
    const { token } = signTestToken({ expiresIn: "-10s" });

    const response = await server.inject({
      method: "GET",
      url: "/api/subscribers",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects a token whose signature was tampered with", async () => {
    const server = await createServer();
    const { token } = signTestToken({ role: "admin" });

    // Flip the last character of the signature segment.
    const [header, payload, signature] = token.split(".");
    const flipped = signature.endsWith("A") ? "B" : "A";
    const tamperedToken = `${header}.${payload}.${signature.slice(0, -1)}${flipped}`;

    const response = await server.inject({
      method: "GET",
      url: "/api/users",
      headers: authorizationHeader(tamperedToken),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });

  it("rejects a token signed with the wrong secret", async () => {
    const server = await createServer();
    const forgedToken = jwt.sign(
      { sub: randomUUID(), role: "admin", jti: randomUUID() },
      "an-attackers-secret-that-is-long-enough-but-wrong",
      { expiresIn: "8h" }
    );

    const response = await server.inject({
      method: "GET",
      url: "/api/users",
      headers: authorizationHeader(forgedToken),
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects a token whose payload was rewritten without re-signing", async () => {
    const server = await createServer();
    const { token } = signTestToken({ role: "collector" });

    const [header, , signature] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: randomUUID(), role: "admin", jti: randomUUID(), iat: 0, exp: 9999999999 })
    ).toString("base64url");

    const response = await server.inject({
      method: "GET",
      url: "/api/users",
      headers: authorizationHeader(`${header}.${forgedPayload}.${signature}`),
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects a revoked token even though its signature is valid", async () => {
    const server = await createServer();
    const { token, jti } = signTestToken({ role: "admin" });

    fakeDatabase.queueSelectRows([{ jti }]); // the revocation lookup finds the jti

    const response = await server.inject({
      method: "GET",
      url: "/api/users",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.message).toContain("revoked");
  });
});

describe("GCash screenshot upload hardening", () => {
  it("rejects a file whose bytes are not the image it claims to be", async () => {
    const server = await createServer();
    const { token } = signTestToken({ role: "admin" });
    fakeDatabase.queueSelectRows([]); // authenticate

    // A Windows executable renamed to .png: the declared type is accepted, the
    // magic bytes are not.
    const fakePng = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64)]).toString("base64");

    const response = await server.inject({
      method: "POST",
      url: "/api/payments/gcash/upload-screenshot",
      headers: authorizationHeader(token),
      payload: { fileName: "proof.png", contentType: "image/png", dataBase64: fakePng },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });
});

describe("privilege escalation", () => {
  it("denies a Cashier changing any user's role to administrator", async () => {
    const server = await createServer();
    const { token } = signTestToken({ role: "cashier" });
    fakeDatabase.queueSelectRows([]); // authenticate

    const response = await server.inject({
      method: "PUT",
      url: `/api/users/${randomUUID()}`,
      headers: authorizationHeader(token),
      payload: { role: "admin" },
    });

    expect(response.statusCode).toBe(403);
    expect(fakeDatabase.updatedRows).toHaveLength(0);
  });

  it("denies a Manager deactivating a user account", async () => {
    const server = await createServer();
    const { token } = signTestToken({ role: "manager" });
    fakeDatabase.queueSelectRows([]);

    const response = await server.inject({
      method: "PUT",
      url: `/api/users/${randomUUID()}/deactivate`,
      headers: authorizationHeader(token),
      payload: { isActive: false },
    });

    expect(response.statusCode).toBe(403);
    expect(fakeDatabase.updatedRows).toHaveLength(0);
  });

  it("denies a Collector exporting the receivables report", async () => {
    const server = await createServer();
    const { token } = signTestToken({ role: "collector" });
    fakeDatabase.queueSelectRows([]);

    const response = await server.inject({
      method: "POST",
      url: "/api/reports/export-xlsx",
      headers: authorizationHeader(token),
      payload: { reportType: "ar_aging", params: {} },
    });

    expect(response.statusCode).toBe(403);
  });

  it("denies a Billing Clerk posting a payment", async () => {
    const server = await createServer();
    const { token } = signTestToken({ role: "billing_clerk" });
    fakeDatabase.queueSelectRows([]);

    const response = await server.inject({
      method: "POST",
      url: "/api/payments",
      headers: authorizationHeader(token),
      payload: {
        serviceAccountId: randomUUID(),
        paymentMethod: "cash",
        amountCentavos: 10000,
        paymentDate: "2025-01-15",
      },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe("mass assignment", () => {
  it("ignores a client-supplied isActive and passwordHash on a user update", async () => {
    const server = await createServer();
    const { token } = signTestToken({ role: "admin" });
    const userId = randomUUID();

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      { id: userId, username: "target", role: "cashier", isActive: true, fullName: "Target" },
    ]); // previous role read
    fakeDatabase.queueUpdateRows([{ id: userId, username: "target", role: "admin", isActive: true }]);

    const response = await server.inject({
      method: "PUT",
      url: `/api/users/${userId}`,
      headers: authorizationHeader(token),
      payload: {
        fullName: "Renamed",
        role: "admin",
        // Neither of these is in the schema; both must be dropped.
        isActive: false,
        passwordHash: "$2b$12$attacker-controlled",
        createdBy: randomUUID(),
      },
    });

    expect(response.statusCode).toBe(200);

    const update = fakeDatabase.updatedRows.find((row) => row.table === users);
    const setValues = update?.values as Record<string, unknown>;
    expect(setValues).toHaveProperty("fullName", "Renamed");
    expect(setValues).not.toHaveProperty("isActive");
    expect(setValues).not.toHaveProperty("passwordHash");
    expect(setValues).not.toHaveProperty("createdBy");
  });

  it("ignores a client-supplied status on a subscriber update", async () => {
    const server = await createServer();
    const { token } = signTestToken({ role: "billing_clerk" });
    const subscriberId = randomUUID();

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueUpdateRows([{ id: subscriberId, accountNumber: "SUB-20250101-00001" }]);
    fakeDatabase.queueSelectRows([]); // service accounts for the updated subscriber

    const response = await server.inject({
      method: "PUT",
      url: `/api/subscribers/${subscriberId}`,
      headers: authorizationHeader(token),
      payload: { firstName: "Renamed", accountNumber: "SUB-HACKED-00001" },
    });

    expect(response.statusCode).toBe(200);

    const update = fakeDatabase.updatedRows.find((row) => row.table === subscribers);
    const setValues = update?.values as Record<string, unknown>;
    expect(setValues).toHaveProperty("firstName", "Renamed");
    expect(setValues).not.toHaveProperty("accountNumber");
  });
});

describe("secrets never reach a response", () => {
  it("does not return a password or hash from POST /api/users", async () => {
    const server = await createServer();
    const { token } = signTestToken({ role: "admin" });
    const plainPassword = "super-secret-password-123";

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([]); // username uniqueness check
    fakeDatabase.queueInsertRows([
      {
        id: randomUUID(),
        fullName: "New User",
        username: "new.user",
        role: "cashier",
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
        fullName: "New User",
        username: "new.user",
        password: plainPassword,
        role: "cashier",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.body).not.toContain(plainPassword);
    expect(response.body).not.toContain("passwordHash");
    expect(response.body.toLowerCase()).not.toContain("password");
  });

  it("does not return a hash from the login response", async () => {
    const server = await createServer();
    const bcrypt = await import("bcrypt");
    const plainPassword = "correct-horse-battery";
    const user = {
      id: randomUUID(),
      fullName: "Ana",
      username: "ana",
      passwordHash: await bcrypt.hash(plainPassword, 4),
      role: "admin",
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: null,
    };

    fakeDatabase.queueSelectRows([user]);

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ana", password: plainPassword },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(user.passwordHash);
    expect(response.body).not.toContain(plainPassword);
    expect(response.body).not.toContain("passwordHash");
  });

  it("uses a bcrypt cost factor of at least 12 in production configuration", async () => {
    const configSource = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
    const envExample = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");

    expect(configSource).toMatch(/BCRYPT_ROUNDS:\s*z\.coerce\.number\(\)\.default\(12\)/);
    expect(envExample).toContain("BCRYPT_ROUNDS=12");
  });

  it("keeps .env out of version control", () => {
    const gitignore = readFileSync(new URL("../../../.gitignore", import.meta.url), "utf8");
    expect(gitignore).toMatch(/^\.env$/m);
    expect(gitignore).toContain("!.env.example");
  });
});

describe("rate limiting and transport hardening", () => {
  it("blocks the eleventh login attempt within the window with 429", async () => {
    const server = await createServer();

    // Each attempt uses a different username so the per-account lockout (S5-5), a
    // separate control, does not interfere with the per-IP limit this test proves.
    for (let attempt = 1; attempt <= 10; attempt++) {
      fakeDatabase.queueSelectRows([]); // no such user
      const response = await server.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: `brute-force-${attempt}`, password: "guess" },
      });
      expect(response.statusCode, `attempt ${attempt}`).toBe(401);
    }

    const blocked = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "brute-force-11", password: "guess" },
    });

    expect(blocked.statusCode).toBe(429);
  });

  it("applies a general per-IP limit configured on the server", async () => {
    const limited = Fastify();
    await securityPlugin(limited, { rateLimitMax: 2 });
    limited.get("/ping", async () => ({ ok: true }));
    await limited.ready();

    const first = await limited.inject({ method: "GET", url: "/ping" });
    const second = await limited.inject({ method: "GET", url: "/ping" });
    const third = await limited.inject({ method: "GET", url: "/ping" });

    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(third.statusCode).toBe(429);

    await limited.close();
  });

  it("exempts the liveness probes from the general limit", async () => {
    // The desktop client polls these on a timer. Charging them to the same per-IP
    // budget spent a quarter of it on asking whether the server was up, so a busy
    // screen could exhaust the budget and stall its own data behind a 429.
    const limited = Fastify();
    await securityPlugin(limited, { rateLimitMax: 1 });
    await registerHealthRoutes(limited);
    limited.get("/ping", async () => ({ ok: true }));
    await limited.ready();

    // The control route is limited, so the ceiling really is one request...
    const control = await limited.inject({ method: "GET", url: "/ping" });
    expect(control.statusCode).toBe(200);
    const controlBlocked = await limited.inject({ method: "GET", url: "/ping" });
    expect(controlBlocked.statusCode).toBe(429);

    // ...while the probes answer however many times they are asked.
    for (let poll = 1; poll <= 5; poll++) {
      const response = await limited.inject({ method: "GET", url: "/health" });
      expect(response.statusCode, `poll ${poll}`).toBe(200);
    }
    const databaseProbe = await limited.inject({ method: "GET", url: "/health/db" });
    expect(databaseProbe.statusCode).toBe(200);

    await limited.close();
  });

  it("sets a strict content security policy header", async () => {
    const server = await createServer();
    const response = await server.inject({ method: "GET", url: "/health" });

    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(response.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("rejects a request body larger than 1 MB with 413", async () => {
    const server = await createServer();
    const oversizedPassword = "x".repeat(1_100_000);

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ana", password: oversizedPassword },
    });

    expect(response.statusCode).toBe(413);
  });

  it("does not echo a foreign origin back to the caller", async () => {
    const server = await createServer();
    const response = await server.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://evil.example" },
    });

    // A string `origin` always sends the configured value, so the browser rejects
    // the mismatched origin; what must never happen is echoing the attacker's.
    expect(response.headers["access-control-allow-origin"]).not.toBe("http://evil.example");
  });

  it("allows the configured desktop client origin", async () => {
    const server = await createServer();
    const response = await server.inject({
      method: "GET",
      url: "/health",
      headers: { origin: config.CORS_ORIGIN },
    });

    expect(response.headers["access-control-allow-origin"]).toBe(config.CORS_ORIGIN);
  });
});
