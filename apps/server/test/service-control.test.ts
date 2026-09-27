// S4-7 (suspension threshold) and S4-8 (reconnection record).
//
// Two halves:
//   • pure tests for the threshold boundary — an account one day short does NOT
//     qualify, one exactly at the threshold does, and the account qualifies on its
//     OLDEST unpaid invoice;
//   • route tests that the preview suspends nobody, the explicit run writes real
//     `suspension_records` rows (with approver and reason) and that a reconnection
//     records the technician and its request/completion dates beside the fee invoice.

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
import { reconnectionRecords, suspensionRecords } from "../src/db/schema/service-control";
import {
  qualifiesForSuspension,
  summarizeSuspensionCandidates,
  type SuspensionInvoiceRow,
} from "../src/modules/service-accounts/suspension-threshold.service";
import { fakeDatabase, type RecordedInsert } from "./support/fake-database";
import { authorizationHeader, signTestToken } from "./support/tokens";

const ADMIN_ID = randomUUID();
const CLERK_ID = randomUUID();
const SERVICE_ACCOUNT_ID = randomUUID();
const SUBSCRIBER_ID = randomUUID();
const PLAN_ID = randomUUID();
const INVOICE_ID = randomUUID();
const TECHNICIAN_ID = randomUUID();

function accountRow(overrides: Record<string, unknown> = {}) {
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

function insertedInto(table: unknown): RecordedInsert[] {
  return fakeDatabase.insertedRows.filter((row) => row.table === table);
}

function candidateRow(overrides: Partial<SuspensionInvoiceRow> = {}): SuspensionInvoiceRow {
  return {
    serviceAccountId: SERVICE_ACCOUNT_ID,
    serviceAccountNumber: "SA-20250124-00001",
    subscriberId: SUBSCRIBER_ID,
    subscriberFirstName: "Maria",
    subscriberLastName: "Santos",
    remainingBalanceCentavos: 99900,
    dueDate: "2020-01-01",
    ...overrides,
  };
}

describe("suspension threshold boundary", () => {
  it("is one day short below the threshold and qualifies exactly at it", () => {
    expect(qualifiesForSuspension(29, 30)).toBe(false);
    expect(qualifiesForSuspension(30, 30)).toBe(true);
    expect(qualifiesForSuspension(31, 30)).toBe(true);
  });

  it("keeps an account one day short out and includes the exact-threshold one", () => {
    const rows: SuspensionInvoiceRow[] = [
      candidateRow({ serviceAccountId: "short", dueDate: "2025-02-14" }), // 29 days before 2025-03-15
      candidateRow({ serviceAccountId: "exact", dueDate: "2025-02-13" }), // 30 days
    ];

    const candidates = summarizeSuspensionCandidates(rows, "2025-03-15", 30);

    expect(candidates.map((candidate) => candidate.serviceAccountId)).toEqual(["exact"]);
    expect(candidates[0]?.daysPastDue).toBe(30);
  });

  it("qualifies an account on its oldest unpaid invoice, summing the balances", () => {
    const rows: SuspensionInvoiceRow[] = [
      candidateRow({ dueDate: "2025-03-01", remainingBalanceCentavos: 10000 }),
      candidateRow({ dueDate: "2025-01-01", remainingBalanceCentavos: 25000 }),
    ];

    const candidates = summarizeSuspensionCandidates(rows, "2025-03-15", 30);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      serviceAccountId: SERVICE_ACCOUNT_ID,
      oldestDueDate: "2025-01-01",
      daysPastDue: 73,
      totalOverdueCentavos: 35000,
    });
  });
});

describe("suspension threshold routes", () => {
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

  it("previews the candidates without suspending anyone", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: CLERK_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([candidateRow()]); // outstanding invoices

    const response = await server.inject({
      method: "GET",
      url: "/api/service-accounts/suspension-candidates?thresholdDays=30",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.thresholdDays).toBe(30);
    expect(response.json().data.candidateCount).toBe(1);
    expect(response.json().data.candidates[0]).toMatchObject({
      serviceAccountId: SERVICE_ACCOUNT_ID,
      totalOverdueCentavos: 99900,
    });

    // A preview changes nothing.
    expect(fakeDatabase.updatedRows).toHaveLength(0);
    expect(insertedInto(suspensionRecords)).toHaveLength(0);
  });

  it("suspends qualifying accounts on an explicit run, recording the record and the audit", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: CLERK_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([candidateRow()]); // candidates
    fakeDatabase.queueSelectRows([{ account: accountRow(), plan: planRow() }]); // locked account
    fakeDatabase.queueUpdateRows([accountRow({ status: "suspended", suspensionDate: "2025-01-24" })]);

    const response = await server.inject({
      method: "POST",
      url: "/api/service-accounts/suspension-candidates/run",
      headers: authorizationHeader(token),
      payload: { thresholdDays: 30 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.suspended).toHaveLength(1);
    expect(response.json().data.failed).toHaveLength(0);

    // S1-7/S4-7: a real suspension record with approver, reason and effective date.
    const records = insertedInto(suspensionRecords);
    expect(records).toHaveLength(1);
    expect(records[0]?.values).toMatchObject({
      serviceAccountId: SERVICE_ACCOUNT_ID,
      approvedBy: CLERK_ID,
      createdBy: CLERK_ID,
      effectiveDate: expect.any(String),
    });
    expect(String((records[0]?.values as Record<string, unknown>).reason)).toContain(
      "Automated suspension"
    );

    // S4-7: the run is auditable with the actor.
    const auditRows = insertedInto(auditLogs).map((row) => row.values as Record<string, unknown>);
    expect(auditRows.find((row) => row.action === "service_account.suspended")).toMatchObject({
      entityId: SERVICE_ACCOUNT_ID,
      performedBy: CLERK_ID,
    });
  });

  it("records the technician, request date and completion date on reconnection", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: CLERK_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      { account: accountRow({ status: "suspended", suspensionDate: "2025-01-10" }), plan: planRow() },
    ]);
    fakeDatabase.queueSelectRows([{ balanceCentavos: 0 }]); // ledger balance for the reconnected account
    fakeDatabase.queueUpdateRows([accountRow({ status: "active" })]);
    fakeDatabase.queueInsertRows([], [{ id: INVOICE_ID }]); // history row, then invoice returning
    fakeDatabase.queueSelectRows([
      { id: SERVICE_ACCOUNT_ID, planName: "Fiber 25Mbps", reconnectionFeeCentavos: 50000 },
    ]);
    fakeDatabase.queueSelectRows([]); // existing invoice numbers for the period
    fakeDatabase.queueSelectRows([{ balanceCentavos: 0 }]); // advance-credit balance check
    fakeDatabase.queueSelectRows([{ id: INVOICE_ID, invoiceType: "reconnection_fee" }]);
    fakeDatabase.queueSelectRows([[]]); // reload line items

    const response = await server.inject({
      method: "PUT",
      url: `/api/service-accounts/${SERVICE_ACCOUNT_ID}/reconnect`,
      headers: authorizationHeader(token),
      payload: {
        reason: "Balance settled in full",
        technicianId: TECHNICIAN_ID,
        requestDate: "2025-01-12",
        completionDate: "2025-01-14",
      },
    });

    expect(response.statusCode).toBe(200);

    // S4-8: the operating record sits beside the fee invoice.
    const records = insertedInto(reconnectionRecords);
    expect(records).toHaveLength(1);
    expect(records[0]?.values).toMatchObject({
      serviceAccountId: SERVICE_ACCOUNT_ID,
      technicianId: TECHNICIAN_ID,
      requestDate: "2025-01-12",
      completionDate: "2025-01-14",
      feeCentavos: 50000,
      approvedBy: CLERK_ID,
    });
    expect((records[0]?.values as Record<string, unknown>).invoiceId).toBe(INVOICE_ID);

    // S4-8: completion is auditable.
    const auditRows = insertedInto(auditLogs).map((row) => row.values as Record<string, unknown>);
    expect(auditRows.find((row) => row.action === "service_account.reconnected")).toMatchObject({
      entityId: SERVICE_ACCOUNT_ID,
      performedBy: CLERK_ID,
    });
  });
});
