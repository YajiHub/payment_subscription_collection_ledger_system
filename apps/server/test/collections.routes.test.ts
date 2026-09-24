// Acceptance tests for Phase 7 — field collection and receivables.
//
// They run against the real Fastify app via `app.inject()` with the database
// swapped for the in-memory stand-in, so no PostgreSQL is required. What is being
// pinned down is the cash-reconciliation behaviour:
//
//   • a batch's expected remittance always equals the sum of its collections
//   • a Collector can only read and change their OWN batches (server-side)
//   • the reverse-side permissions hold (a Collector cannot post office payments;
//     a Cashier cannot create or remit a batch)
//   • variance is `actual - expected`, stored and visible, never absorbed
//   • re-submitting or re-reconciling is a conflict, and reconciliation cannot
//     precede remittance
//   • recording a collection creates a real payment and a ledger credit
//   • recording a collection never emits a DELETE
//   • AR aging totals, the overdue list, and the XLSX export

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
import { batchAssignments, collectorBatches } from "../src/db/schema/collections";
import { ledgerEntries } from "../src/db/schema/ledger";
import { payments } from "../src/db/schema/payments";
import { serviceStatusHistory } from "../src/db/schema/subscribers";
import { fakeDatabase, type RecordedInsert } from "./support/fake-database";
import { authorizationHeader, signTestToken } from "./support/tokens";

const ADMIN_ID = randomUUID();
const BILLING_CLERK_ID = randomUUID();
const CASHIER_ID = randomUUID();
const COLLECTOR_A_ID = randomUUID();
const COLLECTOR_B_ID = randomUUID();
const SERVICE_ACCOUNT_A = randomUUID();
const SERVICE_ACCOUNT_B = randomUUID();
const BATCH_ID = randomUUID();
const BATCH_NUMBER = "CB-20250124-0001";

const COLLECTION_DATE = "2025-01-24";

/** A collector user row as the create-batch validation selects it. */
function collectorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: COLLECTOR_A_ID,
    fullName: "Rico Reyes",
    role: "collector",
    isActive: true,
    ...overrides,
  };
}

/** A collector batch row with sensible defaults. */
function batchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BATCH_ID,
    batchNumber: BATCH_NUMBER,
    collectorId: COLLECTOR_A_ID,
    status: "open",
    collectionDate: COLLECTION_DATE,
    expectedRemittanceCentavos: 0,
    actualRemittanceCentavos: null,
    varianceCentavos: null,
    varianceNotes: null,
    createdAt: new Date("2025-01-24T08:00:00Z"),
    submittedAt: null,
    reconciledAt: null,
    cancelledAt: null,
    createdBy: ADMIN_ID,
    reconciledBy: null,
    cancelledBy: null,
    cancelReason: null,
    ...overrides,
  };
}

/** A batch assignment row with sensible defaults. */
function assignmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    batchId: BATCH_ID,
    serviceAccountId: SERVICE_ACCOUNT_A,
    outstandingBalanceCentavos: 50000,
    collectionResult: null,
    collectedAmountCentavos: null,
    collectedMethod: null,
    paymentId: null,
    collectorNotes: null,
    updatedAt: null,
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
    ...overrides,
  };
}

/** A payment row the field collection created. */
function paymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    receiptNumber: "OR-2025-000001",
    serviceAccountId: SERVICE_ACCOUNT_A,
    paymentMethod: "cash",
    status: "posted",
    amountCentavos: 50000,
    allocatedCentavos: 50000,
    advanceCreditCentavos: 0,
    paymentDate: COLLECTION_DATE,
    notes: `Field collection ${BATCH_NUMBER}`,
    postedAt: new Date("2025-01-24T09:00:00Z"),
    postedBy: ADMIN_ID,
    reversedAt: null,
    reversedBy: null,
    ...overrides,
  };
}

/** A joined assignment row as the detail query returns it. */
function assignmentDetailRow(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    serviceAccountId: SERVICE_ACCOUNT_A,
    serviceAccountNumber: "SA-20250101-00001",
    subscriberId: randomUUID(),
    subscriberFirstName: "Maria",
    subscriberLastName: "Santos",
    planName: "Fiber 25Mbps",
    outstandingBalanceCentavos: 50000,
    collectionResult: null,
    collectedAmountCentavos: null,
    collectedMethod: null,
    paymentId: null,
    collectorNotes: null,
    voidedAt: null,
    voidReason: null,
    ...overrides,
  };
}

function insertedInto(table: unknown): RecordedInsert[] {
  return fakeDatabase.insertedRows.filter((row) => row.table === table);
}

function ledgerWrites(): Array<Record<string, unknown>> {
  return insertedInto(ledgerEntries).flatMap((row) =>
    Array.isArray(row.values)
      ? (row.values as Array<Record<string, unknown>>)
      : [row.values as Record<string, unknown>]
  );
}

function updatedValuesFor(table: unknown): Array<Record<string, unknown>> {
  return fakeDatabase.updatedRows
    .filter((row) => row.table === table)
    .map((row) => row.values as Record<string, unknown>);
}

describe("collector batch routes", () => {
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

  it("creates a batch with its assigned service accounts", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: BILLING_CLERK_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([collectorRow()]); // the collector exists
    fakeDatabase.queueSelectRows([{ id: SERVICE_ACCOUNT_A }, { id: SERVICE_ACCOUNT_B }]);
    fakeDatabase.queueSelectRows([]); // SERVICE_ACCOUNT_A not in an open batch
    fakeDatabase.queueSelectRows([]); // SERVICE_ACCOUNT_B not in an open batch
    fakeDatabase.queueSelectRows([]); // existing batch numbers for the date
    fakeDatabase.queueSelectRows([
      { serviceAccountId: SERVICE_ACCOUNT_A, remainingBalanceCentavos: 50000 },
      { serviceAccountId: SERVICE_ACCOUNT_B, remainingBalanceCentavos: 99900 },
    ]);
    fakeDatabase.queueInsertRows([
      batchRow({ collectorId: COLLECTOR_A_ID, expectedRemittanceCentavos: 0 }),
    ]); // the batch insert

    const response = await server.inject({
      method: "POST",
      url: "/api/collector-batches",
      headers: authorizationHeader(token),
      payload: {
        collectorId: COLLECTOR_A_ID,
        collectionDate: COLLECTION_DATE,
        serviceAccountIds: [SERVICE_ACCOUNT_A, SERVICE_ACCOUNT_B],
      },
    });

    expect(response.statusCode).toBe(201);
    const data = response.json().data;
    expect(data.batchNumber).toBe(BATCH_NUMBER);
    expect(data.assignmentCount).toBe(2);
    expect(insertedInto(batchAssignments)).toHaveLength(1);
    expect(insertedInto(collectorBatches)).toHaveLength(1);
  });

  it("lists the active collectors a batch can be created for", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: BILLING_CLERK_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([{ id: COLLECTOR_A_ID, fullName: "Rico Reyes", isActive: true }]);

    const response = await server.inject({
      method: "GET",
      url: "/api/collector-batches/collectors",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.items).toEqual([
      { id: COLLECTOR_A_ID, fullName: "Rico Reyes", isActive: true },
    ]);
  });

  it("refuses a service account that is already in an open batch", async () => {
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([collectorRow()]);
    fakeDatabase.queueSelectRows([{ id: SERVICE_ACCOUNT_A }]);
    fakeDatabase.queueSelectRows([{ id: randomUUID() }]); // already in an open batch

    const response = await server.inject({
      method: "POST",
      url: "/api/collector-batches",
      headers: authorizationHeader(token),
      payload: {
        collectorId: COLLECTOR_A_ID,
        collectionDate: COLLECTION_DATE,
        serviceAccountIds: [SERVICE_ACCOUNT_A],
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain("open collector batch");
  });

  it("returns a clean 409, not a 500, when the batch number collides", async () => {
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([collectorRow()]);
    fakeDatabase.queueSelectRows([{ id: SERVICE_ACCOUNT_A }]);
    fakeDatabase.queueSelectRows([]);
    fakeDatabase.queueSelectRows([]);
    fakeDatabase.queueSelectRows([]);
    const uniqueViolation = Object.assign(new Error("duplicate key"), { code: "23505" });
    fakeDatabase.failNextInsert(uniqueViolation);

    const response = await server.inject({
      method: "POST",
      url: "/api/collector-batches",
      headers: authorizationHeader(token),
      payload: {
        collectorId: COLLECTOR_A_ID,
        collectionDate: COLLECTION_DATE,
        serviceAccountIds: [SERVICE_ACCOUNT_A],
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain("already in use");
  });

  it("hides another collector's batch from a Collector (server-side isolation)", async () => {
    const { token } = signTestToken({ role: "collector", sub: COLLECTOR_B_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([{ batch: batchRow({ collectorId: COLLECTOR_A_ID }), collectorName: "Rico Reyes" }]);

    const response = await server.inject({
      method: "GET",
      url: `/api/collector-batches/${BATCH_ID}`,
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(404);
  });

  it("lets a Collector read their own batch", async () => {
    const { token } = signTestToken({ role: "collector", sub: COLLECTOR_A_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([{ batch: batchRow({ collectorId: COLLECTOR_A_ID }), collectorName: "Rico Reyes" }]);
    fakeDatabase.queueSelectRows([assignmentDetailRow()]);

    const response = await server.inject({
      method: "GET",
      url: `/api/collector-batches/${BATCH_ID}`,
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.collectorId).toBe(COLLECTOR_A_ID);
  });

  it("stops a Collector adding a collection to another collector's batch", async () => {
    const { token } = signTestToken({ role: "collector", sub: COLLECTOR_B_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([batchRow({ collectorId: COLLECTOR_A_ID })]);

    const response = await server.inject({
      method: "PUT",
      url: `/api/collector-batches/${BATCH_ID}/assignments/${SERVICE_ACCOUNT_A}`,
      headers: authorizationHeader(token),
      payload: { result: "collected", collectedAmountCentavos: 50000, collectedMethod: "cash" },
    });

    expect(response.statusCode).toBe(404);
  });

  it("records a field collection as a real payment and a ledger credit", async () => {
    const { token } = signTestToken({ role: "collector", sub: COLLECTOR_A_ID });
    const createdPayment = paymentRow();

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([batchRow()]); // the batch (locked)
    fakeDatabase.queueSelectRows([assignmentRow()]); // the assignment (locked)
    fakeDatabase.queueSelectRows([{ id: SERVICE_ACCOUNT_A }]); // account exists
    fakeDatabase.queueSelectRows([
      {
        id: randomUUID(),
        invoiceNumber: "INV-2025-01-000001",
        totalAmountCentavos: 50000,
        paidAmountCentavos: 0,
        remainingBalanceCentavos: 50000,
      },
    ]); // outstanding invoices
    fakeDatabase.queueSelectRows([]); // existing receipt numbers
    fakeDatabase.queueInsertRows([createdPayment]); // the payment insert
    fakeDatabase.queueInsertRows([]); // allocation rows
    fakeDatabase.queueSelectRows([{ balanceCentavos: 0, sequenceNumber: 0 }]); // ledger state
    fakeDatabase.queueSelectRows([{ collectedAmountCentavos: 50000 }]); // expected recompute

    const response = await server.inject({
      method: "PUT",
      url: `/api/collector-batches/${BATCH_ID}/assignments/${SERVICE_ACCOUNT_A}`,
      headers: authorizationHeader(token),
      payload: { result: "collected", collectedAmountCentavos: 50000, collectedMethod: "cash" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.expectedRemittanceCentavos).toBe(50000);
    expect(response.json().data.paymentId).toBe(createdPayment.id);

    const paymentWrites = insertedInto(payments);
    expect(paymentWrites).toHaveLength(1);
    expect(paymentWrites[0]?.values).toMatchObject({
      amountCentavos: 50000,
      paymentMethod: "cash",
      paymentDate: COLLECTION_DATE,
    });

    const credits = ledgerWrites().filter((entry) => entry.entryType === "payment_received");
    expect(credits).toHaveLength(1);
    expect(credits[0]).toMatchObject({ amountCentavos: 50000 });

    // The batch total tracked the collection exactly.
    const batchUpdates = updatedValuesFor(collectorBatches);
    expect(batchUpdates).toContainEqual({ expectedRemittanceCentavos: 50000 });
  });

  it("voids a collection, reversing its payment and dropping the batch total", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([batchRow({ expectedRemittanceCentavos: 50000 })]); // the batch
    fakeDatabase.queueSelectRows([
      assignmentRow({
        collectionResult: "collected",
        collectedAmountCentavos: 50000,
        collectedMethod: "cash",
        paymentId: randomUUID(),
      }),
    ]); // the assignment
    fakeDatabase.queueSelectRows([paymentRow()]); // the payment (locked)
    fakeDatabase.queueSelectRows([]); // allocations to restore
    fakeDatabase.queueSelectRows([]); // existing reversal receipt numbers
    fakeDatabase.queueSelectRows([{ balanceCentavos: 0, sequenceNumber: 1 }]); // ledger state
    fakeDatabase.queueSelectRows([{ collectedAmountCentavos: null }]); // expected recompute

    const response = await server.inject({
      method: "PUT",
      url: `/api/collector-batches/${BATCH_ID}/assignments/${SERVICE_ACCOUNT_A}/void`,
      headers: authorizationHeader(token),
      payload: { reason: "Collector wrote the wrong amount on the slip" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.expectedRemittanceCentavos).toBe(0);

    const reversals = ledgerWrites().filter((entry) => entry.entryType === "payment_reversal");
    expect(reversals).toHaveLength(1);

    const batchUpdates = updatedValuesFor(collectorBatches);
    expect(batchUpdates).toContainEqual({ expectedRemittanceCentavos: 0 });
  });

  it("stores an exact remittance with zero variance", async () => {
    const { token } = signTestToken({ role: "collector", sub: COLLECTOR_A_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([batchRow({ expectedRemittanceCentavos: 50000 })]);

    const response = await server.inject({
      method: "POST",
      url: `/api/collector-batches/${BATCH_ID}/submit`,
      headers: authorizationHeader(token),
      payload: { actualRemittanceCentavos: 50000 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.varianceCentavos).toBe(0);
    expect(response.json().data.hasVariance).toBe(false);
  });

  it("stores a shortage as a negative variance, never absorbing it", async () => {
    const { token } = signTestToken({ role: "collector", sub: COLLECTOR_A_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([batchRow({ expectedRemittanceCentavos: 50000 })]);

    const response = await server.inject({
      method: "POST",
      url: `/api/collector-batches/${BATCH_ID}/submit`,
      headers: authorizationHeader(token),
      payload: { actualRemittanceCentavos: 45000 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.varianceCentavos).toBe(-5000);
    expect(updatedValuesFor(collectorBatches)).toContainEqual({
      status: "submitted",
      actualRemittanceCentavos: 45000,
      varianceCentavos: -5000,
      submittedAt: expect.any(Date),
    });
  });

  it("stores an overage as a positive variance", async () => {
    const { token } = signTestToken({ role: "collector", sub: COLLECTOR_A_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([batchRow({ expectedRemittanceCentavos: 50000 })]);

    const response = await server.inject({
      method: "POST",
      url: `/api/collector-batches/${BATCH_ID}/submit`,
      headers: authorizationHeader(token),
      payload: { actualRemittanceCentavos: 51000 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.varianceCentavos).toBe(1000);
  });

  it("rejects a second remittance of the same batch", async () => {
    const { token } = signTestToken({ role: "collector", sub: COLLECTOR_A_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([batchRow({ status: "submitted", actualRemittanceCentavos: 50000 })]);

    const response = await server.inject({
      method: "POST",
      url: `/api/collector-batches/${BATCH_ID}/submit`,
      headers: authorizationHeader(token),
      payload: { actualRemittanceCentavos: 50000 },
    });

    expect(response.statusCode).toBe(409);
  });

  it("requires variance notes when reconciling a variance", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      batchRow({ status: "submitted", expectedRemittanceCentavos: 50000, actualRemittanceCentavos: 45000, varianceCentavos: -5000 }),
    ]);

    const response = await server.inject({
      method: "POST",
      url: `/api/collector-batches/${BATCH_ID}/reconcile`,
      headers: authorizationHeader(token),
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("Variance notes");
  });

  it("reconciles an exact batch and reports that the ledger agrees", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      batchRow({ status: "submitted", expectedRemittanceCentavos: 50000, actualRemittanceCentavos: 50000, varianceCentavos: 0 }),
    ]);
    fakeDatabase.queueSelectRows([{ amountCentavos: 50000 }]); // the batch's payments

    const response = await server.inject({
      method: "POST",
      url: `/api/collector-batches/${BATCH_ID}/reconcile`,
      headers: authorizationHeader(token),
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.ledgerReconciles).toBe(true);
    expect(response.json().data.ledgerCreditTotalCentavos).toBe(50000);
  });

  it("rejects reconciling the same batch twice", async () => {
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([batchRow({ status: "reconciled", varianceCentavos: 0 })]);

    const response = await server.inject({
      method: "POST",
      url: `/api/collector-batches/${BATCH_ID}/reconcile`,
      headers: authorizationHeader(token),
      payload: {},
    });

    expect(response.statusCode).toBe(409);
  });

  it("rejects reconciliation before remittance", async () => {
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([batchRow({ status: "open" })]);

    const response = await server.inject({
      method: "POST",
      url: `/api/collector-batches/${BATCH_ID}/reconcile`,
      headers: authorizationHeader(token),
      payload: {},
    });

    expect(response.statusCode).toBe(409);
  });

  it("cancels an open batch with no collections", async () => {
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([batchRow()]); // the batch
    fakeDatabase.queueSelectRows([]); // no collected assignments
    fakeDatabase.queueUpdateRows([batchRow({ status: "cancelled" })]); // update ... returning
    fakeDatabase.queueSelectRows([{ fullName: "Rico Reyes" }]); // collector name

    const response = await server.inject({
      method: "POST",
      url: `/api/collector-batches/${BATCH_ID}/cancel`,
      headers: authorizationHeader(token),
      payload: { reason: "Collector went home sick" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe("cancelled");
  });
});

describe("reverse-side permissions", () => {
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

  it("denies a Cashier the ability to create a batch", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });
    fakeDatabase.queueSelectRows([]); // authenticate

    const response = await server.inject({
      method: "POST",
      url: "/api/collector-batches",
      headers: authorizationHeader(token),
      payload: { collectorId: COLLECTOR_A_ID, collectionDate: COLLECTION_DATE, serviceAccountIds: [SERVICE_ACCOUNT_A] },
    });

    expect(response.statusCode).toBe(403);
  });

  it("denies a Cashier the ability to remit a batch", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });
    fakeDatabase.queueSelectRows([]); // authenticate

    const response = await server.inject({
      method: "POST",
      url: `/api/collector-batches/${BATCH_ID}/submit`,
      headers: authorizationHeader(token),
      payload: { actualRemittanceCentavos: 50000 },
    });

    expect(response.statusCode).toBe(403);
  });

  it("denies a Collector the ability to reconcile", async () => {
    const { token } = signTestToken({ role: "collector", sub: COLLECTOR_A_ID });
    fakeDatabase.queueSelectRows([]); // authenticate

    const response = await server.inject({
      method: "POST",
      url: `/api/collector-batches/${BATCH_ID}/reconcile`,
      headers: authorizationHeader(token),
      payload: {},
    });

    expect(response.statusCode).toBe(403);
  });

  it("denies a Collector the ability to post an office payment", async () => {
    const { token } = signTestToken({ role: "collector", sub: COLLECTOR_A_ID });
    fakeDatabase.queueSelectRows([]); // authenticate

    const response = await server.inject({
      method: "POST",
      url: "/api/payments",
      headers: authorizationHeader(token),
      payload: { serviceAccountId: SERVICE_ACCOUNT_A, paymentMethod: "cash", paymentDate: COLLECTION_DATE, amountCentavos: 50000 },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe("receivables routes", () => {
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

  it("returns AR aging buckets with a grand total", async () => {
    const { token } = signTestToken({ role: "manager", sub: randomUUID() });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      {
        invoiceId: randomUUID(),
        serviceAccountId: SERVICE_ACCOUNT_A,
        remainingBalanceCentavos: 50000,
        dueDate: "2025-02-10",
        subscriberId: randomUUID(),
        subscriberFirstName: "Maria",
        subscriberLastName: "Santos",
        serviceAccountNumber: "SA-20250101-00001",
        planName: "Fiber 25Mbps",
      },
    ]);

    const response = await server.inject({
      method: "GET",
      url: "/api/receivables/ar-aging?asOfDate=2025-02-15",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.totals.grandTotal).toBe(50000);
    expect(response.json().data.entries[0].bucket_1_30_centavos).toBe(50000);
  });

  it("lists overdue accounts with their consecutive overdue months", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: BILLING_CLERK_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      {
        serviceAccountId: SERVICE_ACCOUNT_A,
        remainingBalanceCentavos: 50000,
        billingPeriodYear: 2025,
        billingPeriodMonth: 1,
        dueDate: "2025-01-15",
        serviceAccountNumber: "SA-20250101-00001",
        subscriberId: randomUUID(),
        subscriberFirstName: "Maria",
        subscriberLastName: "Santos",
        planName: "Fiber 25Mbps",
        storedConsecutiveOverdueMonths: 0,
        collectorId: COLLECTOR_A_ID,
        collectorName: "Rico Reyes",
      },
      {
        serviceAccountId: SERVICE_ACCOUNT_A,
        remainingBalanceCentavos: 30000,
        billingPeriodYear: 2024,
        billingPeriodMonth: 12,
        dueDate: "2024-12-15",
        serviceAccountNumber: "SA-20250101-00001",
        subscriberId: randomUUID(),
        subscriberFirstName: "Maria",
        subscriberLastName: "Santos",
        planName: "Fiber 25Mbps",
        storedConsecutiveOverdueMonths: 0,
        collectorId: COLLECTOR_A_ID,
        collectorName: "Rico Reyes",
      },
    ]);
    fakeDatabase.queueSelectRows([]); // payments for the listed accounts

    const response = await server.inject({
      method: "GET",
      url: "/api/receivables/overdue",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.items[0]).toMatchObject({
      consecutiveOverdueMonths: 2,
      totalOverdueCentavos: 80000,
    });
  });

  it("exports AR aging as an XLSX file", async () => {
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([]); // no outstanding invoices

    const response = await server.inject({
      method: "GET",
      url: "/api/receivables/ar-aging/export?asOfDate=2025-02-15",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    expect(response.headers["content-disposition"]).toContain("AR-aging-2025-02-15.xlsx");
    expect(response.rawPayload[0]).toBe(0x50); // "P"
    expect(response.rawPayload[1]).toBe(0x4b); // "K"
  });

  it("denies a Collector the report export (needs reports:export)", async () => {
    const { token } = signTestToken({ role: "collector", sub: COLLECTOR_A_ID });
    fakeDatabase.queueSelectRows([]); // authenticate

    const response = await server.inject({
      method: "GET",
      url: "/api/receivables/ar-aging/export",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(403);
  });

  it("suspends selected overdue accounts and reports the ones that failed", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: BILLING_CLERK_ID });
    const accountRow = {
      id: SERVICE_ACCOUNT_A,
      serviceAccountNumber: "SA-20250101-00001",
      subscriberId: randomUUID(),
      planId: randomUUID(),
      status: "active",
      activationDate: "2025-01-01",
      suspensionDate: null,
      terminationDate: null,
      assignedCollectorId: null,
      consecutiveOverdueMonths: 2,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const planRow = {
      id: accountRow.planId,
      name: "Fiber 25Mbps",
      serviceType: "internet",
      monthlyRateCentavos: 99900,
      reconnectionFeeCentavos: 50000,
    };

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([{ account: accountRow, plan: planRow }]); // account for suspension
    fakeDatabase.queueUpdateRows([{ ...accountRow, status: "suspended" }]); // update ... returning
    fakeDatabase.queueSelectRows([]); // the second account does not exist

    const response = await server.inject({
      method: "POST",
      url: "/api/receivables/overdue/suspend",
      headers: authorizationHeader(token),
      payload: { serviceAccountIds: [SERVICE_ACCOUNT_A, SERVICE_ACCOUNT_B], reason: "Non-payment" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.suspended).toEqual([SERVICE_ACCOUNT_A]);
    expect(response.json().data.failed).toHaveLength(1);
    expect(insertedInto(serviceStatusHistory)).toHaveLength(1);
  });
});