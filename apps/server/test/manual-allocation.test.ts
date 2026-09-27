// S3-5 — authorized manual allocation.
//
// The default split is oldest-unpaid-first. An operator who holds
// `payments:allocate_manually` may instead name the invoices a payment settles, and
// that choice is recorded with the payment and audited with a reason.
//
// The invariant is the same one the automatic path guarantees:
//
//     SUM(allocations) + advanceCreditCentavos === amountCentavos
//
// The operator must DECLARE the advance credit rather than let the server guess it,
// which is what makes an under-allocated or over-allocated split a refusal instead
// of a silent rounding. These tests pin both directions.

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
import { invoices } from "../src/db/schema/billing";
import { ledgerEntries } from "../src/db/schema/ledger";
import { paymentAllocations, payments } from "../src/db/schema/payments";
import { buildManualAllocation } from "../src/modules/payments/payment-allocation.ts";
import { fakeDatabase } from "./support/fake-database";
import { authorizationHeader, signTestToken } from "./support/tokens";

const CASHIER_ID = randomUUID();
const SERVICE_ACCOUNT_ID = randomUUID();
const PAYMENT_ID = randomUUID();
const OLDEST_INVOICE_ID = randomUUID();
const NEWEST_INVOICE_ID = randomUUID();

const REASON = "Subscriber asked for the newer bill to be settled first";

const OLDEST_INVOICE = {
  id: OLDEST_INVOICE_ID,
  invoiceNumber: "INV-2025-01-000001",
  totalAmountCentavos: 50000,
  paidAmountCentavos: 0,
  remainingBalanceCentavos: 50000,
};

const NEWEST_INVOICE = {
  id: NEWEST_INVOICE_ID,
  invoiceNumber: "INV-2025-02-000001",
  totalAmountCentavos: 80000,
  paidAmountCentavos: 0,
  remainingBalanceCentavos: 80000,
};

function body(overrides: Record<string, unknown> = {}) {
  return {
    serviceAccountId: SERVICE_ACCOUNT_ID,
    paymentMethod: "cash",
    amountCentavos: 100000,
    paymentDate: "2025-03-01",
    manualAllocation: {
      // The operator's choice is deliberately NOT oldest-first.
      allocations: [
        { invoiceId: NEWEST_INVOICE_ID, amountCentavos: 40000 },
        { invoiceId: OLDEST_INVOICE_ID, amountCentavos: 10000 },
      ],
      advanceCreditCentavos: 50000,
      reason: REASON,
    },
    ...overrides,
  };
}

function auditWrites(): Array<Record<string, unknown>> {
  return fakeDatabase.insertedRows
    .filter((row) => row.table === auditLogs)
    .map((row) => row.values as Record<string, unknown>);
}

describe("manual allocation (S3-5)", () => {
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

  it("directs a payment at the chosen invoices and audits the reason with the split", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([{ id: SERVICE_ACCOUNT_ID }]); // service account
    fakeDatabase.queueSelectRows([OLDEST_INVOICE, NEWEST_INVOICE]); // outstanding invoices
    fakeDatabase.queueSelectRows([]); // existing receipt numbers
    fakeDatabase.queueInsertRows([
      {
        id: PAYMENT_ID,
        receiptNumber: "OR-2025-000001",
        serviceAccountId: SERVICE_ACCOUNT_ID,
        paymentMethod: "cash",
        status: "posted",
        amountCentavos: 100000,
        allocatedCentavos: 50000,
        advanceCreditCentavos: 50000,
        paymentDate: "2025-03-01",
        notes: null,
        postedAt: new Date(),
        postedBy: CASHIER_ID,
        reversedAt: null,
        reversedBy: null,
      },
    ]); // the payment row
    fakeDatabase.queueInsertRows([]); // allocation bridge rows
    fakeDatabase.queueSelectRows([{ balanceCentavos: 0 }]); // ledger balance
    fakeDatabase.queueInsertRows([]); // ledger entries

    const response = await server.inject({
      method: "POST",
      url: "/api/payments/manual-allocation",
      headers: authorizationHeader(token),
      payload: body(),
    });

    expect(response.statusCode).toBe(201);

    // The operator's order and amounts were used, not the oldest-first sweep (which
    // would have put 50000 on the oldest invoice).
    expect(response.json().data.allocations).toEqual([
      { invoiceId: NEWEST_INVOICE_ID, amountCentavos: 40000 },
      { invoiceId: OLDEST_INVOICE_ID, amountCentavos: 10000 },
    ]);
    expect(response.json().data.allocatedCentavos).toBe(50000);
    expect(response.json().data.advanceCreditCentavos).toBe(50000);

    // The invariant holds: every centavo is allocated or declared as credit.
    const paymentValues = fakeDatabase.insertedRows.find((row) => row.table === payments)?.values;
    expect(paymentValues).toMatchObject({ allocatedCentavos: 50000, advanceCreditCentavos: 50000 });

    const allocationRows = fakeDatabase.insertedRows.find(
      (row) => row.table === paymentAllocations
    )?.values as Array<Record<string, unknown>>;
    expect(allocationRows).toEqual([
      { paymentId: PAYMENT_ID, invoiceId: NEWEST_INVOICE_ID, allocatedAmountCentavos: 40000 },
      { paymentId: PAYMENT_ID, invoiceId: OLDEST_INVOICE_ID, allocatedAmountCentavos: 10000 },
    ]);
    expect(
      allocationRows.reduce((sum, row) => sum + (row.allocatedAmountCentavos as number), 0)
    ).toBe(50000);

    // Both invoices moved by exactly what was chosen.
    const invoiceUpdates = fakeDatabase.updatedRows
      .filter((row) => row.table === invoices)
      .map((row) => row.values as Record<string, unknown>);
    expect(invoiceUpdates).toContainEqual(
      expect.objectContaining({ remainingBalanceCentavos: 40000, status: "partially_paid" })
    );
    expect(invoiceUpdates).toContainEqual(
      expect.objectContaining({ remainingBalanceCentavos: 40000, status: "partially_paid" })
    );

    // The allocation is audited with its actor and its reason.
    const postedAudit = auditWrites().find((row) => row.action === "payment.posted");
    expect(postedAudit).toMatchObject({ entityId: PAYMENT_ID, performedBy: CASHIER_ID });
    expect(postedAudit?.newState).toMatchObject({
      manualAllocation: {
        reason: REASON,
        allocations: [
          { invoiceId: NEWEST_INVOICE_ID, amountCentavos: 40000 },
          { invoiceId: OLDEST_INVOICE_ID, amountCentavos: 10000 },
        ],
      },
    });

    const ledgerRows = fakeDatabase.insertedRows
      .filter((row) => row.table === ledgerEntries)
      .flatMap((row) => row.values as Array<Record<string, unknown>>);
    expect(ledgerRows.map((row) => row.entryType)).toEqual([
      "payment_received",
      "advance_credit",
    ]);
  });

  it("refuses a manual split that under-allocates (centavos left unaccounted for)", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([{ id: SERVICE_ACCOUNT_ID }]);
    fakeDatabase.queueSelectRows([OLDEST_INVOICE, NEWEST_INVOICE]);

    const response = await server.inject({
      method: "POST",
      url: "/api/payments/manual-allocation",
      headers: authorizationHeader(token),
      payload: body({
        manualAllocation: {
          allocations: [{ invoiceId: OLDEST_INVOICE_ID, amountCentavos: 10000 }],
          advanceCreditCentavos: 0, // 100000 received, only 10000 accounted for
          reason: REASON,
        },
      }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
    expect(response.json().error.message).toContain("every centavo must be allocated");
    expect(fakeDatabase.insertedRows.filter((row) => row.table === payments)).toHaveLength(0);
    expect(fakeDatabase.updatedRows.filter((row) => row.table === invoices)).toHaveLength(0);
  });

  it("refuses a manual split that over-allocates (more than the payment)", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([{ id: SERVICE_ACCOUNT_ID }]);
    fakeDatabase.queueSelectRows([OLDEST_INVOICE, NEWEST_INVOICE]);

    const response = await server.inject({
      method: "POST",
      url: "/api/payments/manual-allocation",
      headers: authorizationHeader(token),
      payload: body({
        manualAllocation: {
          allocations: [
            { invoiceId: OLDEST_INVOICE_ID, amountCentavos: 50000 },
            { invoiceId: NEWEST_INVOICE_ID, amountCentavos: 80000 },
          ],
          advanceCreditCentavos: 0, // 130000 allocated against a 100000 payment
          reason: REASON,
        },
      }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("every centavo must be allocated");
    expect(fakeDatabase.insertedRows.filter((row) => row.table === payments)).toHaveLength(0);
  });

  it("refuses an allocation larger than the invoice still owes", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([{ id: SERVICE_ACCOUNT_ID }]);
    fakeDatabase.queueSelectRows([OLDEST_INVOICE, NEWEST_INVOICE]);

    const response = await server.inject({
      method: "POST",
      url: "/api/payments/manual-allocation",
      headers: authorizationHeader(token),
      payload: body({
        manualAllocation: {
          allocations: [{ invoiceId: OLDEST_INVOICE_ID, amountCentavos: 60000 }],
          advanceCreditCentavos: 40000,
          reason: REASON,
        },
      }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("would over-allocate it");
    expect(fakeDatabase.updatedRows).toHaveLength(0);
  });

  it("refuses an invoice that is not outstanding for this account, and one named twice", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });
    const headers = authorizationHeader(token);

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([{ id: SERVICE_ACCOUNT_ID }]);
    fakeDatabase.queueSelectRows([OLDEST_INVOICE]);

    const unknownInvoice = await server.inject({
      method: "POST",
      url: "/api/payments/manual-allocation",
      headers,
      payload: body({
        manualAllocation: {
          allocations: [{ invoiceId: randomUUID(), amountCentavos: 100000 }],
          advanceCreditCentavos: 0,
          reason: REASON,
        },
      }),
    });
    expect(unknownInvoice.statusCode).toBe(400);
    expect(unknownInvoice.json().error.message).toContain("not an outstanding invoice");

    fakeDatabase.reset();
    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([{ id: SERVICE_ACCOUNT_ID }]);
    fakeDatabase.queueSelectRows([OLDEST_INVOICE]);

    const twice = await server.inject({
      method: "POST",
      url: "/api/payments/manual-allocation",
      headers,
      payload: body({
        manualAllocation: {
          allocations: [
            { invoiceId: OLDEST_INVOICE_ID, amountCentavos: 25000 },
            { invoiceId: OLDEST_INVOICE_ID, amountCentavos: 25000 },
          ],
          advanceCreditCentavos: 50000,
          reason: REASON,
        },
      }),
    });
    expect(twice.statusCode).toBe(400);
    expect(twice.json().error.message).toContain("chosen more than once");
  });

  it("refuses a manual allocation without a reason", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });
    fakeDatabase.queueSelectRows([]); // authenticate only

    const response = await server.inject({
      method: "POST",
      url: "/api/payments/manual-allocation",
      headers: authorizationHeader(token),
      payload: body({
        manualAllocation: {
          allocations: [{ invoiceId: OLDEST_INVOICE_ID, amountCentavos: 100000 }],
          advanceCreditCentavos: 0,
          reason: "short",
        },
      }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("refuses manual allocation to a role without the permission", async () => {
    const { token } = signTestToken({ role: "collector", sub: randomUUID() });
    fakeDatabase.queueSelectRows([]); // authenticate only

    const response = await server.inject({
      method: "POST",
      url: "/api/payments/manual-allocation",
      headers: authorizationHeader(token),
      payload: body(),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
    expect(fakeDatabase.insertedRows).toHaveLength(0);
  });

  it("refuses a GCash payment here: its split is applied when a verifier confirms it", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });
    fakeDatabase.queueSelectRows([]); // authenticate only

    const response = await server.inject({
      method: "POST",
      url: "/api/payments/manual-allocation",
      headers: authorizationHeader(token),
      payload: body({ paymentMethod: "gcash" }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
    expect(fakeDatabase.insertedRows).toHaveLength(0);
  });

  it("holds the allocation invariant for every accepted split", () => {
    const invoices = [OLDEST_INVOICE, NEWEST_INVOICE];

    const built = buildManualAllocation(
      100000,
      {
        allocations: [
          { invoiceId: NEWEST_INVOICE_ID, amountCentavos: 40000 },
          { invoiceId: OLDEST_INVOICE_ID, amountCentavos: 10000 },
        ],
        advanceCreditCentavos: 50000,
        reason: REASON,
      },
      invoices
    );

    expect(built.allocatedCentavos + built.advanceCreditCentavos).toBe(100000);
    expect(
      built.allocations.reduce((sum, line) => sum + line.amountCentavos, 0) +
        built.advanceCreditCentavos
    ).toBe(100000);

    // Nothing chosen at all is legitimate only when the whole payment is declared
    // as advance credit — the invoice was not selected, not forgotten.
    const allCredit = buildManualAllocation(
      5000,
      { allocations: [], advanceCreditCentavos: 5000, reason: REASON },
      invoices
    );
    expect(allCredit.allocations).toEqual([]);
    expect(allCredit.advanceCreditCentavos).toBe(5000);
  });
});
