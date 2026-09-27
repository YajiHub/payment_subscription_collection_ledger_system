// Acceptance tests for subscriber and service account management (Phase 3).
//
// They run through the real Fastify application, the real middleware, and the real
// services; only the database is replaced by an in-memory stand-in. That keeps the
// tests fast and database-independent while still asserting the exact rows the
// services write.

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
import { authorizationHeader, signTestToken, UUID_PATTERN } from "./support/tokens";

const ADMIN_ID = randomUUID();
const CLERK_ID = randomUUID();
const PLAN_ID = randomUUID();
const CABLE_PLAN_ID = randomUUID();
const SUBSCRIBER_ID = randomUUID();
const SERVICE_ACCOUNT_ID = randomUUID();
const INVOICE_ID = randomUUID();

/** A stored subscriber row, as the service layer would receive it back. */
function subscriberRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SUBSCRIBER_ID,
    accountNumber: "SUB-20250124-00001",
    firstName: "Maria",
    lastName: "Santos",
    middleName: null,
    primaryPhone: "09171234567",
    secondaryPhone: null,
    emailAddress: null,
    serviceAddress: "12 Mabini Street",
    serviceBarangay: "Poblacion",
    serviceMunicipality: "Cabuyao",
    serviceProvince: "Laguna",
    internalNotes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: ADMIN_ID,
    updatedBy: null,
    ...overrides,
  };
}

/** A stored plan row. PHP 999.00 monthly, PHP 500.00 reconnection fee. */
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

function cablePlanRow(overrides: Record<string, unknown> = {}) {
  return planRow({
    id: CABLE_PLAN_ID,
    name: "Cable Basic",
    serviceType: "cable_tv",
    speedMbps: null,
    cablePackageDescription: "40 channels",
    monthlyRateCentavos: 49900,
    ...overrides,
  });
}

/** A stored service account row. */
function serviceAccountRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SERVICE_ACCOUNT_ID,
    serviceAccountNumber: "SA-20250124-00001",
    subscriberId: SUBSCRIBER_ID,
    planId: PLAN_ID,
    status: "active",
    activationDate: "2025-01-24",
    suspensionDate: null,
    terminationDate: null,
    assignedCollectorId: null,
    consecutiveOverdueMonths: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** The full subscriber payload the Add Subscriber screen sends. */
const subscriberPayload = {
  firstName: "Maria",
  lastName: "Santos",
  primaryPhone: "09171234567",
  serviceAddress: "12 Mabini Street",
  serviceBarangay: "Poblacion",
  serviceMunicipality: "Cabuyao",
  serviceProvince: "Laguna",
};

describe("subscriber management routes", () => {
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

  it("lets a Billing Clerk create a subscriber together with its first service account", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: CLERK_ID });

    fakeDatabase.queueSelectRows([]); // authenticate: token revocation lookup
    fakeDatabase.queueSelectRows([]); // nextSubscriberAccountNumber: numbers issued today
    fakeDatabase.queueInsertRows([subscriberRow()]); // insert subscriber
    fakeDatabase.queueSelectRows([planRow()]); // requireAssignablePlan
    fakeDatabase.queueSelectRows([]); // nextServiceAccountNumber: numbers issued today
    fakeDatabase.queueInsertRows([serviceAccountRow({ status: "pending", activationDate: null })]);

    const response = await server.inject({
      method: "POST",
      url: "/api/subscribers",
      headers: authorizationHeader(token),
      payload: { ...subscriberPayload, serviceAccount: { planId: PLAN_ID } },
    });

    expect(response.statusCode).toBe(201);

    const subscriberInsert = fakeDatabase.insertedRows[0]?.values as Record<string, unknown>;
    const accountInsert = fakeDatabase.insertedRows[1]?.values as Record<string, unknown>;

    // AC: the account number follows SUB-YYYYMMDD-XXXXX and is generated, not supplied.
    // The sequence starts at 1 because the day had no account numbers yet.
    expect(subscriberInsert.accountNumber).toMatch(/^SUB-\d{8}-00001$/);
    expect(subscriberInsert.createdBy).toBe(CLERK_ID);

    // AC: a new account with no activation date is "pending".
    expect(accountInsert.status).toBe("pending");
    expect(accountInsert.activationDate).toBeNull();
    expect(accountInsert.serviceAccountNumber).toMatch(/^SA-\d{8}-\d{5}$/);
    expect(accountInsert.subscriberId).toBe(SUBSCRIBER_ID);
    expect(accountInsert.createdBy).toBe(CLERK_ID);

    expect(response.json().data.serviceAccounts).toHaveLength(1);
    expect(response.json().data.serviceAccounts[0].status).toBe("pending");
  });

  it("rolls back the subscriber when its first service account cannot be created", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: CLERK_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([]); // subscriber numbers today
    fakeDatabase.queueInsertRows([subscriberRow()]); // the subscriber insert succeeds
    fakeDatabase.queueSelectRows([planRow()]); // requireAssignablePlan
    fakeDatabase.queueSelectRows([]); // service account numbers today
    // No service-account insert row is queued, so the account insert fails after
    // the subscriber row was written. A household must not survive without service.

    const response = await server.inject({
      method: "POST",
      url: "/api/subscribers",
      headers: authorizationHeader(token),
      payload: { ...subscriberPayload, serviceAccount: { planId: PLAN_ID } },
    });

    expect(response.statusCode).toBe(404);
    // The subscriber insert is discarded together with the failed account insert.
    expect(fakeDatabase.insertedRows).toHaveLength(0);
  });

  it("creates the service account as active when an activation date is supplied", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: CLERK_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([]); // subscriber numbers today
    fakeDatabase.queueInsertRows([subscriberRow()]);
    fakeDatabase.queueSelectRows([planRow()]);
    fakeDatabase.queueSelectRows([]); // service account numbers today
    fakeDatabase.queueInsertRows([
      serviceAccountRow({ status: "active", activationDate: "2025-01-24" }),
    ]);

    const response = await server.inject({
      method: "POST",
      url: "/api/subscribers",
      headers: authorizationHeader(token),
      payload: {
        ...subscriberPayload,
        serviceAccount: { planId: PLAN_ID, activationDate: "2025-01-24" },
      },
    });

    expect(response.statusCode).toBe(201);
    const accountInsert = fakeDatabase.insertedRows[1]?.values as Record<string, unknown>;
    expect(accountInsert.status).toBe("active");
    expect(accountInsert.activationDate).toBe("2025-01-24");
  });

  it("adds another service account to an existing subscriber", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: CLERK_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([{ id: SUBSCRIBER_ID }]); // subscriber exists
    fakeDatabase.queueSelectRows([cablePlanRow()]); // requireAssignablePlan
    fakeDatabase.queueSelectRows([]); // service account numbers today
    fakeDatabase.queueInsertRows([
      serviceAccountRow({ planId: CABLE_PLAN_ID, serviceAccountNumber: "SA-20250124-00002" }),
    ]);

    const response = await server.inject({
      method: "POST",
      url: `/api/subscribers/${SUBSCRIBER_ID}/service-accounts`,
      headers: authorizationHeader(token),
      payload: { planId: CABLE_PLAN_ID, activationDate: "2025-01-24" },
    });

    expect(response.statusCode).toBe(201);
    const accountInsert = fakeDatabase.insertedRows[0]?.values as Record<string, unknown>;
    expect(accountInsert.subscriberId).toBe(SUBSCRIBER_ID);
    expect(accountInsert.planId).toBe(CABLE_PLAN_ID);
    expect(response.json().data.planName).toBe("Cable Basic");
  });

  it("returns a subscriber with every one of their service accounts", async () => {
    const { token } = signTestToken({ role: "manager", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([subscriberRow()]); // the subscriber
    fakeDatabase.queueSelectRows([
      { account: serviceAccountRow(), plan: planRow() },
      {
        account: serviceAccountRow({ id: randomUUID(), planId: CABLE_PLAN_ID }),
        plan: cablePlanRow(),
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
    expect(
      body.serviceAccounts.map((account: { serviceType: string }) => account.serviceType)
    ).toEqual(["internet", "cable_tv"]);
    // AC: a Manager may read subscriber data.
    expect(UUID_PATTERN.test(body.id)).toBe(true);
  });

  it("filters the subscriber list by search term and reports the total", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: CLERK_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([subscriberRow()]); // page of subscribers
    fakeDatabase.queueSelectRows([{ value: 1 }]); // total count
    fakeDatabase.queueSelectRows([{ account: serviceAccountRow(), plan: planRow() }]); // accounts

    const response = await server.inject({
      method: "GET",
      url: "/api/subscribers?search=santos&page=1&pageSize=20",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json().data;
    expect(body.total).toBe(1);
    expect(body.items[0].lastName).toBe("Santos");
    expect(body.items[0].serviceAccounts).toHaveLength(1);
  });

  it("answers the dedicated search endpoint", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: CLERK_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([subscriberRow()]); // matches
    fakeDatabase.queueSelectRows([{ value: 1 }]); // total
    fakeDatabase.queueSelectRows([]); // accounts for the page

    const response = await server.inject({
      method: "GET",
      url: "/api/subscribers/search?q=0917",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.items).toHaveLength(1);
  });

  it("updates a subscriber's contact details and stamps who changed them", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: CLERK_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueUpdateRows([subscriberRow({ primaryPhone: "09991234567" })]);
    fakeDatabase.queueSelectRows([]); // accounts for the updated subscriber

    const response = await server.inject({
      method: "PUT",
      url: `/api/subscribers/${SUBSCRIBER_ID}`,
      headers: authorizationHeader(token),
      payload: { primaryPhone: "09991234567" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.primaryPhone).toBe("09991234567");

    const update = fakeDatabase.updatedRows[0]?.values as Record<string, unknown>;
    expect(update.primaryPhone).toBe("09991234567");
    expect(update.updatedBy).toBe(CLERK_ID);
  });

  it("returns the statement of account for every service the subscriber holds", async () => {
    const { token } = signTestToken({ role: "cashier", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([subscriberRow()]); // subscriber
    fakeDatabase.queueSelectRows([{ account: serviceAccountRow(), plan: planRow() }]); // accounts
    fakeDatabase.queueSelectRows([{ balanceCentavos: 125000 }]); // ledger balance for the account

    const response = await server.inject({
      method: "GET",
      url: `/api/subscribers/${SUBSCRIBER_ID}/statement`,
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json().data;
    expect(body.subscriber.accountNumber).toBe("SUB-20250124-00001");
    expect(body.serviceAccounts).toHaveLength(1);
    // The balance comes from the account's latest ledger entry.
    expect(body.serviceAccounts[0].balanceCentavos).toBe(125000);
    expect(body.totalOutstandingCentavos).toBe(125000);
  });

  it("returns a real ledger balance on the subscriber profile, never null", async () => {
    const { token } = signTestToken({ role: "cashier", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([subscriberRow()]); // subscriber
    fakeDatabase.queueSelectRows([{ account: serviceAccountRow(), plan: planRow() }]); // accounts
    fakeDatabase.queueSelectRows([{ balanceCentavos: 649500 }]); // ledger balance for the account

    const response = await server.inject({
      method: "GET",
      url: `/api/subscribers/${SUBSCRIBER_ID}`,
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    const account = response.json().data.serviceAccounts[0];
    expect(account.balanceCentavos).not.toBeNull();
    expect(account.balanceCentavos).toBe(649500);
  });

  it("reports the same figure as the outstanding invoice total for the account", async () => {
    const { token } = signTestToken({ role: "cashier", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([subscriberRow()]); // subscriber
    fakeDatabase.queueSelectRows([{ account: serviceAccountRow(), plan: planRow() }]); // accounts
    fakeDatabase.queueSelectRows([{ balanceCentavos: 649500 }]); // profile ledger balance

    const profileResponse = await server.inject({
      method: "GET",
      url: `/api/subscribers/${SUBSCRIBER_ID}`,
      headers: authorizationHeader(token),
    });
    const profileBalance = profileResponse.json().data.serviceAccounts[0].balanceCentavos as number;

    // The same account's payment summary: the invoices still owed add up to the
    // ledger balance, so a profile and a receipt counter cannot quote two figures.
    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      { remainingBalanceCentavos: 400000 },
      { remainingBalanceCentavos: 249500 },
    ]); // outstanding invoices
    fakeDatabase.queueSelectRows([{ balanceCentavos: 649500 }]); // ledger balance for credit check

    const summaryResponse = await server.inject({
      method: "GET",
      url: `/api/service-accounts/${SERVICE_ACCOUNT_ID}/payment-summary`,
      headers: authorizationHeader(token),
    });
    const outstandingTotal = summaryResponse.json().data.outstandingTotalCentavos as number;

    expect(profileBalance).toBe(649500);
    expect(outstandingTotal).toBe(profileBalance);
  });
});

describe("service account suspension and reconnection", () => {
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

  it("rejects a suspension reason shorter than ten characters", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: CLERK_ID });
    fakeDatabase.queueSelectRows([]); // authenticate only — validation stops the handler

    const response = await server.inject({
      method: "PUT",
      url: `/api/service-accounts/${SERVICE_ACCOUNT_ID}/suspend`,
      headers: authorizationHeader(token),
      payload: { reason: "late" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
    expect(fakeDatabase.updatedRows).toHaveLength(0);
  });

  it("suspends an active account and records the change in service_status_history", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: CLERK_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([{ account: serviceAccountRow(), plan: planRow() }]); // current state
    fakeDatabase.queueUpdateRows([
      serviceAccountRow({ status: "suspended", suspensionDate: "2025-01-24" }),
    ]);

    const response = await server.inject({
      method: "PUT",
      url: `/api/service-accounts/${SERVICE_ACCOUNT_ID}/suspend`,
      headers: authorizationHeader(token),
      payload: { reason: "Unpaid for three consecutive months" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe("suspended");

    const update = fakeDatabase.updatedRows[0]?.values as Record<string, unknown>;
    expect(update.status).toBe("suspended");
    expect(typeof update.suspensionDate).toBe("string");

    // AC: suspension creates a row in service_status_history.
    const history = fakeDatabase.insertedRows[0]?.values as Record<string, unknown>;
    expect(history.previousStatus).toBe("active");
    expect(history.newStatus).toBe("suspended");
    expect(history.reason).toBe("Unpaid for three consecutive months");
    expect(history.changedBy).toBe(CLERK_ID);
    expect(history.serviceAccountId).toBe(SERVICE_ACCOUNT_ID);
  });

  it("rolls back a suspension when the audit-trail insert fails", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: CLERK_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([{ account: serviceAccountRow(), plan: planRow() }]); // locked state
    fakeDatabase.queueUpdateRows([
      serviceAccountRow({ status: "suspended", suspensionDate: "2025-01-24" }),
    ]);
    fakeDatabase.failNextInsert(new Error("connection reset before the audit row was written"));

    const response = await server.inject({
      method: "PUT",
      url: `/api/service-accounts/${SERVICE_ACCOUNT_ID}/suspend`,
      headers: authorizationHeader(token),
      payload: { reason: "Unpaid for three consecutive months" },
    });

    expect(response.statusCode).toBe(500);
    // Status and history commit together: a changed status with no audit row
    // must never be possible.
    expect(fakeDatabase.updatedRows).toHaveLength(0);
    expect(fakeDatabase.insertedRows).toHaveLength(0);
  });

  it("refuses to suspend an account that is already suspended", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: CLERK_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      { account: serviceAccountRow({ status: "suspended" }), plan: planRow() },
    ]);

    const response = await server.inject({
      method: "PUT",
      url: `/api/service-accounts/${SERVICE_ACCOUNT_ID}/suspend`,
      headers: authorizationHeader(token),
      payload: { reason: "Trying to suspend twice over" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONFLICT");
    expect(fakeDatabase.updatedRows).toHaveLength(0);
  });

  it("reconnects a suspended account and produces a reconnection fee entry", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: CLERK_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      {
        account: serviceAccountRow({ status: "suspended", suspensionDate: "2025-01-10" }),
        plan: planRow(),
      },
    ]);
    fakeDatabase.queueUpdateRows([
      serviceAccountRow({ status: "active", suspensionDate: null, terminationDate: null }),
    ]);
    // Reconnecting now also raises the reconnection fee invoice (Phase 4).
    fakeDatabase.queueSelectRows([{ balanceCentavos: 0 }]); // ledger balance for the reconnected account
    fakeDatabase.queueInsertRows([], [{ id: INVOICE_ID }]); // history row, then invoice returning
    fakeDatabase.queueSelectRows([
      { id: SERVICE_ACCOUNT_ID, planName: "Fiber 25Mbps", reconnectionFeeCentavos: 50000 },
    ]); // account joined with plan for the fee invoice
    fakeDatabase.queueSelectRows([]); // existing invoice numbers for the period
    fakeDatabase.queueSelectRows([{ id: INVOICE_ID, invoiceType: "reconnection_fee" }]); // reload summary
    fakeDatabase.queueSelectRows([[]]); // reload line items

    const response = await server.inject({
      method: "PUT",
      url: `/api/service-accounts/${SERVICE_ACCOUNT_ID}/reconnect`,
      headers: authorizationHeader(token),
      payload: { reason: "Balance settled in full" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json().data;

    // AC: reconnection changes the status back to "active".
    expect(body.serviceAccount.status).toBe("active");

    const update = fakeDatabase.updatedRows[0]?.values as Record<string, unknown>;
    expect(update.status).toBe("active");
    expect(update.suspensionDate).toBeNull();

    // AC: a reconnection fee entry is produced, priced from the account's plan.
    expect(body.reconnectionFeeEntry).toEqual({
      serviceAccountId: SERVICE_ACCOUNT_ID,
      planId: PLAN_ID,
      amountCentavos: 50000,
      description: "Reconnection fee — Fiber 25Mbps",
    });

    const history = fakeDatabase.insertedRows[0]?.values as Record<string, unknown>;
    expect(history.previousStatus).toBe("suspended");
    expect(history.newStatus).toBe("active");
    expect(history.changedBy).toBe(CLERK_ID);

    // AC: reconnecting a suspended account produces the reconnection fee invoice.
    expect(body.reconnectionFeeInvoice).not.toBeNull();
    expect(body.reconnectionFeeInvoice.amountCentavos).toBe(50000);
  });

  it("rolls back a reconnection when the audit-trail insert fails", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: CLERK_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      {
        account: serviceAccountRow({ status: "suspended", suspensionDate: "2025-01-10" }),
        plan: planRow(),
      },
    ]);
    fakeDatabase.queueUpdateRows([
      serviceAccountRow({ status: "active", suspensionDate: null, terminationDate: null }),
    ]);
    fakeDatabase.failNextInsert(new Error("connection reset before the audit row was written"));

    const response = await server.inject({
      method: "PUT",
      url: `/api/service-accounts/${SERVICE_ACCOUNT_ID}/reconnect`,
      headers: authorizationHeader(token),
      payload: { reason: "Balance settled in full" },
    });

    expect(response.statusCode).toBe(500);
    expect(fakeDatabase.updatedRows).toHaveLength(0);
    expect(fakeDatabase.insertedRows).toHaveLength(0);
  });

  it("refuses to reconnect an account that is not suspended", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: CLERK_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([{ account: serviceAccountRow(), plan: planRow() }]);

    const response = await server.inject({
      method: "PUT",
      url: `/api/service-accounts/${SERVICE_ACCOUNT_ID}/reconnect`,
      headers: authorizationHeader(token),
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(fakeDatabase.updatedRows).toHaveLength(0);
  });

  it("never reactivates a terminated account, but keeps it in history", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: CLERK_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      {
        account: serviceAccountRow({ status: "terminated", terminationDate: "2025-01-20" }),
        plan: planRow(),
      },
    ]);

    const response = await server.inject({
      method: "PUT",
      url: `/api/service-accounts/${SERVICE_ACCOUNT_ID}/reconnect`,
      headers: authorizationHeader(token),
      payload: { reason: "Please switch it back on" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain("terminated");
    expect(fakeDatabase.updatedRows).toHaveLength(0);
    expect(fakeDatabase.insertedRows).toHaveLength(0);
  });

  it("terminates an account with a reason and records the change", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: CLERK_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([{ account: serviceAccountRow(), plan: planRow() }]);
    fakeDatabase.queueUpdateRows([
      serviceAccountRow({ status: "terminated", terminationDate: "2025-01-24" }),
    ]);

    const response = await server.inject({
      method: "PUT",
      url: `/api/service-accounts/${SERVICE_ACCOUNT_ID}/terminate`,
      headers: authorizationHeader(token),
      payload: { reason: "Subscriber moved to another province" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe("terminated");

    const update = fakeDatabase.updatedRows[0]?.values as Record<string, unknown>;
    expect(update.status).toBe("terminated");
    expect(typeof update.terminationDate).toBe("string");

    const history = fakeDatabase.insertedRows[0]?.values as Record<string, unknown>;
    expect(history.newStatus).toBe("terminated");
    expect(history.reason).toBe("Subscriber moved to another province");
  });

  it("rolls back a termination when the audit-trail insert fails", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: CLERK_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([{ account: serviceAccountRow(), plan: planRow() }]);
    fakeDatabase.queueUpdateRows([
      serviceAccountRow({ status: "terminated", terminationDate: "2025-01-24" }),
    ]);
    fakeDatabase.failNextInsert(new Error("connection reset before the audit row was written"));

    const response = await server.inject({
      method: "PUT",
      url: `/api/service-accounts/${SERVICE_ACCOUNT_ID}/terminate`,
      headers: authorizationHeader(token),
      payload: { reason: "Subscriber moved to another province" },
    });

    expect(response.statusCode).toBe(500);
    expect(fakeDatabase.updatedRows).toHaveLength(0);
    expect(fakeDatabase.insertedRows).toHaveLength(0);
  });

  it("returns the service account with its status history", async () => {
    const { token } = signTestToken({ role: "manager", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([{ account: serviceAccountRow(), plan: planRow() }]);
    fakeDatabase.queueSelectRows([
      {
        id: randomUUID(),
        previousStatus: "active",
        newStatus: "suspended",
        reason: "Overdue",
        changedBy: CLERK_ID,
        changedAt: new Date(),
      },
    ]);

    const response = await server.inject({
      method: "GET",
      url: `/api/service-accounts/${SERVICE_ACCOUNT_ID}`,
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.statusHistory).toHaveLength(1);
    expect(response.json().data.statusHistory[0].newStatus).toBe("suspended");
  });
});

describe("subscriber permissions are enforced on the server", () => {
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

  it("lets a Manager read the subscriber list but not create a subscriber", async () => {
    const { token } = signTestToken({ role: "manager", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([]); // empty page
    fakeDatabase.queueSelectRows([{ value: 0 }]); // total

    const listResponse = await server.inject({
      method: "GET",
      url: "/api/subscribers",
      headers: authorizationHeader(token),
    });
    expect(listResponse.statusCode).toBe(200);

    fakeDatabase.queueSelectRows([]); // authenticate only; authorize rejects the request

    const createResponse = await server.inject({
      method: "POST",
      url: "/api/subscribers",
      headers: authorizationHeader(token),
      payload: subscriberPayload,
    });

    // AC: a Manager cannot create or edit.
    expect(createResponse.statusCode).toBe(403);
    expect(createResponse.json().error.code).toBe("FORBIDDEN");
    expect(fakeDatabase.insertedRows).toHaveLength(0);
  });

  it("lets a Cashier read subscriber info but not create, edit, or suspend", async () => {
    const { token } = signTestToken({ role: "cashier", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([subscriberRow()]);
    fakeDatabase.queueSelectRows([]);

    const readResponse = await server.inject({
      method: "GET",
      url: `/api/subscribers/${SUBSCRIBER_ID}`,
      headers: authorizationHeader(token),
    });
    expect(readResponse.statusCode).toBe(200);

    fakeDatabase.queueSelectRows([]); // authenticate only
    const createResponse = await server.inject({
      method: "POST",
      url: "/api/subscribers",
      headers: authorizationHeader(token),
      payload: subscriberPayload,
    });
    expect(createResponse.statusCode).toBe(403);

    fakeDatabase.queueSelectRows([]); // authenticate only
    const editResponse = await server.inject({
      method: "PUT",
      url: `/api/subscribers/${SUBSCRIBER_ID}`,
      headers: authorizationHeader(token),
      payload: { primaryPhone: "09991234567" },
    });
    expect(editResponse.statusCode).toBe(403);

    fakeDatabase.queueSelectRows([]); // authenticate only
    const suspendResponse = await server.inject({
      method: "PUT",
      url: `/api/service-accounts/${SERVICE_ACCOUNT_ID}/suspend`,
      headers: authorizationHeader(token),
      payload: { reason: "Cashier must not be able to do this" },
    });
    expect(suspendResponse.statusCode).toBe(403);

    expect(fakeDatabase.insertedRows).toHaveLength(0);
    expect(fakeDatabase.updatedRows).toHaveLength(0);
  });

  it("rejects an unauthenticated request", async () => {
    const response = await server.inject({ method: "GET", url: "/api/subscribers" });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });

  it("rejects a malformed subscriber id with a validation error", async () => {
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID });
    fakeDatabase.queueSelectRows([]); // authenticate

    const response = await server.inject({
      method: "GET",
      url: "/api/subscribers/not-a-uuid",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });
});
