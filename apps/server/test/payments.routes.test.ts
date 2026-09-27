// Acceptance tests for Phase 5 — payment processing.
//
// They run against the real Fastify app via `app.inject()` with the database
// swapped for the in-memory stand-in, so no PostgreSQL is required. What is being
// pinned down is the financial behaviour:
//
//   • oldest-invoice-first allocation that is exhaustive to the centavo
//   • advance credit for an overpayment
//   • duplicate GCash references rejected with a 409, never a 500
//   • posting is atomic — a failure leaves no partial payment
//   • reversal is a record, never a deletion, and restores the invoice balances
//   • only a Cashier or Admin may post; only an Admin may reverse

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
import { invoices } from "../src/db/schema/billing";
import { ledgerEntries } from "../src/db/schema/ledger";
import {
  gcashPayments,
  paymentAllocations,
  paymentReversals,
  payments,
} from "../src/db/schema/payments";
import { fakeDatabase, type RecordedInsert } from "./support/fake-database";
import { authorizationHeader, signTestToken } from "./support/tokens";

const ADMIN_ID = randomUUID();
const CASHIER_ID = randomUUID();
const SERVICE_ACCOUNT_ID = randomUUID();
const PAYMENT_ID = randomUUID();

// Receipt numbers are scoped to the current calendar year, so the tests read it
// rather than hard-coding one that will age.

/** A service account row as the existence check selects it. */
function accountRow(overrides: Record<string, unknown> = {}) {
  return { id: SERVICE_ACCOUNT_ID, ...overrides };
}

/** An outstanding invoice, oldest first as the allocation query returns it. */
function outstandingInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    invoiceNumber: "INV-2025-01-000001",
    totalAmountCentavos: 99900,
    paidAmountCentavos: 0,
    remainingBalanceCentavos: 99900,
    ...overrides,
  };
}

/** The payment row returned by the insert. */
function postedPaymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    receiptNumber: "OR-2025-000001",
    serviceAccountId: SERVICE_ACCOUNT_ID,
    paymentMethod: "cash",
    status: "posted",
    amountCentavos: 99900,
    allocatedCentavos: 99900,
    advanceCreditCentavos: 0,
    paymentDate: "2025-03-01",
    notes: null,
    postedAt: new Date(),
    postedBy: ADMIN_ID,
    reversedAt: null,
    reversedBy: null,
    ...overrides,
  };
}

/** A payment row as a detail/list query returns it (subscriber and cashier joined). */
function postedSummaryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    receiptNumber: "OR-2025-000001",
    serviceAccountId: SERVICE_ACCOUNT_ID,
    serviceAccountNumber: "SA-20250101-00001",
    subscriberId: randomUUID(),
    subscriberFirstName: "Maria",
    subscriberLastName: "Santos",
    paymentMethod: "cash",
    status: "posted",
    amountCentavos: 99900,
    allocatedCentavos: 99900,
    advanceCreditCentavos: 0,
    paymentDate: "2025-03-01",
    notes: null,
    gcashReferenceNumber: null,
    postedAt: new Date(),
    postedById: ADMIN_ID,
    postedByName: "Admin User",
    reversedAt: null,
    reversedById: null,
    ...overrides,
  };
}

/** Every insert recorded against a specific table. */
function insertedInto(table: unknown): RecordedInsert[] {
  return fakeDatabase.insertedRows.filter((row) => row.table === table);
}

/** The ledger entries written, flattened from one or more insert calls. */
function ledgerWrites(): Array<Record<string, unknown>> {
  return insertedInto(ledgerEntries).flatMap((row) =>
    Array.isArray(row.values) ? (row.values as Array<Record<string, unknown>>) : [row.values as Record<string, unknown>]
  );
}

const CASH_BODY = {
  serviceAccountId: SERVICE_ACCOUNT_ID,
  paymentMethod: "cash",
  paymentDate: "2025-03-01",
};

describe("payment routes", () => {
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

  it("posts a cash payment and allocates it oldest-invoice-first", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });
    const oldest = outstandingInvoice({
      id: randomUUID(),
      totalAmountCentavos: 50000,
      remainingBalanceCentavos: 50000,
    });
    const newest = outstandingInvoice({
      id: randomUUID(),
      invoiceNumber: "INV-2025-02-000001",
      remainingBalanceCentavos: 80000,
      totalAmountCentavos: 80000,
    });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([accountRow()]); // service account exists
    fakeDatabase.queueSelectRows([oldest, newest]); // outstanding invoices, oldest first
    fakeDatabase.queueSelectRows([]); // existing receipt numbers
    fakeDatabase.queueInsertRows([postedPaymentRow({ amountCentavos: 100000, allocatedCentavos: 100000 })]);
    fakeDatabase.queueInsertRows([]); // allocation bridge rows
    fakeDatabase.queueSelectRows([{ balanceCentavos: 0 }]); // ledger balance
    fakeDatabase.queueInsertRows([]); // ledger entries

    const response = await server.inject({
      method: "POST",
      url: "/api/payments",
      headers: authorizationHeader(token),
      payload: { ...CASH_BODY, amountCentavos: 100000 },
    });

    expect(response.statusCode).toBe(201);
    const data = response.json().data;
    expect(data.allocations).toEqual([
      { invoiceId: oldest.id, amountCentavos: 50000 },
      { invoiceId: newest.id, amountCentavos: 50000 },
    ]);
    expect(data.allocatedCentavos).toBe(100000);
    expect(data.advanceCreditCentavos).toBe(0);

    // Oldest invoice settled → paid; newest still owed → partially paid.
    const updates = fakeDatabase.updatedRows.filter((row) => row.table === invoices);
    expect(updates).toHaveLength(2);
    expect(updates[0]?.values).toMatchObject({
      paidAmountCentavos: 50000,
      remainingBalanceCentavos: 0,
      status: "paid",
    });
    expect(updates[1]?.values).toMatchObject({
      paidAmountCentavos: 50000,
      remainingBalanceCentavos: 30000,
      status: "partially_paid",
    });

    // The allocation bridge records the exact split and sums to the payment amount.
    const allocations = insertedInto(paymentAllocations);
    expect(allocations).toHaveLength(1);
    const allocationRows = allocations[0]?.values as Array<Record<string, unknown>>;
    const allocationTotal = allocationRows.reduce(
      (sum, row) => sum + (row.allocatedAmountCentavos as number),
      0
    );
    expect(allocationTotal).toBe(100000);

    // One credit of exactly the amount received.
    const ledger = ledgerWrites();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      entryType: "payment_received",
      amountCentavos: 100000,
      paymentId: PAYMENT_ID,
    });
  });

  it("marks an invoice PAID when the payment covers it exactly", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });
    const invoice = outstandingInvoice({ remainingBalanceCentavos: 99900 });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([accountRow()]);
    fakeDatabase.queueSelectRows([invoice]);
    fakeDatabase.queueSelectRows([]); // receipt numbers
    fakeDatabase.queueInsertRows([postedPaymentRow({ amountCentavos: 99900, allocatedCentavos: 99900 })]);
    fakeDatabase.queueInsertRows([]); // allocations
    fakeDatabase.queueSelectRows([{ balanceCentavos: 0 }]);
    fakeDatabase.queueInsertRows([]); // ledger

    const response = await server.inject({
      method: "POST",
      url: "/api/payments",
      headers: authorizationHeader(token),
      payload: { ...CASH_BODY, amountCentavos: 99900 },
    });

    expect(response.statusCode).toBe(201);
    expect(fakeDatabase.updatedRows[0]?.values).toMatchObject({
      remainingBalanceCentavos: 0,
      status: "paid",
    });
  });

  it("turns the amount beyond every invoice into an advance credit", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });
    const invoice = outstandingInvoice({ remainingBalanceCentavos: 30000 });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([accountRow()]);
    fakeDatabase.queueSelectRows([invoice]);
    fakeDatabase.queueSelectRows([]); // receipt numbers
    fakeDatabase.queueInsertRows([postedPaymentRow({ amountCentavos: 100000, allocatedCentavos: 30000, advanceCreditCentavos: 70000 })]);
    fakeDatabase.queueInsertRows([]); // allocations
    fakeDatabase.queueSelectRows([{ balanceCentavos: 0 }]);
    fakeDatabase.queueInsertRows([]); // ledger

    const response = await server.inject({
      method: "POST",
      url: "/api/payments",
      headers: authorizationHeader(token),
      payload: { ...CASH_BODY, amountCentavos: 100000 },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data.advanceCreditCentavos).toBe(70000);

    const ledger = ledgerWrites();
    const credited = ledger.reduce((sum, row) => sum + (row.amountCentavos as number), 0);
    expect(credited).toBe(100000);
    expect(ledger.map((row) => row.entryType)).toEqual(["payment_received", "advance_credit"]);
    expect(ledger).toContainEqual(
      expect.objectContaining({ entryType: "advance_credit", amountCentavos: 70000 })
    );
  });

  it("rejects a duplicate GCash reference number with a 409, not a 500", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([accountRow()]);
    fakeDatabase.queueSelectRows([{ id: randomUUID() }]); // reference already used

    const response = await server.inject({
      method: "POST",
      url: "/api/payments",
      headers: authorizationHeader(token),
      payload: {
        ...CASH_BODY,
        paymentMethod: "gcash",
        amountCentavos: 99900,
        gcash: { referenceNumber: "GCASH-DUP-001" },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONFLICT");
    expect(response.json().error.message).toContain("already been used");
    // Nothing was written.
    expect(insertedInto(payments)).toHaveLength(0);
    expect(insertedInto(gcashPayments)).toHaveLength(0);
  });

  it("records a GCash payment as PENDING_VERIFICATION without moving any balance", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([accountRow()]);
    fakeDatabase.queueSelectRows([]); // reference unused
    fakeDatabase.queueSelectRows([]); // existing receipt numbers
    fakeDatabase.queueInsertRows([
      postedPaymentRow({
        paymentMethod: "gcash",
        status: "pending_verification",
        amountCentavos: 50000,
        allocatedCentavos: 0,
        advanceCreditCentavos: 0,
      }),
    ]); // the payment row
    fakeDatabase.queueInsertRows([
      { id: randomUUID(), paymentId: PAYMENT_ID, gcashReferenceNumber: "GCASH-OK-001" },
    ]); // gcash details

    const response = await server.inject({
      method: "POST",
      url: "/api/payments",
      headers: authorizationHeader(token),
      payload: {
        ...CASH_BODY,
        paymentMethod: "gcash",
        amountCentavos: 50000,
        gcash: { referenceNumber: "GCASH-OK-001", senderName: "Maria Santos" },
      },
    });

    expect(response.statusCode).toBe(201);

    // The claim is recorded with its proof…
    const gcash = insertedInto(gcashPayments);
    expect(gcash).toHaveLength(1);
    expect(gcash[0]?.values).toMatchObject({
      paymentId: PAYMENT_ID,
      gcashReferenceNumber: "GCASH-OK-001",
      senderName: "Maria Santos",
    });

    // …and nothing else moved: no invoice balance, no allocation, no ledger entry.
    expect(insertedInto(payments)[0]?.values).toMatchObject({
      status: "pending_verification",
      allocatedCentavos: 0,
      advanceCreditCentavos: 0,
    });
    expect(insertedInto(paymentAllocations)).toHaveLength(0);
    expect(fakeDatabase.updatedRows.filter((row) => row.table === invoices)).toHaveLength(0);
    expect(insertedInto(ledgerEntries)).toHaveLength(0);
  });

  it("blocks a duplicate GCash reference however it is formatted (S12-7)", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([accountRow()]);
    fakeDatabase.queueSelectRows([{ id: randomUUID() }]); // the normalized reference exists

    const response = await server.inject({
      method: "POST",
      url: "/api/payments",
      headers: authorizationHeader(token),
      payload: {
        ...CASH_BODY,
        paymentMethod: "gcash",
        amountCentavos: 50000,
        gcash: { referenceNumber: "  gcash-ok-001  " },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONFLICT");
    expect(insertedInto(payments)).toHaveLength(0);
    expect(insertedInto(gcashPayments)).toHaveLength(0);
  });

  it("issues receipt numbers in OR-YYYY-XXXXXX format, one past the highest existing", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });
    const year = new Date().getFullYear();
    const existingReceipt = `OR-${year}-000041`;
    const expectedReceipt = `OR-${year}-000042`;

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([accountRow()]);
    fakeDatabase.queueSelectRows([]); // outstanding invoices (nothing owed)
    fakeDatabase.queueSelectRows([{ receiptNumber: existingReceipt }]); // existing receipts
    fakeDatabase.queueInsertRows([
      postedPaymentRow({ receiptNumber: expectedReceipt, amountCentavos: 5000, allocatedCentavos: 0, advanceCreditCentavos: 5000 }),
    ]);
    fakeDatabase.queueSelectRows([{ balanceCentavos: 0 }]);
    fakeDatabase.queueInsertRows([]); // ledger

    const response = await server.inject({
      method: "POST",
      url: "/api/payments",
      headers: authorizationHeader(token),
      payload: { ...CASH_BODY, amountCentavos: 5000 },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data.payment.receiptNumber).toBe(expectedReceipt);
    expect(insertedInto(payments)[0]?.values).toMatchObject({ receiptNumber: expectedReceipt });
  });

  it("leaves no partial payment when a write fails partway through the transaction", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });
    const invoice = outstandingInvoice({ remainingBalanceCentavos: 99900 });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([accountRow()]);
    fakeDatabase.queueSelectRows([invoice]);
    fakeDatabase.queueSelectRows([]); // receipt numbers
    fakeDatabase.failNextInsert(new Error("simulated write failure")); // the payment insert fails

    const response = await server.inject({
      method: "POST",
      url: "/api/payments",
      headers: authorizationHeader(token),
      payload: { ...CASH_BODY, amountCentavos: 99900 },
    });

    expect(response.statusCode).toBe(500);
    // The whole transaction rolled back: no payment, and no invoice was touched.
    expect(insertedInto(payments)).toHaveLength(0);
    expect(fakeDatabase.updatedRows.filter((row) => row.table === invoices)).toHaveLength(0);
    expect(insertedInto(ledgerEntries)).toHaveLength(0);
  });

  it("refuses to post a payment for a Collector", async () => {
    const { token } = signTestToken({ role: "collector", sub: randomUUID() });
    fakeDatabase.queueSelectRows([]); // authenticate only

    const response = await server.inject({
      method: "POST",
      url: "/api/payments",
      headers: authorizationHeader(token),
      payload: { ...CASH_BODY, amountCentavos: 99900 },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
    expect(insertedInto(payments)).toHaveLength(0);
  });

  it("reverses a payment: the original row is kept, a reversal is recorded, a debit cancels the credit", async () => {
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID });
    const invoiceId = randomUUID();
    const year = new Date().getFullYear();
    const expectedReversalReceipt = `RV-${year}-000001`;
    const originalPayment = postedPaymentRow({
      status: "posted",
      amountCentavos: 100000,
      allocatedCentavos: 100000,
      advanceCreditCentavos: 0,
    });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([originalPayment]); // payment FOR UPDATE
    fakeDatabase.queueSelectRows([{ invoiceId, allocatedAmountCentavos: 100000 }]); // allocations
    fakeDatabase.queueSelectRows([
      { id: invoiceId, totalAmountCentavos: 99900, paidAmountCentavos: 100000 },
    ]); // invoice FOR UPDATE
    fakeDatabase.queueSelectRows([]); // existing reversal receipts
    fakeDatabase.queueInsertRows([]); // reversal record
    fakeDatabase.queueSelectRows([{ balanceCentavos: 0 }]); // ledger balance
    fakeDatabase.queueInsertRows([]); // ledger debit

    const response = await server.inject({
      method: "POST",
      url: `/api/payments/${PAYMENT_ID}/reverse`,
      headers: authorizationHeader(token),
      payload: { reason: "Wrong account credited at the counter" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.reversalReceiptNumber).toBe(expectedReversalReceipt);

    // The original payment row is updated, never deleted or re-inserted.
    expect(insertedInto(payments)).toHaveLength(0);
    const paymentUpdate = fakeDatabase.updatedRows.find((row) => row.table === payments);
    expect(paymentUpdate?.values).toMatchObject({ status: "reversed" });
    expect(paymentUpdate?.values).toHaveProperty("reversedAt");

    // The invoice balance is restored: paid drops by the allocation, remaining returns.
    const invoiceUpdate = fakeDatabase.updatedRows.find((row) => row.table === invoices);
    expect(invoiceUpdate?.values).toMatchObject({
      paidAmountCentavos: 0,
      remainingBalanceCentavos: 99900,
      status: "unpaid",
    });

    // A reversal record with a reason and an RV number.
    const reversal = insertedInto(paymentReversals);
    expect(reversal).toHaveLength(1);
    expect(reversal[0]?.values).toMatchObject({
      originalPaymentId: PAYMENT_ID,
      reversalReceiptNumber: expectedReversalReceipt,
      reason: "Wrong account credited at the counter",
    });

    // The debit cancels the original credit exactly.
    const ledger = ledgerWrites();
    expect(ledger).toContainEqual(
      expect.objectContaining({
        entryType: "payment_reversal",
        amountCentavos: 100000,
        paymentId: PAYMENT_ID,
      })
    );
  });

  it("refuses to reverse an already reversed payment", async () => {
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([postedPaymentRow({ status: "reversed" })]); // already reversed

    const response = await server.inject({
      method: "POST",
      url: `/api/payments/${PAYMENT_ID}/reverse`,
      headers: authorizationHeader(token),
      payload: { reason: "Trying to reverse twice" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONFLICT");
    expect(insertedInto(paymentReversals)).toHaveLength(0);
  });

  it("refuses to reverse a GCash payment that no verifier has confirmed yet (S3-6)", async () => {
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      postedPaymentRow({
        paymentMethod: "gcash",
        status: "pending_verification",
        allocatedCentavos: 0,
        advanceCreditCentavos: 0,
      }),
    ]); // the claim is still awaiting a verifier

    const response = await server.inject({
      method: "POST",
      url: `/api/payments/${PAYMENT_ID}/reverse`,
      headers: authorizationHeader(token),
      payload: { reason: "Trying to reverse an unverified claim" },
    });

    // A pending GCash payment posted nothing, so a reversal has no credit to cancel.
    // The refusal names the workflow step that does apply, rather than inventing a
    // debit or leaving the row in a half-reversed state.
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONFLICT");
    expect(response.json().error.message).toContain("Reject it instead");
    expect(insertedInto(paymentReversals)).toHaveLength(0);
    expect(insertedInto(ledgerEntries)).toHaveLength(0);
    expect(fakeDatabase.updatedRows.filter((row) => row.table === payments)).toHaveLength(0);
  });

  it("refuses to reverse a GCash payment a verifier rejected (S3-6)", async () => {
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      postedPaymentRow({
        paymentMethod: "gcash",
        status: "rejected",
        allocatedCentavos: 0,
        advanceCreditCentavos: 0,
      }),
    ]);

    const response = await server.inject({
      method: "POST",
      url: `/api/payments/${PAYMENT_ID}/reverse`,
      headers: authorizationHeader(token),
      payload: { reason: "Trying to reverse a rejected claim" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONFLICT");
    expect(insertedInto(paymentReversals)).toHaveLength(0);
  });

  it("reverses a verified GCash payment: it stops reading as verified-and-posted (S3-6)", async () => {
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID });
    const invoiceId = randomUUID();
    const verifiedPayment = postedPaymentRow({
      paymentMethod: "gcash",
      status: "posted",
      amountCentavos: 50000,
      allocatedCentavos: 50000,
      advanceCreditCentavos: 0,
    });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([verifiedPayment]); // payment FOR UPDATE
    fakeDatabase.queueSelectRows([{ invoiceId, allocatedAmountCentavos: 50000 }]); // allocations
    fakeDatabase.queueSelectRows([
      { id: invoiceId, totalAmountCentavos: 50000, paidAmountCentavos: 50000 },
    ]); // invoice FOR UPDATE
    fakeDatabase.queueSelectRows([]); // existing reversal receipts
    fakeDatabase.queueInsertRows([]); // reversal record
    fakeDatabase.queueSelectRows([{ balanceCentavos: 0 }]); // ledger balance
    fakeDatabase.queueInsertRows([]); // ledger debit

    const response = await server.inject({
      method: "POST",
      url: `/api/payments/${PAYMENT_ID}/reverse`,
      headers: authorizationHeader(token),
      payload: { reason: "Transfer was recalled by the sender" },
    });

    expect(response.statusCode).toBe(200);

    // The status is the one authority on whether the money counts, so a reversed
    // payment cannot still read as verified-and-posted: `gcashVerificationStatus`
    // reports `reversed` for it (asserted directly in the GCash suite).
    expect(fakeDatabase.updatedRows.find((row) => row.table === payments)?.values).toMatchObject({
      status: "reversed",
      reversedBy: ADMIN_ID,
    });

    // The verification detail row is left alone on purpose: who confirmed the
    // transfer and when is provenance the audit trail must keep.
    expect(fakeDatabase.updatedRows.filter((row) => row.table === gcashPayments)).toHaveLength(0);

    // The invoice is restored and the debit cancels the credit exactly.
    expect(fakeDatabase.updatedRows.find((row) => row.table === invoices)?.values).toMatchObject({
      paidAmountCentavos: 0,
      remainingBalanceCentavos: 50000,
      status: "unpaid",
    });
    expect(ledgerWrites()).toContainEqual(
      expect.objectContaining({ entryType: "payment_reversal", amountCentavos: 50000 })
    );
  });

  it("refuses to reverse a payment for a Cashier", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });
    fakeDatabase.queueSelectRows([]); // authenticate only

    const response = await server.inject({
      method: "POST",
      url: `/api/payments/${PAYMENT_ID}/reverse`,
      headers: authorizationHeader(token),
      payload: { reason: "Should not be allowed" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
  });

  it("rejects a reversal reason shorter than 10 characters", async () => {
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID });
    fakeDatabase.queueSelectRows([]); // authenticate

    const response = await server.inject({
      method: "POST",
      url: `/api/payments/${PAYMENT_ID}/reverse`,
      headers: authorizationHeader(token),
      payload: { reason: "too short" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
    expect(insertedInto(paymentReversals)).toHaveLength(0);
  });

  it("lists payments for the history screen", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      {
        id: PAYMENT_ID,
        receiptNumber: "OR-2025-000001",
        serviceAccountId: SERVICE_ACCOUNT_ID,
        serviceAccountNumber: "SA-20250101-00001",
        subscriberId: randomUUID(),
        subscriberFirstName: "Maria",
        subscriberLastName: "Santos",
        paymentMethod: "cash",
        status: "posted",
        amountCentavos: 99900,
        allocatedCentavos: 99900,
        advanceCreditCentavos: 0,
        paymentDate: "2025-03-01",
        notes: null,
        gcashReferenceNumber: null,
        postedAt: new Date(),
        postedById: ADMIN_ID,
        postedByName: "Admin User",
        reversedAt: null,
        reversedById: null,
      },
    ]);

    const response = await server.inject({
      method: "GET",
      url: "/api/payments",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    const items = response.json().data.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ receiptNumber: "OR-2025-000001", subscriberName: "Santos, Maria" });
  });

  it("keeps reversed payments in the history", async () => {
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      postedSummaryRow({ status: "reversed", reversedAt: new Date(), reversedById: ADMIN_ID }),
    ]); // a reversed payment is still returned

    const response = await server.inject({
      method: "GET",
      url: "/api/payments",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    const items = response.json().data.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ status: "reversed", receiptNumber: "OR-2025-000001" });
  });

  it("looks a payment up by its receipt number", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([postedSummaryRow()]); // payment by receipt
    fakeDatabase.queueSelectRows([]); // allocations
    fakeDatabase.queueSelectRows([]); // gcash details

    const response = await server.inject({
      method: "GET",
      url: "/api/payments/receipt/OR-2025-000001",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      receiptNumber: "OR-2025-000001",
      subscriberName: "Santos, Maria",
      allocations: [],
      gcash: null,
    });
  });

  it("reports the outstanding invoices and advance credit for a service account", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      {
        id: randomUUID(),
        invoiceNumber: "INV-2025-01-000001",
        invoiceDate: "2025-01-01",
        dueDate: "2025-01-15",
        status: "posted",
        totalAmountCentavos: 99900,
        paidAmountCentavos: 0,
        remainingBalanceCentavos: 99900,
      },
    ]); // outstanding invoices
    fakeDatabase.queueSelectRows([{ balanceCentavos: -5000 }]); // ledger shows an advance credit

    const response = await server.inject({
      method: "GET",
      url: `/api/service-accounts/${SERVICE_ACCOUNT_ID}/payment-summary`,
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      outstandingTotalCentavos: 99900,
      creditBalanceCentavos: 5000,
    });
  });
});
