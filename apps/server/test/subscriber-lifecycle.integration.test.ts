// Phase 3 acceptance test: create a subscriber, add a service account, and verify
// the exact database rows the services wrote.
//
// This is the end-to-end flow named in the specification's acceptance criteria.
// It runs through the real Fastify application, middleware, and services, and
// inspects the recorded inserts, so it needs no live database.

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

const CLERK_ID = randomUUID();
const INTERNET_PLAN_ID = randomUUID();
const CABLE_PLAN_ID = randomUUID();
const SUBSCRIBER_ID = randomUUID();

const storedSubscriber = {
  id: SUBSCRIBER_ID,
  accountNumber: "SUB-20250124-00001",
  firstName: "Juan",
  lastName: "Dela Cruz",
  middleName: "Ramos",
  primaryPhone: "09171234567",
  secondaryPhone: null,
  emailAddress: null,
  serviceAddress: "88 Rizal Avenue",
  serviceBarangay: "San Isidro",
  serviceMunicipality: "Santa Rosa",
  serviceProvince: "Laguna",
  internalNotes: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  createdBy: CLERK_ID,
  updatedBy: null,
};

const internetPlan = {
  id: INTERNET_PLAN_ID,
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

const cablePlan = {
  id: CABLE_PLAN_ID,
  name: "Cable Basic",
  serviceType: "cable_tv",
  speedMbps: null,
  cablePackageDescription: "40 channels",
  monthlyRateCentavos: 49900,
  reconnectionFeeCentavos: 0,
  isActive: true,
  createdAt: new Date(),
  createdBy: CLERK_ID,
};

describe("subscriber lifecycle (create → add service → verify persisted state)", () => {
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

  it("creates a subscriber, adds a second service, and persists both correctly", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: CLERK_ID });
    const headers = authorizationHeader(token);

    // ── Step 1: create the subscriber ────────────────────────────────────────
    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([]); // account numbers already issued today
    fakeDatabase.queueInsertRows([storedSubscriber]);

    const createResponse = await server.inject({
      method: "POST",
      url: "/api/subscribers",
      headers,
      payload: {
        firstName: "Juan",
        lastName: "Dela Cruz",
        middleName: "Ramos",
        primaryPhone: "09171234567",
        serviceAddress: "88 Rizal Avenue",
        serviceBarangay: "San Isidro",
        serviceMunicipality: "Santa Rosa",
        serviceProvince: "Laguna",
      },
    });

    expect(createResponse.statusCode).toBe(201);
    const subscriberId: string = createResponse.json().data.id;
    expect(subscriberId).toBe(SUBSCRIBER_ID);

    // ── Step 2: add the Internet service account ─────────────────────────────
    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([{ id: SUBSCRIBER_ID }]); // subscriber exists
    fakeDatabase.queueSelectRows([internetPlan]); // plan is assignable
    fakeDatabase.queueSelectRows([]); // service account numbers today
    fakeDatabase.queueInsertRows([
      {
        id: randomUUID(),
        serviceAccountNumber: "SA-20250124-00001",
        subscriberId: SUBSCRIBER_ID,
        planId: INTERNET_PLAN_ID,
        status: "active",
        activationDate: "2025-01-24",
        suspensionDate: null,
        terminationDate: null,
        assignedCollectorId: null,
        consecutiveOverdueMonths: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const firstAccountResponse = await server.inject({
      method: "POST",
      url: `/api/subscribers/${subscriberId}/service-accounts`,
      headers,
      payload: { planId: INTERNET_PLAN_ID, activationDate: "2025-01-24" },
    });

    expect(firstAccountResponse.statusCode).toBe(201);

    // ── Step 3: add the Cable TV service account ─────────────────────────────
    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([{ id: SUBSCRIBER_ID }]); // subscriber exists
    fakeDatabase.queueSelectRows([cablePlan]); // plan is assignable
    fakeDatabase.queueSelectRows([]); // service account numbers today
    fakeDatabase.queueInsertRows([
      {
        id: randomUUID(),
        serviceAccountNumber: "SA-20250124-00002",
        subscriberId: SUBSCRIBER_ID,
        planId: CABLE_PLAN_ID,
        status: "pending",
        activationDate: null,
        suspensionDate: null,
        terminationDate: null,
        assignedCollectorId: null,
        consecutiveOverdueMonths: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const secondAccountResponse = await server.inject({
      method: "POST",
      url: `/api/subscribers/${subscriberId}/service-accounts`,
      headers,
      payload: { planId: CABLE_PLAN_ID },
    });

    expect(secondAccountResponse.statusCode).toBe(201);

    // ── Verify the persisted state ───────────────────────────────────────────
    const subscriberInsert = fakeDatabase.insertedRows[0]?.values as Record<string, unknown>;
    expect(subscriberInsert.accountNumber).toMatch(/^SUB-\d{8}-\d{5}$/);
    expect(subscriberInsert.createdBy).toBe(CLERK_ID);
    expect(subscriberInsert.firstName).toBe("Juan");

    const accountInserts = fakeDatabase.insertedRows.slice(1);
    expect(accountInserts).toHaveLength(2);

    const internetInsert = accountInserts[0]?.values as Record<string, unknown>;
    const cableInsert = accountInserts[1]?.values as Record<string, unknown>;

    expect(internetInsert.serviceAccountNumber).toMatch(/^SA-\d{8}-\d{5}$/);
    expect(internetInsert.subscriberId).toBe(SUBSCRIBER_ID);
    expect(internetInsert.planId).toBe(INTERNET_PLAN_ID);
    expect(internetInsert.status).toBe("active");
    expect(internetInsert.activationDate).toBe("2025-01-24");
    expect(internetInsert.createdBy).toBe(CLERK_ID);

    expect(cableInsert.subscriberId).toBe(SUBSCRIBER_ID);
    expect(cableInsert.planId).toBe(CABLE_PLAN_ID);
    // A service with no activation date stays pending and is not billed.
    expect(cableInsert.status).toBe("pending");
    expect(cableInsert.activationDate).toBeNull();
  });

  it("reads the persisted subscriber back with both services attached", async () => {
    const { token } = signTestToken({ role: "manager", sub: CLERK_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([storedSubscriber]);
    fakeDatabase.queueSelectRows([
      {
        account: {
          id: randomUUID(),
          serviceAccountNumber: "SA-20250124-00001",
          subscriberId: SUBSCRIBER_ID,
          planId: INTERNET_PLAN_ID,
          status: "active",
          activationDate: "2025-01-24",
          suspensionDate: null,
          terminationDate: null,
          assignedCollectorId: null,
          consecutiveOverdueMonths: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        plan: internetPlan,
      },
      {
        account: {
          id: randomUUID(),
          serviceAccountNumber: "SA-20250124-00002",
          subscriberId: SUBSCRIBER_ID,
          planId: CABLE_PLAN_ID,
          status: "pending",
          activationDate: null,
          suspensionDate: null,
          terminationDate: null,
          assignedCollectorId: null,
          consecutiveOverdueMonths: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        plan: cablePlan,
      },
    ]);

    const response = await server.inject({
      method: "GET",
      url: `/api/subscribers/${SUBSCRIBER_ID}`,
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json().data;
    expect(body.accountNumber).toBe("SUB-20250124-00001");
    expect(body.serviceAccounts).toHaveLength(2);
    expect(body.serviceAccounts[0].planName).toBe("Fiber 25Mbps");
    expect(body.serviceAccounts[1].planName).toBe("Cable Basic");
  });
});
