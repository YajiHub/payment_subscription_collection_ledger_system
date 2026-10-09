// The activation move: a pending account has no way into service without it.
//
// A brand-new account created with no activation date is "pending" and is never
// billed. Before this route existed the account was a dead end — suspend refused
// it ("no service to suspend") and reconnect required "suspended" — so these
// tests pin the ONLY legal move out of pending, its audit trail, and the
// refusals that keep a terminated account final.

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
import { auditLogs } from "../src/db/schema/audit";
import { serviceStatusHistory } from "../src/db/schema/subscribers";
import { fakeDatabase } from "./support/fake-database";
import { authorizationHeader, signTestToken } from "./support/tokens";

const CLERK_ID = randomUUID();
const SERVICE_ACCOUNT_ID = randomUUID();
const SUBSCRIBER_ID = randomUUID();
const PLAN_ID = randomUUID();

function accountRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SERVICE_ACCOUNT_ID,
    serviceAccountNumber: "SA-20250124-00042",
    subscriberId: SUBSCRIBER_ID,
    planId: PLAN_ID,
    status: "pending",
    activationDate: null,
    suspensionDate: null,
    terminationDate: null,
    assignedCollectorId: null,
    consecutiveOverdueMonths: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function planRow() {
  return {
    id: PLAN_ID,
    name: "Fiber 25Mbps",
    serviceType: "internet",
    speedMbps: 25,
    cablePackageDescription: null,
    monthlyRateCentavos: 99900,
    reconnectionFeeCentavos: 50000,
    isActive: true,
    createdAt: new Date(),
    createdBy: CLERK_ID,
  };
}

function insertedInto(table: unknown): Array<Record<string, unknown>> {
  return fakeDatabase.insertedRows
    .filter((row) => row.table === table)
    .map((row) => row.values as Record<string, unknown>);
}

describe("service account activation", () => {
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

  it("activates a pending account and writes the status-history row and the audit entry", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: CLERK_ID });

    fakeDatabase.queueSelectRows([]); // authenticate: token revocation lookup
    fakeDatabase.queueSelectRows([{ account: accountRow(), plan: planRow() }]); // locked account
    fakeDatabase.queueUpdateRows([accountRow({ status: "active", activationDate: "2025-02-01" })]);
    fakeDatabase.queueSelectRows([{ balanceCentavos: 0 }]); // ledger balance

    const response = await server.inject({
      method: "PUT",
      url: `/api/service-accounts/${SERVICE_ACCOUNT_ID}/activate`,
      headers: authorizationHeader(token),
      payload: { activationDate: "2025-02-01" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      id: SERVICE_ACCOUNT_ID,
      status: "active",
      activationDate: "2025-02-01",
    });

    // The transition is recorded on the single documented door for the trail.
    const history = insertedInto(serviceStatusHistory);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      serviceAccountId: SERVICE_ACCOUNT_ID,
      previousStatus: "pending",
      newStatus: "active",
      changedBy: CLERK_ID,
    });

    // And the audit trail names the actor and the action.
    const audits = insertedInto(auditLogs);
    expect(audits.find((row) => row.action === "service_account.activated")).toMatchObject({
      entityType: "service_account",
      entityId: SERVICE_ACCOUNT_ID,
      performedBy: CLERK_ID,
    });
  });

  it("defaults the activation date to today when none is supplied", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: CLERK_ID });
    const today = new Date().toISOString().slice(0, 10);

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([{ account: accountRow(), plan: planRow() }]);
    fakeDatabase.queueUpdateRows([accountRow({ status: "active", activationDate: today })]);
    fakeDatabase.queueSelectRows([{ balanceCentavos: 0 }]);

    const response = await server.inject({
      method: "PUT",
      url: `/api/service-accounts/${SERVICE_ACCOUNT_ID}/activate`,
      headers: authorizationHeader(token),
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.activationDate).toBe(today);
  });

  it("refuses to activate an already-active account with the specific message", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: CLERK_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      { account: accountRow({ status: "active", activationDate: "2025-01-01" }), plan: planRow() },
    ]);

    const response = await server.inject({
      method: "PUT",
      url: `/api/service-accounts/${SERVICE_ACCOUNT_ID}/activate`,
      headers: authorizationHeader(token),
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONFLICT");
    expect(response.json().error.message).toBe("This service account is already active");
  });

  it("refuses to activate a suspended account with the specific message", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: CLERK_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      {
        account: accountRow({ status: "suspended", activationDate: "2025-01-01", suspensionDate: "2025-02-01" }),
        plan: planRow(),
      },
    ]);

    const response = await server.inject({
      method: "PUT",
      url: `/api/service-accounts/${SERVICE_ACCOUNT_ID}/activate`,
      headers: authorizationHeader(token),
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toBe(
      "A suspended service account cannot be activated; reconnect it instead"
    );
  });

  it("refuses to activate a terminated account with the specific message", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: CLERK_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      {
        account: accountRow({ status: "terminated", activationDate: "2025-01-01", terminationDate: "2025-03-01" }),
        plan: planRow(),
      },
    ]);

    const response = await server.inject({
      method: "PUT",
      url: `/api/service-accounts/${SERVICE_ACCOUNT_ID}/activate`,
      headers: authorizationHeader(token),
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toBe("A terminated service account cannot be activated");
  });

  it("denies a Cashier (no suspend permission) with 403", async () => {
    const { token } = signTestToken({ role: "cashier", sub: randomUUID() });

    fakeDatabase.queueSelectRows([]); // authenticate

    const response = await server.inject({
      method: "PUT",
      url: `/api/service-accounts/${SERVICE_ACCOUNT_ID}/activate`,
      headers: authorizationHeader(token),
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
  });
});
