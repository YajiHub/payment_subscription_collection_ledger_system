// Acceptance tests for subscription plan management.
//
// Plans are versioned: the monthly rate is immutable, so a price change creates a
// new plan instead of rewriting an existing one. These tests pin that rule down.

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
import { fakeDatabase } from "./support/fake-database";
import { authorizationHeader, signTestToken } from "./support/tokens";

const ADMIN_ID = randomUUID();
const PLAN_ID = randomUUID();

function planRow(overrides: Record<string, unknown> = {}) {
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
    createdBy: ADMIN_ID,
    ...overrides,
  };
}

const newPlanPayload = {
  name: "Fiber 50Mbps",
  serviceType: "internet",
  speedMbps: 50,
  monthlyRateCentavos: 149900,
  reconnectionFeeCentavos: 50000,
};

describe("plan routes", () => {
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

  it("lets a Billing Clerk list plans", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([planRow()]); // plans

    const response = await server.inject({
      method: "GET",
      url: "/api/plans",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.items).toHaveLength(1);
    expect(response.json().data.items[0].monthlyRateCentavos).toBe(99900);
  });

  it("lets an Admin create a plan and stores the rate as integer centavos", async () => {
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([]); // duplicate name check
    fakeDatabase.queueInsertRows([planRow({ name: "Fiber 50Mbps", monthlyRateCentavos: 149900 })]);

    const response = await server.inject({
      method: "POST",
      url: "/api/plans",
      headers: authorizationHeader(token),
      payload: newPlanPayload,
    });

    expect(response.statusCode).toBe(201);
    const inserted = fakeDatabase.insertedRows[0]?.values as Record<string, unknown>;
    expect(inserted.monthlyRateCentavos).toBe(149900);
    expect(Number.isInteger(inserted.monthlyRateCentavos)).toBe(true);
    expect(inserted.createdBy).toBe(ADMIN_ID);
  });

  it("refuses a plan creation from a Billing Clerk, who may only read plans", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: ADMIN_ID });
    fakeDatabase.queueSelectRows([]); // authenticate only; authorize rejects the request

    const response = await server.inject({
      method: "POST",
      url: "/api/plans",
      headers: authorizationHeader(token),
      payload: newPlanPayload,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
    expect(fakeDatabase.insertedRows).toHaveLength(0);
  });

  it("refuses a plan listing from a Cashier, who has no plan permission", async () => {
    const { token } = signTestToken({ role: "cashier", sub: ADMIN_ID });
    fakeDatabase.queueSelectRows([]); // authenticate only

    const response = await server.inject({
      method: "GET",
      url: "/api/plans",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(403);
  });

  it("retires a plan so it takes no new signups", async () => {
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueUpdateRows([planRow({ isActive: false })]);

    const response = await server.inject({
      method: "PUT",
      url: `/api/plans/${PLAN_ID}/retire`,
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.isActive).toBe(false);
    expect(fakeDatabase.updatedRows[0]?.values).toMatchObject({ isActive: false });
  });

  it("refuses to change a plan's monthly rate through the update endpoint", async () => {
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID });
    fakeDatabase.queueSelectRows([]); // authenticate only; validation rejects the body

    const response = await server.inject({
      method: "PUT",
      url: `/api/plans/${PLAN_ID}`,
      headers: authorizationHeader(token),
      payload: { monthlyRateCentavos: 1 },
    });

    // The unknown key is stripped by the schema, leaving no updatable field at all.
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
    expect(fakeDatabase.updatedRows).toHaveLength(0);
  });
});
