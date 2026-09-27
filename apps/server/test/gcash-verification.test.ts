// S3-2, S3-3, S12-7 — the GCash verification workflow.
//
// Section 3.7 splits a GCash payment in two: staff record the transfer, and an
// authorized person confirms it. The audit found the columns `verified_at` /
// `verified_by` existing but never written, no verify or reject endpoint, and
// `postPayment` posting GCash straight away.
//
// What is pinned down here:
//   • a recorded GCash payment moves NOTHING until a verifier confirms it;
//   • verifying posts and allocates it and writes the verifier identity+timestamp;
//   • rejecting records a mandatory reason and leaves the invoice exactly as it was;
//   • the verification queue and the verification status the screen reads;
//   • the reference is normalized before the duplicate check (S12-7).

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { PAYMENT_STATUSES, type PaymentStatus } from "@bcis/shared";

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
import { gcashPayments, paymentAllocations, payments } from "../src/db/schema/payments";
import { gcashVerificationStatus } from "../src/modules/payments/payments.service.ts";
import {
  gcashReferencesMatch,
  normalizeGcashReference,
} from "../src/modules/payments/gcash-reference.ts";
import { fakeDatabase } from "./support/fake-database";
import { authorizationHeader, signTestToken } from "./support/tokens";

const CASHIER_ID = randomUUID();
const VERIFIER_ID = randomUUID();
const SERVICE_ACCOUNT_ID = randomUUID();
const PAYMENT_ID = randomUUID();
const INVOICE_ID = randomUUID();
const REFERENCE = "GCASH-VERIFY-0001";

function accountRow() {
  return { id: SERVICE_ACCOUNT_ID };
}

function outstandingInvoice() {
  return {
    id: INVOICE_ID,
    invoiceNumber: "INV-2025-01-000001",
    totalAmountCentavos: 50000,
    paidAmountCentavos: 0,
    remainingBalanceCentavos: 50000,
  };
}

function pendingPaymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    receiptNumber: "OR-2025-000007",
    serviceAccountId: SERVICE_ACCOUNT_ID,
    paymentMethod: "gcash",
    status: "pending_verification",
    amountCentavos: 50000,
    allocatedCentavos: 0,
    advanceCreditCentavos: 0,
    paymentDate: "2025-03-01",
    notes: null,
    postedAt: new Date("2025-03-01T09:00:00Z"),
    postedBy: CASHIER_ID,
    reversedAt: null,
    reversedBy: null,
    ...overrides,
  };
}

function gcashRow(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    paymentId: PAYMENT_ID,
    gcashReferenceNumber: REFERENCE,
    senderGcashNumber: "09171234567",
    senderName: "Maria Santos",
    screenshotFilePath: "gcash/2025/03/proof.png",
    verifiedAt: null,
    verifiedBy: null,
    rejectedAt: null,
    rejectedBy: null,
    rejectionReason: null,
    ...overrides,
  };
}

/** Every audit row the fake database recorded, flattened. */
function auditWrites(): Array<Record<string, unknown>> {
  return fakeDatabase.insertedRows
    .filter((row) => row.table === auditLogs)
    .map((row) => row.values as Record<string, unknown>);
}

function invoiceUpdates(): Array<Record<string, unknown>> {
  return fakeDatabase.updatedRows
    .filter((row) => row.table === invoices)
    .map((row) => row.values as Record<string, unknown>);
}

describe("GCash verification (S3-2, S3-3)", () => {
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

  it("moves no balance, allocation or ledger entry while a GCash payment is pending", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([accountRow()]);
    fakeDatabase.queueSelectRows([]); // reference unused
    fakeDatabase.queueSelectRows([]); // receipt numbers
    fakeDatabase.queueInsertRows([pendingPaymentRow()]);
    fakeDatabase.queueInsertRows([gcashRow()]);

    const response = await server.inject({
      method: "POST",
      url: "/api/payments",
      headers: authorizationHeader(token),
      payload: {
        serviceAccountId: SERVICE_ACCOUNT_ID,
        paymentMethod: "gcash",
        amountCentavos: 50000,
        paymentDate: "2025-03-01",
        gcash: { referenceNumber: REFERENCE, senderName: "Maria Santos" },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data.payment.status).toBe("pending_verification");
    expect(response.json().data.allocatedCentavos).toBe(0);
    expect(response.json().data.advanceCreditCentavos).toBe(0);

    // The invoice was not read for allocation, changed, allocated against or ledgered.
    expect(invoiceUpdates()).toHaveLength(0);
    expect(fakeDatabase.insertedRows.filter((row) => row.table === paymentAllocations)).toHaveLength(
      0
    );
    expect(fakeDatabase.insertedRows.filter((row) => row.table === ledgerEntries)).toHaveLength(0);
  });

  it("verifies a pending GCash payment: it posts, allocates, and keeps the verifier and timestamp", async () => {
    const { token } = signTestToken({ role: "cashier", sub: VERIFIER_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([pendingPaymentRow()]); // payment FOR UPDATE
    fakeDatabase.queueSelectRows([gcashRow()]); // gcash details
    fakeDatabase.queueSelectRows([outstandingInvoice()]); // outstanding invoices
    fakeDatabase.queueSelectRows([{ balanceCentavos: 0 }]); // ledger balance
    fakeDatabase.queueInsertRows([]); // ledger entries

    const response = await server.inject({
      method: "POST",
      url: `/api/payments/gcash/${PAYMENT_ID}/verify`,
      headers: authorizationHeader(token),
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.payment.status).toBe("posted");
    expect(response.json().data.allocations).toEqual([
      { invoiceId: INVOICE_ID, amountCentavos: 50000 },
    ]);

    // The payment row is posted, not re-inserted.
    expect(fakeDatabase.insertedRows.filter((row) => row.table === payments)).toHaveLength(0);
    expect(
      fakeDatabase.updatedRows.find((row) => row.table === payments)?.values
    ).toMatchObject({ status: "posted", allocatedCentavos: 50000, advanceCreditCentavos: 0 });

    // The verifier's identity and the moment are retained on the GCash detail row.
    const gcashUpdate = fakeDatabase.updatedRows.find((row) => row.table === gcashPayments)?.values;
    expect(gcashUpdate).toMatchObject({ verifiedBy: VERIFIER_ID });
    expect(gcashUpdate?.verifiedAt).toBeInstanceOf(Date);

    // The invoice moved and the credit was written, so the money really posted.
    expect(invoiceUpdates()[0]).toMatchObject({
      paidAmountCentavos: 50000,
      remainingBalanceCentavos: 0,
      status: "paid",
    });
    const ledgerRows = fakeDatabase.insertedRows
      .filter((row) => row.table === ledgerEntries)
      .flatMap((row) => row.values as Array<Record<string, unknown>>);
    expect(ledgerRows).toContainEqual(
      expect.objectContaining({ entryType: "payment_received", amountCentavos: 50000 })
    );

    // `audit.gcashPaymentVerified` is wired, with the actor and the reference.
    expect(auditWrites()).toContainEqual(
      expect.objectContaining({
        action: "payment.gcash_verified",
        entityType: "payment",
        entityId: PAYMENT_ID,
        performedBy: VERIFIER_ID,
      })
    );
  });

  it("rejects a pending GCash payment with a reason and leaves the invoice untouched", async () => {
    const { token } = signTestToken({ role: "cashier", sub: VERIFIER_ID });
    const reason = "No matching credit appeared in the GCash wallet";

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([pendingPaymentRow()]); // payment FOR UPDATE
    fakeDatabase.queueSelectRows([gcashRow()]); // gcash details

    const response = await server.inject({
      method: "POST",
      url: `/api/payments/gcash/${PAYMENT_ID}/reject`,
      headers: authorizationHeader(token),
      payload: { reason },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.payment.status).toBe("rejected");

    // Rejection leaves no financial trace: the invoice is not touched and no money
    // is credited or allocated.
    expect(invoiceUpdates()).toHaveLength(0);
    expect(fakeDatabase.insertedRows.filter((row) => row.table === ledgerEntries)).toHaveLength(0);
    expect(fakeDatabase.insertedRows.filter((row) => row.table === paymentAllocations)).toHaveLength(
      0
    );

    // The refusal is recorded with who refused it and why.
    expect(fakeDatabase.updatedRows.find((row) => row.table === payments)?.values).toMatchObject({
      status: "rejected",
    });
    const gcashUpdate = fakeDatabase.updatedRows.find((row) => row.table === gcashPayments)?.values;
    expect(gcashUpdate).toMatchObject({
      rejectedBy: VERIFIER_ID,
      rejectionReason: reason,
    });
    expect(gcashUpdate?.rejectedAt).toBeInstanceOf(Date);
    // Nothing here claims a verification happened.
    expect(gcashUpdate).not.toHaveProperty("verifiedBy");

    // `audit.gcashPaymentRejected` is wired, and the reason is in the trail.
    const rejectionAudit = auditWrites().find(
      (row) => row.action === "payment.gcash_rejected"
    );
    expect(rejectionAudit).toMatchObject({
      entityId: PAYMENT_ID,
      performedBy: VERIFIER_ID,
    });
    expect(String(rejectionAudit?.description)).toContain(reason);
  });

  it("refuses a rejection with no reason, or one that is too short", async () => {
    const { token } = signTestToken({ role: "cashier", sub: VERIFIER_ID });
    fakeDatabase.queueSelectRows([]); // authenticate only

    for (const reason of ["", "nope"]) {
      const response = await server.inject({
        method: "POST",
        url: `/api/payments/gcash/${PAYMENT_ID}/reject`,
        headers: authorizationHeader(token),
        payload: { reason },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION_ERROR");
    }

    expect(fakeDatabase.updatedRows.filter((row) => row.table === payments)).toHaveLength(0);
    expect(auditWrites()).toHaveLength(0);
  });

  it("refuses to verify or reject a payment that is no longer awaiting a verifier", async () => {
    const { token } = signTestToken({ role: "cashier", sub: VERIFIER_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([pendingPaymentRow({ status: "posted" })]); // already verified

    const verifyAgain = await server.inject({
      method: "POST",
      url: `/api/payments/gcash/${PAYMENT_ID}/verify`,
      headers: authorizationHeader(token),
      payload: {},
    });
    expect(verifyAgain.statusCode).toBe(409);
    expect(verifyAgain.json().error.code).toBe("CONFLICT");

    fakeDatabase.reset();
    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([pendingPaymentRow({ status: "rejected" })]); // already refused

    const rejectAFinalOne = await server.inject({
      method: "POST",
      url: `/api/payments/gcash/${PAYMENT_ID}/reject`,
      headers: authorizationHeader(token),
      payload: { reason: "Trying to reject a decided payment" },
    });
    expect(rejectAFinalOne.statusCode).toBe(409);
    expect(rejectAFinalOne.json().error.code).toBe("CONFLICT");
  });

  it("refuses verification and rejection to a role without the permission", async () => {
    const { token } = signTestToken({ role: "collector", sub: randomUUID() });
    fakeDatabase.queueSelectRows([]); // authenticate only

    const verify = await server.inject({
      method: "POST",
      url: `/api/payments/gcash/${PAYMENT_ID}/verify`,
      headers: authorizationHeader(token),
      payload: {},
    });
    expect(verify.statusCode).toBe(403);
    expect(verify.json().error.code).toBe("FORBIDDEN");

    const reject = await server.inject({
      method: "POST",
      url: `/api/payments/gcash/${PAYMENT_ID}/reject`,
      headers: authorizationHeader(token),
      payload: { reason: "Should not be allowed at all" },
    });
    expect(reject.statusCode).toBe(403);
    expect(fakeDatabase.updatedRows).toHaveLength(0);
  });

  it("lists the GCash claims waiting for a verifier", async () => {
    const { token } = signTestToken({ role: "cashier", sub: VERIFIER_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      {
        paymentId: PAYMENT_ID,
        receiptNumber: "OR-2025-000007",
        serviceAccountId: SERVICE_ACCOUNT_ID,
        serviceAccountNumber: "SA-20250101-00001",
        subscriberId: randomUUID(),
        subscriberFirstName: "Maria",
        subscriberLastName: "Santos",
        amountCentavos: 50000,
        paymentDate: "2025-03-01",
        recordedAt: new Date("2025-03-01T09:00:00Z"),
        recordedByName: "Cashier User",
        referenceNumber: REFERENCE,
        senderGcashNumber: "09171234567",
        senderName: "Maria Santos",
        screenshotFilePath: "gcash/2025/03/proof.png",
      },
    ]);

    const response = await server.inject({
      method: "GET",
      url: "/api/payments/gcash/pending",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    const items = response.json().data;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      paymentId: PAYMENT_ID,
      subscriberName: "Santos, Maria",
      referenceNumber: REFERENCE,
      amountCentavos: 50000,
    });
  });

  it("reports the verification status of a GCash payment through the detail endpoint", async () => {
    const { token } = signTestToken({ role: "cashier", sub: CASHIER_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      {
        id: PAYMENT_ID,
        receiptNumber: "OR-2025-000007",
        serviceAccountId: SERVICE_ACCOUNT_ID,
        serviceAccountNumber: "SA-20250101-00001",
        subscriberId: randomUUID(),
        subscriberFirstName: "Maria",
        subscriberLastName: "Santos",
        paymentMethod: "gcash",
        status: "pending_verification",
        amountCentavos: 50000,
        allocatedCentavos: 0,
        advanceCreditCentavos: 0,
        paymentDate: "2025-03-01",
        notes: null,
        gcashReferenceNumber: REFERENCE,
        postedAt: new Date(),
        postedById: CASHIER_ID,
        postedByName: "Cashier User",
        reversedAt: null,
        reversedById: null,
      },
    ]); // payment summary
    fakeDatabase.queueSelectRows([]); // allocations
    fakeDatabase.queueSelectRows([
      // The shape `withDetail` projects, not the raw table row.
      {
        referenceNumber: REFERENCE,
        senderGcashNumber: "09171234567",
        senderName: "Maria Santos",
        screenshotFilePath: "gcash/2025/03/proof.png",
        verifiedAt: null,
        verifiedById: null,
        rejectedAt: null,
        rejectedById: null,
        rejectionReason: null,
      },
    ]); // gcash details

    const response = await server.inject({
      method: "GET",
      url: `/api/payments/${PAYMENT_ID}`,
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.gcash).toMatchObject({
      referenceNumber: REFERENCE,
      verificationStatus: "pending_verification",
    });
  });

  it("spells the stored payment status as the verification workflow's vocabulary", () => {
    // PAYMENT_STATUSES is the stored set; the GCash screen reads the derived names.
    expect(PAYMENT_STATUSES).toEqual([
      "pending_verification",
      "posted",
      "reversed",
      "rejected",
    ]);
    expect(gcashVerificationStatus("pending_verification" satisfies PaymentStatus)).toBe(
      "pending_verification"
    );
    expect(gcashVerificationStatus("posted")).toBe("verified");
    expect(gcashVerificationStatus("rejected")).toBe("rejected");
    expect(gcashVerificationStatus("reversed")).toBe("reversed");
  });
});

describe("normalized GCash references (S12-7)", () => {
  it("trims, uppercases and strips internal whitespace", () => {
    expect(normalizeGcashReference("  0031 234 567 ")).toBe("0031234567");
    expect(normalizeGcashReference("gcash-ok-001")).toBe("GCASH-OK-001");
    expect(normalizeGcashReference("GC\tASH\nOK 001")).toBe("GCASHOK001");
    expect(normalizeGcashReference("  ")).toBe("");
  });

  it("treats a reformatted reference as the same transfer", () => {
    expect(gcashReferencesMatch(" 0031 234 567 ", "0031234567")).toBe(true);
    expect(gcashReferencesMatch("GCASH-OK-001", " gcash-ok-001 ")).toBe(true);
    expect(gcashReferencesMatch("GCASH-OK-001", "GCASH-OK-002")).toBe(false);
    // Only whitespace is stripped (S12-7). A reference that differs by a visible
    // character is a different reference, and this records that deliberately.
    expect(gcashReferencesMatch("GCASH-OK-001", "GCASH OK 001")).toBe(false);
  });
});
