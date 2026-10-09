// S3-1 — the five payment methods, end to end.
//
// Section 3.6 requires Cash, GCash, Bank Transfer, Cheque and Other, and the audit
// found that only two of the five could be recorded at all: `PAYMENT_METHODS` was
// missing "Other" and `POSTABLE_PAYMENT_METHODS` restricted posting to cash and
// GCash. These tests pin the whole path — the shared vocabulary, the request, the
// allocation, the receipt and the ledger credit — for every one of the five.
//
// GCash is the one method that is posted by a verifier rather than at the counter,
// so its case records the claim and then verifies it; see the GCash verification
// suite for the workflow itself.

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import {
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  POSTABLE_PAYMENT_METHODS,
  type PaymentMethod,
} from "@bcis/shared";

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
import { gcashPayments, paymentAllocations, payments } from "../src/db/schema/payments";
import { summarizePayments } from "../src/modules/reports/daily-collection.service.ts";
import { fakeDatabase } from "./support/fake-database";
import { authorizationHeader, signTestToken } from "./support/tokens";

const CASHIER_ID = randomUUID();
const SERVICE_ACCOUNT_ID = randomUUID();
const PAYMENT_ID = randomUUID();
const INVOICE_ID = randomUUID();

/** The five methods section 3.6 names, in shared-vocabulary order. */
const FIVE_METHODS = ["cash", "gcash", "bank_transfer", "check", "other"] as const;

const CASH_LIKE_METHODS = ["cash", "bank_transfer", "check", "other"] as const;

const PAYMENT_AMOUNT_CENTAVOS = 50000;

function accountRow() {
  return { id: SERVICE_ACCOUNT_ID };
}

function outstandingInvoice() {
  return {
    id: INVOICE_ID,
    invoiceNumber: "INV-2025-01-000001",
    totalAmountCentavos: PAYMENT_AMOUNT_CENTAVOS,
    paidAmountCentavos: 0,
    remainingBalanceCentavos: PAYMENT_AMOUNT_CENTAVOS,
  };
}

function paymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    receiptNumber: "OR-2025-000001",
    serviceAccountId: SERVICE_ACCOUNT_ID,
    paymentMethod: "cash",
    status: "posted",
    amountCentavos: PAYMENT_AMOUNT_CENTAVOS,
    allocatedCentavos: PAYMENT_AMOUNT_CENTAVOS,
    advanceCreditCentavos: 0,
    paymentDate: "2025-03-01",
    notes: null,
    postedAt: new Date(),
    postedBy: CASHIER_ID,
    reversedAt: null,
    reversedBy: null,
    ...overrides,
  };
}

describe("the five payment methods (S3-1)", () => {
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

  it("opens every method section 3.6 requires, each with a label", () => {
    expect(PAYMENT_METHODS).toEqual(FIVE_METHODS);
    // The posting restriction that blocked bank transfer and cheque is gone.
    expect(POSTABLE_PAYMENT_METHODS).toEqual(FIVE_METHODS);

    for (const method of FIVE_METHODS) {
      expect(PAYMENT_METHOD_LABELS[method as PaymentMethod].length).toBeGreaterThan(0);
    }
    expect(PAYMENT_METHOD_LABELS.check).toBe("Cheque");
  });

  it.each(CASH_LIKE_METHODS)(
    "posts a %s payment, allocates it and credits the ledger",
    async (paymentMethod) => {
      const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });

      fakeDatabase.queueSelectRows([]); // authenticate
      fakeDatabase.queueSelectRows([accountRow()]); // service account exists
      fakeDatabase.queueSelectRows([outstandingInvoice()]); // outstanding invoices
      fakeDatabase.queueSelectRows([]); // existing receipt numbers
      fakeDatabase.queueInsertRows([
        paymentRow({ paymentMethod, status: "posted" }),
      ]); // the payment row
      fakeDatabase.queueInsertRows([]); // allocation bridge rows
      fakeDatabase.queueSelectRows([{ balanceCentavos: 0 }]); // ledger balance
      fakeDatabase.queueInsertRows([]); // ledger entries

      const response = await server.inject({
        method: "POST",
        url: "/api/payments",
        headers: authorizationHeader(token),
        payload: {
          serviceAccountId: SERVICE_ACCOUNT_ID,
          paymentMethod,
          amountCentavos: PAYMENT_AMOUNT_CENTAVOS,
          paymentDate: "2025-03-01",
        },
      });

      expect(response.statusCode).toBe(201);

      // Recorded with its own method, posted, and allocated to the only invoice.
      expect(fakeDatabase.insertedRows.find((row) => row.table === payments)?.values).toMatchObject(
        { paymentMethod }
      );
      expect(response.json().data.payment.status).toBe("posted");
      expect(response.json().data.allocations).toEqual([
        {
          invoiceId: INVOICE_ID,
          invoiceNumber: "INV-2025-01-000001",
          allocatedAmountCentavos: PAYMENT_AMOUNT_CENTAVOS,
        },
      ]);

      const allocationRows = fakeDatabase.insertedRows.find(
        (row) => row.table === paymentAllocations
      )?.values as Array<Record<string, unknown>>;
      expect(allocationRows).toHaveLength(1);
      expect(allocationRows[0]).toMatchObject({
        invoiceId: INVOICE_ID,
        allocatedAmountCentavos: PAYMENT_AMOUNT_CENTAVOS,
      });

      // The invoice is settled and one credit of the full amount was written.
      expect(fakeDatabase.updatedRows.find((row) => row.table === invoices)?.values).toMatchObject({
        paidAmountCentavos: PAYMENT_AMOUNT_CENTAVOS,
        remainingBalanceCentavos: 0,
        status: "paid",
      });

      const ledgerRows = fakeDatabase.insertedRows
        .filter((row) => row.table === ledgerEntries)
        .flatMap((row) => row.values as Array<Record<string, unknown>>);
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]).toMatchObject({
        entryType: "payment_received",
        amountCentavos: PAYMENT_AMOUNT_CENTAVOS,
      });
    }
  );

  it("posts a GCash payment on verification and allocates it there", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });

    // Step 1 — record the claim.
    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([accountRow()]);
    fakeDatabase.queueSelectRows([]); // reference unused
    fakeDatabase.queueSelectRows([]); // receipt numbers
    fakeDatabase.queueInsertRows([
      paymentRow({
        paymentMethod: "gcash",
        status: "pending_verification",
        allocatedCentavos: 0,
        advanceCreditCentavos: 0,
      }),
    ]);
    fakeDatabase.queueInsertRows([
      { id: randomUUID(), paymentId: PAYMENT_ID, gcashReferenceNumber: "GCASH-METHODS-1" },
    ]);

    const recorded = await server.inject({
      method: "POST",
      url: "/api/payments",
      headers: authorizationHeader(token),
      payload: {
        serviceAccountId: SERVICE_ACCOUNT_ID,
        paymentMethod: "gcash",
        amountCentavos: PAYMENT_AMOUNT_CENTAVOS,
        paymentDate: "2025-03-01",
        gcash: { referenceNumber: "GCASH-METHODS-1" },
      },
    });
    expect(recorded.statusCode).toBe(201);
    expect(recorded.json().data.payment.status).toBe("pending_verification");

    fakeDatabase.reset();

    // Step 2 — a verifier confirms it, which is when it posts.
    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      paymentRow({
        paymentMethod: "gcash",
        status: "pending_verification",
        allocatedCentavos: 0,
        advanceCreditCentavos: 0,
      }),
    ]); // the pending payment, locked FOR UPDATE
    fakeDatabase.queueSelectRows([
      { id: randomUUID(), paymentId: PAYMENT_ID, gcashReferenceNumber: "GCASH-METHODS-1" },
    ]); // GCash details
    fakeDatabase.queueSelectRows([outstandingInvoice()]); // outstanding invoices
    fakeDatabase.queueSelectRows([{ balanceCentavos: 0 }]); // ledger balance
    fakeDatabase.queueInsertRows([]); // ledger entries

    const verified = await server.inject({
      method: "POST",
      url: `/api/payments/gcash/${PAYMENT_ID}/verify`,
      headers: authorizationHeader(token),
      payload: {},
    });

    expect(verified.statusCode).toBe(200);
    expect(verified.json().data.payment).toMatchObject({
      paymentMethod: "gcash",
      status: "posted",
    });
    expect(verified.json().data.allocations).toEqual([
      {
        invoiceId: INVOICE_ID,
        invoiceNumber: "INV-2025-01-000001",
        allocatedAmountCentavos: PAYMENT_AMOUNT_CENTAVOS,
      },
    ]);
    expect(fakeDatabase.updatedRows.find((row) => row.table === invoices)?.values).toMatchObject({
      remainingBalanceCentavos: 0,
      status: "paid",
    });
    const ledgerRows = fakeDatabase.insertedRows
      .filter((row) => row.table === ledgerEntries)
      .flatMap((row) => row.values as Array<Record<string, unknown>>);
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]).toMatchObject({
      entryType: "payment_received",
      amountCentavos: PAYMENT_AMOUNT_CENTAVOS,
    });
  });

  it("counts every method in the day's totals, and only posted payments", () => {
    const totals = summarizePayments([
      { status: "posted", paymentMethod: "cash", amountCentavos: 10000 },
      { status: "posted", paymentMethod: "bank_transfer", amountCentavos: 20000 },
      { status: "posted", paymentMethod: "check", amountCentavos: 30000 },
      { status: "posted", paymentMethod: "other", amountCentavos: 40000 },
      { status: "posted", paymentMethod: "gcash", amountCentavos: 50000 },
      // Not money received yet — a claim awaiting a verifier.
      { status: "pending_verification", paymentMethod: "gcash", amountCentavos: 60000 },
      // Refused by a verifier.
      { status: "rejected", paymentMethod: "gcash", amountCentavos: 70000 },
      // Corrected by a reversal.
      { status: "reversed", paymentMethod: "cash", amountCentavos: 80000 },
    ]);

    expect(totals.grandTotalCentavos).toBe(150000);
    expect(totals.paymentCount).toBe(5);
    expect(totals.cashTotalCentavos).toBe(10000);
    expect(totals.gcashTotalCentavos).toBe(50000);
    // Bank transfer, cheque and "other" are inside the grand total but outside the
    // two drawers a cashier counts — see docs/technical/README.md.
    expect(totals.grandTotalCentavos - totals.cashTotalCentavos - totals.gcashTotalCentavos).toBe(
      90000
    );
  });

  it("keeps a GCash payment out of the day's totals until it is verified", () => {
    const pending = summarizePayments([
      { status: "pending_verification", paymentMethod: "gcash", amountCentavos: 12345 },
    ]);
    expect(pending.grandTotalCentavos).toBe(0);
    expect(pending.gcashTotalCentavos).toBe(0);
    expect(pending.paymentCount).toBe(0);

    const verified = summarizePayments([
      { status: "posted", paymentMethod: "gcash", amountCentavos: 12345 },
    ]);
    expect(verified.grandTotalCentavos).toBe(12345);
    expect(verified.gcashTotalCentavos).toBe(12345);
  });

  it("stores the GCash reference normalized when the payment is recorded", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([accountRow()]);
    fakeDatabase.queueSelectRows([]); // reference unused
    fakeDatabase.queueSelectRows([]); // receipt numbers
    fakeDatabase.queueInsertRows([
      paymentRow({ paymentMethod: "gcash", status: "pending_verification" }),
    ]);
    fakeDatabase.queueInsertRows([
      { id: randomUUID(), paymentId: PAYMENT_ID, gcashReferenceNumber: "0031234567ABC" },
    ]); // gcash details

    const response = await server.inject({
      method: "POST",
      url: "/api/payments",
      headers: authorizationHeader(token),
      payload: {
        serviceAccountId: SERVICE_ACCOUNT_ID,
        paymentMethod: "gcash",
        amountCentavos: 1000,
        paymentDate: "2025-03-01",
        gcash: { referenceNumber: "  0031 234 567abc  " },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(
      fakeDatabase.insertedRows.find((row) => row.table === gcashPayments)?.values
    ).toMatchObject({ gcashReferenceNumber: "0031234567ABC" });
  });
});
