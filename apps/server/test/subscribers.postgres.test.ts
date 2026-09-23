// Real-PostgreSQL integration test for Phase 3.
//
// Unlike the other suites, this one talks to a live database: it creates a
// subscriber and a service account through the API, then queries the tables
// directly to prove the rows really landed. That is the "verify database state"
// criterion from the specification.
//
// The suite skips itself when no database answers, so `pnpm test` still passes on
// a machine without PostgreSQL. It runs against DATABASE_URL, which vitest points
// at a dedicated bcis_test database.

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../src/index.ts";
import { closeDatabaseConnection, pool } from "../src/db/connection";
import { authorizationHeader, signTestToken } from "./support/tokens";

/** A valid bcrypt hash. The value is never checked in this test — only its shape. */
const DUMMY_PASSWORD_HASH = "$2b$12$OMlJdIjzDLp3Jfn.9NR3qOBmwx5aLVRkyrFhSH6e5J1g.kCBMSeJe";

async function isDatabaseReachable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

const databaseIsReachable = await isDatabaseReachable();

// Ids created by this suite, so cleanup removes exactly what it added.
const createdIds: {
  userIds: string[];
  planIds: string[];
  subscriberIds: string[];
  serviceAccountIds: string[];
} = { userIds: [], planIds: [], subscriberIds: [], serviceAccountIds: [] };

describe.skipIf(!databaseIsReachable)("Phase 3 against real PostgreSQL", () => {
  let server: FastifyInstance;
  let clerkId: string;
  let internetPlanId: string;
  let cablePlanId: string;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();

    clerkId = randomUUID();
    await pool.query(
      `INSERT INTO users (id, full_name, username, password_hash, role, is_active)
       VALUES ($1, $2, $3, $4, 'billing_clerk', true)`,
      [clerkId, "Integration Clerk", `integration.clerk.${clerkId.slice(0, 8)}`, DUMMY_PASSWORD_HASH]
    );
    createdIds.userIds.push(clerkId);

    internetPlanId = randomUUID();
    cablePlanId = randomUUID();
    await pool.query(
      `INSERT INTO subscription_plans
         (id, name, service_type, speed_mbps, monthly_rate_centavos, reconnection_fee_centavos, is_active, created_by)
       VALUES ($1, $2, 'internet', 25, 99900, 50000, true, $3),
              ($4, $5, 'cable_tv', NULL, 49900, 0, true, $3)`,
      [
        internetPlanId,
        `Integration Fiber ${internetPlanId.slice(0, 8)}`,
        clerkId,
        cablePlanId,
        `Integration Cable ${cablePlanId.slice(0, 8)}`,
      ]
    );
    createdIds.planIds.push(internetPlanId, cablePlanId);
  });

  afterAll(async () => {
    // Remove this suite's rows in foreign-key order. Nothing else is touched.
    await pool.query("DELETE FROM service_status_history WHERE service_account_id = ANY($1::uuid[])", [
      createdIds.serviceAccountIds,
    ]);
    await pool.query("DELETE FROM service_accounts WHERE id = ANY($1::uuid[])", [
      createdIds.serviceAccountIds,
    ]);
    await pool.query("DELETE FROM subscribers WHERE id = ANY($1::uuid[])", [
      createdIds.subscriberIds,
    ]);
    await pool.query("DELETE FROM subscription_plans WHERE id = ANY($1::uuid[])", [createdIds.planIds]);
    await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [createdIds.userIds]);

    await server.close();
    await closeDatabaseConnection();
  });

  it("persists a subscriber and its service accounts, then suspends and reconnects one", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: clerkId });
    const headers = authorizationHeader(token);

    // ── Create the subscriber with its first service account ────────────────
    const createResponse = await server.inject({
      method: "POST",
      url: "/api/subscribers",
      headers,
      payload: {
        firstName: "Rosario",
        lastName: `Integration${randomUUID().slice(0, 8)}`,
        primaryPhone: "09171234567",
        serviceAddress: "1 Integration Road",
        serviceBarangay: "Poblacion",
        serviceMunicipality: "Cabuyao",
        serviceProvince: "Laguna",
        serviceAccount: { planId: internetPlanId, activationDate: "2025-01-24" },
      },
    });

    expect(createResponse.statusCode).toBe(201);
    const createdSubscriber = createResponse.json().data;
    createdIds.subscriberIds.push(createdSubscriber.id);

    // AC: the account number follows SUB-YYYYMMDD-XXXXX.
    expect(createdSubscriber.accountNumber).toMatch(/^SUB-\d{8}-\d{5}$/);
    expect(createdSubscriber.serviceAccounts).toHaveLength(1);

    const firstServiceAccount = createdSubscriber.serviceAccounts[0];
    createdIds.serviceAccountIds.push(firstServiceAccount.id);
    expect(firstServiceAccount.serviceAccountNumber).toMatch(/^SA-\d{8}-\d{5}$/);
    expect(firstServiceAccount.status).toBe("active");

    // ── Add a second service account (Cable TV) ─────────────────────────────
    const addResponse = await server.inject({
      method: "POST",
      url: `/api/subscribers/${createdSubscriber.id}/service-accounts`,
      headers,
      payload: { planId: cablePlanId },
    });

    expect(addResponse.statusCode).toBe(201);
    const cableServiceAccount = addResponse.json().data;
    createdIds.serviceAccountIds.push(cableServiceAccount.id);
    expect(cableServiceAccount.status).toBe("pending");

    // ── Verify the rows directly in PostgreSQL ──────────────────────────────
    const subscriberRows = await pool.query(
      "SELECT account_number, first_name, created_by FROM subscribers WHERE id = $1",
      [createdSubscriber.id]
    );
    expect(subscriberRows.rowCount).toBe(1);
    expect(subscriberRows.rows[0].account_number).toBe(createdSubscriber.accountNumber);
    expect(subscriberRows.rows[0].created_by).toBe(clerkId);

    const accountRows = await pool.query(
      `SELECT service_account_number, plan_id, status, activation_date
         FROM service_accounts WHERE subscriber_id = $1 ORDER BY created_at`,
      [createdSubscriber.id]
    );
    expect(accountRows.rowCount).toBe(2);
    expect(accountRows.rows.map((row) => row.status).sort()).toEqual(["active", "pending"]);

    // ── Search finds the subscriber by name, account number, and phone ──────
    // AC: partial name, account number, or phone number all return the record.
    const searchTerms = [
      "Integration", // partial name
      createdSubscriber.accountNumber, // full account number
      "0917", // partial phone number
    ];

    for (const term of searchTerms) {
      const searchResponse = await server.inject({
        method: "GET",
        url: `/api/subscribers/search?q=${encodeURIComponent(term)}`,
        headers,
      });
      expect(searchResponse.statusCode).toBe(200);
      const foundIds = searchResponse.json().data.items.map((item: { id: string }) => item.id);
      expect(foundIds, `search for "${term}" should find the created subscriber`).toContain(
        createdSubscriber.id
      );
    }

    // ── Suspend the active account ──────────────────────────────────────────
    const suspendResponse = await server.inject({
      method: "PUT",
      url: `/api/service-accounts/${firstServiceAccount.id}/suspend`,
      headers,
      payload: { reason: "Integration test: three months overdue" },
    });
    expect(suspendResponse.statusCode).toBe(200);
    expect(suspendResponse.json().data.status).toBe("suspended");

    // AC: the suspension is recorded in service_status_history.
    const historyRows = await pool.query(
      `SELECT previous_status, new_status, reason, changed_by
         FROM service_status_history WHERE service_account_id = $1`,
      [firstServiceAccount.id]
    );
    expect(historyRows.rowCount).toBe(1);
    expect(historyRows.rows[0]).toMatchObject({
      previous_status: "active",
      new_status: "suspended",
      reason: "Integration test: three months overdue",
      changed_by: clerkId,
    });

    // ── Reconnect it ────────────────────────────────────────────────────────
    const reconnectResponse = await server.inject({
      method: "PUT",
      url: `/api/service-accounts/${firstServiceAccount.id}/reconnect`,
      headers,
      payload: { reason: "Integration test: balance settled" },
    });
    expect(reconnectResponse.statusCode).toBe(200);
    const reconnected = reconnectResponse.json().data;
    expect(reconnected.serviceAccount.status).toBe("active");

    // AC: reconnection produces a reconnection fee entry priced from the plan.
    expect(reconnected.reconnectionFeeEntry.amountCentavos).toBe(50000);

    const afterReconnect = await pool.query(
      "SELECT status, suspension_date FROM service_accounts WHERE id = $1",
      [firstServiceAccount.id]
    );
    expect(afterReconnect.rows[0].status).toBe("active");
    expect(afterReconnect.rows[0].suspension_date).toBeNull();

    const historyAfterReconnect = await pool.query(
      `SELECT previous_status, new_status FROM service_status_history
         WHERE service_account_id = $1 ORDER BY changed_at`,
      [firstServiceAccount.id]
    );
    expect(historyAfterReconnect.rowCount).toBe(2);
    expect(historyAfterReconnect.rows[1]).toMatchObject({
      previous_status: "suspended",
      new_status: "active",
    });
  });
});

// Report honestly when the suite could not run, instead of silently passing.
if (!databaseIsReachable) {
  describe("Phase 3 against real PostgreSQL", () => {
    it.skip("skipped: no PostgreSQL reachable at DATABASE_URL", () => {});
  });
}
