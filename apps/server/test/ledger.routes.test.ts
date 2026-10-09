// HTTP acceptance tests for the Phase 6 ledger endpoints.
//
// They run against the real Fastify app via `app.inject()` with the database
// replaced by the in-memory stand-in, so no PostgreSQL is required. They pin the
// behaviour the phase is judged on:
//
//   • the ledger page returns the header, the balance, and the entries
//   • the statement reconciles exactly: opening + debits − credits === closing
//   • the integrity check reports a corrupted chain as invalid
//   • only an Admin may verify the ledger or post a manual adjustment
//   • every protected route is enforced on the server, not in the UI

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
import { ledgerEntries } from "../src/db/schema/ledger";
import { fakeDatabase, type RecordedInsert } from "./support/fake-database";
import { authorizationHeader, signTestToken } from "./support/tokens";

const ADMIN_ID = randomUUID();
const CASHIER_ID = randomUUID();
const SERVICE_ACCOUNT_ID = randomUUID();

/** The joined service-account/subscriber/plan row the header query returns. */
function ledgerHeaderRow(overrides: Record<string, unknown> = {}) {
  return {
    serviceAccountId: SERVICE_ACCOUNT_ID,
    serviceAccountNumber: "SA-20250101-00001",
    status: "active",
    planName: "Fiber 25Mbps",
    serviceType: "internet",
    monthlyRateCentavos: 99900,
    subscriberId: randomUUID(),
    subscriberFirstName: "Maria",
    subscriberLastName: "Santos",
    ...overrides,
  };
}

/** A ledger entry row as the list and statement queries return it. */
function ledgerEntryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    sequenceNumber: 1,
    entryDate: new Date("2025-01-05T00:00:00.000Z"),
    entryType: "invoice_posted",
    amountCentavos: 99900,
    runningBalanceCentavos: 99900,
    description: "Invoice INV-2025-01-000001 — January 2025",
    invoiceId: randomUUID(),
    paymentId: null,
    createdBy: ADMIN_ID,
    invoiceNumber: "INV-2025-01-000001",
    receiptNumber: null,
    ...overrides,
  };
}

/** Every ledger insert recorded so far. */
function insertedLedgerRows(): Array<Record<string, unknown>> {
  return fakeDatabase.insertedRows
    .filter((row): row is RecordedInsert => row.table === ledgerEntries)
    .flatMap((row) =>
      Array.isArray(row.values)
        ? (row.values as Array<Record<string, unknown>>)
        : [row.values as Record<string, unknown>]
    );
}

describe("ledger routes", () => {
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

  it("returns the ledger header and a page of entries", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });
    const entry = ledgerEntryRow();

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([ledgerHeaderRow()]); // header
    fakeDatabase.queueSelectRows([{ balanceCentavos: 99900, entryDate: new Date() }]); // latest entry
    fakeDatabase.queueSelectRows([{ total: 1 }]); // entry count
    fakeDatabase.queueSelectRows([entry]); // entries page
    fakeDatabase.queueSelectRows([{ total: 1 }]); // entries total

    const response = await server.inject({
      method: "GET",
      url: `/api/service-accounts/${SERVICE_ACCOUNT_ID}/ledger`,
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.header.balanceCentavos).toBe(99900);
    expect(data.header.serviceAccountNumber).toBe("SA-20250101-00001");
    expect(data.items).toHaveLength(1);
    expect(data.items[0]).toMatchObject({
      entryType: "invoice_posted",
      direction: "debit",
      debitCentavos: 99900,
      creditCentavos: 0,
      runningBalanceCentavos: 99900,
      referenceNumber: "INV-2025-01-000001",
    });
    expect(data.total).toBe(1);
  });

  it("returns the current balance read from the latest entry", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([{ balanceCentavos: -5000, entryDate: new Date() }]); // latest
    fakeDatabase.queueSelectRows([{ total: 2 }]); // count

    const response = await server.inject({
      method: "GET",
      url: `/api/service-accounts/${SERVICE_ACCOUNT_ID}/balance`,
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      serviceAccountId: SERVICE_ACCOUNT_ID,
      balanceCentavos: -5000,
      entryCount: 2,
    });
  });

  it("returns a statement whose debits and credits reconcile to the closing balance", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([ledgerHeaderRow()]); // statement header
    fakeDatabase.queueSelectRows([
      ledgerEntryRow({ sequenceNumber: 1, entryType: "invoice_posted", amountCentavos: 99900, runningBalanceCentavos: 99900 }),
      ledgerEntryRow({
        id: randomUUID(),
        sequenceNumber: 2,
        entryType: "payment_received",
        amountCentavos: 50000,
        runningBalanceCentavos: 49900,
        invoiceId: null,
        paymentId: randomUUID(),
        invoiceNumber: null,
        receiptNumber: "OR-2025-000001",
        description: "Payment OR-2025-000001",
      }),
    ]);

    const response = await server.inject({
      method: "GET",
      url: `/api/service-accounts/${SERVICE_ACCOUNT_ID}/statement`,
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.openingBalanceCentavos).toBe(0);
    expect(data.totalDebitsCentavos).toBe(99900);
    expect(data.totalCreditsCentavos).toBe(50000);
    expect(data.closingBalanceCentavos).toBe(49900);
    // The exact reconciliation the spec requires.
    expect(data.openingBalanceCentavos + data.totalDebitsCentavos - data.totalCreditsCentavos).toBe(
      data.closingBalanceCentavos
    );
    // And it equals the last line's running balance.
    expect(data.lines.at(-1).balanceCentavos).toBe(data.closingBalanceCentavos);
    expect(data.lines[0]).toMatchObject({ debitCentavos: 99900, creditCentavos: 0 });
    expect(data.lines[1]).toMatchObject({ debitCentavos: 0, creditCentavos: 50000 });
  });

  it("starts a period statement from the balance carried in before it", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([ledgerHeaderRow()]); // statement header
    fakeDatabase.queueSelectRows([{ balanceCentavos: 99900 }]); // opening balance before the period
    fakeDatabase.queueSelectRows([
      ledgerEntryRow({ sequenceNumber: 3, entryType: "late_fee", amountCentavos: 5000, runningBalanceCentavos: 104900, invoiceId: randomUUID() }),
    ]);

    const response = await server.inject({
      method: "GET",
      url: `/api/service-accounts/${SERVICE_ACCOUNT_ID}/statement?fromDate=2025-02-01&toDate=2025-02-28`,
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.periodFrom).toBe("2025-02-01");
    expect(data.periodTo).toBe("2025-02-28");
    expect(data.openingBalanceCentavos).toBe(99900);
    expect(data.totalDebitsCentavos).toBe(5000);
    expect(data.closingBalanceCentavos).toBe(104900);
    expect(data.openingBalanceCentavos + data.totalDebitsCentavos - data.totalCreditsCentavos).toBe(
      data.closingBalanceCentavos
    );
  });

  it("verifies the ledger chain for an Admin", async () => {
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      { id: randomUUID(), sequenceNumber: 1, entryType: "invoice_posted", amountCentavos: 99900, runningBalanceCentavos: 99900 },
      { id: randomUUID(), sequenceNumber: 2, entryType: "payment_received", amountCentavos: 50000, runningBalanceCentavos: 49900 },
    ]);

    const response = await server.inject({
      method: "GET",
      url: `/api/ledger/verify/${SERVICE_ACCOUNT_ID}`,
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      isValid: true,
      failure: null,
      lastComputedBalanceCentavos: 49900,
    });
  });

  it("reports a corrupted chain as invalid", async () => {
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      { id: randomUUID(), sequenceNumber: 1, entryType: "invoice_posted", amountCentavos: 99900, runningBalanceCentavos: 99900 },
      // Sequence 2 is missing: a row was deleted.
      { id: randomUUID(), sequenceNumber: 3, entryType: "payment_received", amountCentavos: 50000, runningBalanceCentavos: 49900 },
    ]);

    const response = await server.inject({
      method: "GET",
      url: `/api/ledger/verify/${SERVICE_ACCOUNT_ID}`,
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      isValid: false,
      failure: "sequence_gap",
      missingSequenceNumber: 2,
    });
  });

  it("denies a non-Admin the integrity check", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });

    fakeDatabase.queueSelectRows([]); // authenticate

    const response = await server.inject({
      method: "GET",
      url: `/api/ledger/verify/${SERVICE_ACCOUNT_ID}`,
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(403);
  });

  it("denies a Collector the ledger (no ledger:read permission)", async () => {
    const { token } = signTestToken({ role: "collector", sub: randomUUID() });

    fakeDatabase.queueSelectRows([]); // authenticate

    const response = await server.inject({
      method: "GET",
      url: `/api/service-accounts/${SERVICE_ACCOUNT_ID}/ledger`,
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects an unauthenticated balance request", async () => {
    const response = await server.inject({
      method: "GET",
      url: `/api/service-accounts/${SERVICE_ACCOUNT_ID}/balance`,
    });

    expect(response.statusCode).toBe(401);
  });

  it("posts a manual debit for an Admin and returns the new balance", async () => {
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID });
    const entryId = randomUUID();

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([{ balanceCentavos: 0, sequenceNumber: 0 }]); // previous state
    fakeDatabase.queueInsertRows([{ id: entryId }]); // ledger insert
    fakeDatabase.queueSelectRows([{ balanceCentavos: 12500, entryDate: new Date() }]); // new balance
    fakeDatabase.queueSelectRows([{ total: 1 }]); // new count

    const response = await server.inject({
      method: "POST",
      url: "/api/ledger/manual-entry",
      headers: authorizationHeader(token),
      payload: {
        serviceAccountId: SERVICE_ACCOUNT_ID,
        entryType: "manual_debit",
        amountCentavos: 12500,
        reason: "Installation materials charge",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({ entryId, balanceCentavos: 12500 });

    const ledgerRows = insertedLedgerRows();
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]).toMatchObject({
      entryType: "manual_debit",
      amountCentavos: 12500,
      runningBalanceCentavos: 12500,
      sequenceNumber: 1,
      description: "Manual Debit — Installation materials charge",
    });
  });

  it("denies a non-Admin the manual entry", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: randomUUID() });

    fakeDatabase.queueSelectRows([]); // authenticate

    const response = await server.inject({
      method: "POST",
      url: "/api/ledger/manual-entry",
      headers: authorizationHeader(token),
      payload: {
        serviceAccountId: SERVICE_ACCOUNT_ID,
        entryType: "manual_debit",
        amountCentavos: 12500,
        reason: "Installation materials charge",
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects a manual entry without a real justification", async () => {
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate

    const response = await server.inject({
      method: "POST",
      url: "/api/ledger/manual-entry",
      headers: authorizationHeader(token),
      payload: {
        serviceAccountId: SERVICE_ACCOUNT_ID,
        entryType: "manual_debit",
        amountCentavos: 12500,
        reason: "oops",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(insertedLedgerRows()).toHaveLength(0);
  });
});
