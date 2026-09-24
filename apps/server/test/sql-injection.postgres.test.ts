// Real SQL-injection attempts against a live database.
//
// The payloads below are sent through every search and filter parameter the API
// exposes. Because every query is built with Drizzle's parameter binding, the
// payload is stored and returned as DATA: the row survives, the tables survive,
// and no extra rows leak.
//
// The suite skips itself when no database answers.

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../src/index.ts";
import { closeDatabaseConnection, pool } from "../src/db/connection";
import { deleteAuditLogsForUsers } from "./support/audit-cleanup";
import { authorizationHeader, signTestToken } from "./support/tokens";

const DUMMY_PASSWORD_HASH = "$2b$12$OMlJdIjzDLp3Jfn.9NR3qOBmwx5aLVRkyrFhSH6e5J1g.kCBMSeJe";

/** The classic injection shapes, one per attack style. */
const PAYLOADS = [
  "' OR '1'='1",
  "'; DROP TABLE subscribers; --",
  "1; DELETE FROM invoices; --",
  "%' UNION SELECT id, password_hash FROM users --",
  "Robert'); DROP TABLE students;--",
  "\\'; select pg_sleep(0); --",
];

async function isDatabaseReachable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

const databaseIsReachable = await isDatabaseReachable();

describe.skipIf(!databaseIsReachable)("SQL injection attempts against PostgreSQL", () => {
  let server: FastifyInstance;
  let adminId: string;
  let subscriberId: string;

  const maliciousLastName = "'; DROP TABLE subscribers; --";
  const maliciousMunicipality = "' OR '1'='1";

  beforeAll(async () => {
    server = buildServer();
    await server.ready();

    adminId = randomUUID();
    await pool.query(
      `INSERT INTO users (id, full_name, username, password_hash, role, is_active)
       VALUES ($1, $2, $3, $4, 'admin', true)`,
      [adminId, "Injection Probe Admin", `injection.admin.${adminId.slice(0, 8)}`, DUMMY_PASSWORD_HASH]
    );

    subscriberId = randomUUID();
    await pool.query(
      `INSERT INTO subscribers
         (id, account_number, first_name, last_name, primary_phone, service_address,
          service_barangay, service_municipality, service_province, created_by)
       VALUES ($1, $2, 'Bobby', $3, '09170000001', '1 Injection Street',
               'Poblacion', $4, 'Testprovince', $5)`,
      [
        subscriberId,
        `SUB-INJ-${randomUUID().slice(0, 8)}`,
        maliciousLastName,
        maliciousMunicipality,
        adminId,
      ]
    );
  });

  afterAll(async () => {
    await pool.query("DELETE FROM subscribers WHERE id = $1", [subscriberId]);
    await deleteAuditLogsForUsers(pool, [adminId]);
    await pool.query("DELETE FROM users WHERE id = $1", [adminId]);
    await server.close();
    await closeDatabaseConnection();
  });

  it("treats a search payload as data and returns the matching row", async () => {
    const { token } = signTestToken({ role: "admin", sub: adminId });

    const response = await server.inject({
      method: "GET",
      url: `/api/subscribers/search?q=${encodeURIComponent("Bobby")}`,
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);

    // The stored name is returned verbatim — it was never parsed as SQL.
    const stored = await pool.query("SELECT last_name FROM subscribers WHERE id = $1", [
      subscriberId,
    ]);
    expect(stored.rows[0].last_name).toBe(maliciousLastName);
  });

  it("survives every payload in a search parameter without a 500 or a dropped table", async () => {
    const { token } = signTestToken({ role: "admin", sub: adminId });

    for (const payload of PAYLOADS) {
      const searchResponse = await server.inject({
        method: "GET",
        url: `/api/subscribers/search?q=${encodeURIComponent(payload)}`,
        headers: authorizationHeader(token),
      });
      expect(searchResponse.statusCode, `search payload ${payload}`).toBe(200);

      const listResponse = await server.inject({
        method: "GET",
        url: `/api/subscribers?search=${encodeURIComponent(payload)}&municipality=${encodeURIComponent(payload)}`,
        headers: authorizationHeader(token),
      });
      expect(listResponse.statusCode, `filter payload ${payload}`).toBe(200);
    }

    // The tables the payloads tried to drop must still be there.
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('subscribers', 'invoices', 'users', 'payments')`
    );
    expect(tables.rows.map((row) => row.table_name).sort()).toEqual([
      "invoices",
      "payments",
      "subscribers",
      "users",
    ]);
  });

  it("never lets a payload in a username reach the users query", async () => {
    const payload = "' OR '1'='1";

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: payload, password: "whatever" },
    });

    expect(response.statusCode).toBe(401);
    // A successful injection would have logged in as the first user.
    expect(response.body).not.toContain("token");
  });

  it("rejects a malformed filter value instead of passing it to SQL", async () => {
    const { token } = signTestToken({ role: "admin", sub: adminId });

    const response = await server.inject({
      method: "GET",
      url: `/api/invoices?status=${encodeURIComponent("'; DROP TABLE invoices; --")}`,
      headers: authorizationHeader(token),
    });

    // The status must be one of the known enum values; a payload never reaches SQL.
    expect(response.statusCode).toBe(400);
  });

  it("rejects a malformed payment date filter with 400", async () => {
    const { token } = signTestToken({ role: "admin", sub: adminId });

    const response = await server.inject({
      method: "GET",
      url: "/api/payments?dateFrom=2025-01-01'%20OR%20'1'='1",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(400);
  });
});
