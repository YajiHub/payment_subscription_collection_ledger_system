// HTTP acceptance tests for the two invoice adjustments of S2-3 that had no
// route before this work package (WP2b):
//
//   POST /api/invoices/installation-fee   — charge a fee as a line item
//   POST /api/invoices/:id/discount       — discount a DRAFT invoice
//
// They run against the real Fastify app via `app.inject()` with the database
// swapped for the in-memory stand-in, so no PostgreSQL is required. What is pinned
// down here is the HTTP boundary: the validation shape (integer centavos and
// integer basis points only), the authorization guard, and the audit row — actor,
// reason and old/new totals.
//
// The money arithmetic itself (rounding, the zero floor, the ledger reflecting the
// new total) is proved against real PostgreSQL in `billing-engine.postgres.test.ts`.

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
import { invoiceLineItems, invoices } from "../src/db/schema/billing";
import { fakeDatabase, type RecordedInsert } from "./support/fake-database";
import { authorizationHeader, signTestToken } from "./support/tokens";

const ADMIN_ID = randomUUID();
const CASHIER_ID = randomUUID();
const SERVICE_ACCOUNT_ID = randomUUID();
const SUBSCRIBER_ID = randomUUID();
const INVOICE_ID = randomUUID();

/** The joined invoice row `loadInvoiceDetail` reads. */
function invoiceSummaryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    invoiceNumber: "INV-2025-01-000001",
    serviceAccountId: SERVICE_ACCOUNT_ID,
    serviceAccountNumber: "SA-20250124-00001",
    subscriberId: SUBSCRIBER_ID,
    subscriberFirstName: "Maria",
    subscriberLastName: "Santos",
    invoiceType: "installation_fee",
    status: "draft",
    billingPeriodYear: null,
    billingPeriodMonth: null,
    invoiceDate: "2025-01-01",
    dueDate: "2025-01-01",
    subtotalCentavos: 60000,
    lateFeesCentavos: 0,
    totalAmountCentavos: 60000,
    paidAmountCentavos: 0,
    remainingBalanceCentavos: 60000,
    notes: null,
    voidedByTransactionId: null,
    createdAt: new Date(),
    postedAt: null,
    voidedAt: null,
    ...overrides,
  };
}

function installationFeeLineItemRow() {
  return {
    id: randomUUID(),
    description: "Installation Fee — Fiber 25Mbps",
    quantity: 1,
    unitAmountCentavos: 60000,
    totalAmountCentavos: 60000,
  };
}

function discountLineItemRow(totalAmountCentavos: number) {
  return {
    id: randomUUID(),
    description: "Discount — Senior citizen",
    quantity: 1,
    unitAmountCentavos: -totalAmountCentavos,
    totalAmountCentavos: -totalAmountCentavos,
  };
}

/** Every audit row written so far, in commit order. */
function auditRows(): Array<Record<string, unknown>> {
  return insertedInto(auditLogs).map((row) => row.values as Record<string, unknown>);
}

/** Every insert recorded against a specific table. */
function insertedInto(table: unknown): RecordedInsert[] {
  return fakeDatabase.insertedRows.filter((row) => row.table === table);
}

describe("invoice adjustment routes (S2-3)", () => {
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

  it("charges an installation fee as an installation_fee line item on a new draft invoice", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([{ id: SERVICE_ACCOUNT_ID, planName: "Fiber 25Mbps" }]); // account
    fakeDatabase.queueSelectRows([]); // no invoice numbers for the period yet
    fakeDatabase.queueSelectRows([{ balanceCentavos: 0 }]); // no advance credit to apply
    fakeDatabase.queueInsertRows([{ id: INVOICE_ID }]); // invoice insert ... returning
    fakeDatabase.queueInsertRows([]); // line item insert
    fakeDatabase.queueSelectRows([invoiceSummaryRow()]); // loadInvoiceDetail: joined row
    fakeDatabase.queueSelectRows([installationFeeLineItemRow()]); // loadInvoiceDetail: lines
    fakeDatabase.queueInsertRows([]); // audit insert

    const response = await server.inject({
      method: "POST",
      url: "/api/invoices/installation-fee",
      headers: authorizationHeader(token),
      payload: {
        serviceAccountId: SERVICE_ACCOUNT_ID,
        installationFeeCentavos: 60000,
        reason: "new install",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data.amountCentavos).toBe(60000);

    const invoiceValues = insertedInto(invoices)[0]?.values as Record<string, unknown>;
    expect(invoiceValues.invoiceType).toBe("installation_fee");
    expect(invoiceValues.status).toBe("draft");
    expect(invoiceValues.totalAmountCentavos).toBe(60000);

    // A line-item insert passes the whole array to `.values([...])`.
    const lineRows = insertedInto(invoiceLineItems)[0]?.values as Array<Record<string, unknown>>;
    expect(lineRows).toHaveLength(1);
    expect(lineRows[0]?.description).toBe("Installation Fee — Fiber 25Mbps");
    expect(lineRows[0]?.totalAmountCentavos).toBe(60000);

    const row = auditRows()[0];
    expect(row).toMatchObject({
      action: "invoice.installation_fee_charged",
      entityType: "invoice",
      entityId: INVOICE_ID,
      performedBy: ADMIN_ID,
    });
    expect(row?.description).toContain("new install");
    expect(row?.newState).toMatchObject({
      installationFeeCentavos: 60000,
      totalAmountCentavos: 60000,
    });
  });

  it("applies a fixed discount to a draft invoice and audits the old and new totals", async () => {
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([invoiceSummaryRow()]); // handler pre-read: joined row
    fakeDatabase.queueSelectRows([installationFeeLineItemRow()]); // handler pre-read: lines
    fakeDatabase.queueSelectRows([invoiceSummaryRow()]); // service: lock the invoice
    fakeDatabase.queueInsertRows([]); // discount line item insert
    fakeDatabase.queueUpdateRows([]); // invoice totals update
    fakeDatabase.queueSelectRows([
      invoiceSummaryRow({ subtotalCentavos: 50000, totalAmountCentavos: 50000, remainingBalanceCentavos: 50000 }),
    ]); // loadInvoiceDetail: joined row
    fakeDatabase.queueSelectRows([installationFeeLineItemRow(), discountLineItemRow(10000)]); // lines
    fakeDatabase.queueInsertRows([]); // audit insert

    const response = await server.inject({
      method: "POST",
      url: `/api/invoices/${INVOICE_ID}/discount`,
      headers: authorizationHeader(token),
      payload: { discountCentavos: 10000, reason: "Senior citizen" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.totalAmountCentavos).toBe(50000);

    const updatedValues = fakeDatabase.updatedRows[0]?.values as Record<string, unknown>;
    expect(updatedValues).toMatchObject({
      subtotalCentavos: 50000,
      totalAmountCentavos: 50000,
      remainingBalanceCentavos: 50000,
    });

    const row = auditRows()[0];
    expect(row).toMatchObject({
      action: "invoice.discount_applied",
      entityType: "invoice",
      entityId: INVOICE_ID,
      performedBy: ADMIN_ID,
    });
    expect(row?.previousState).toMatchObject({ totalAmountCentavos: 60000 });
    expect(row?.newState).toMatchObject({
      totalAmountCentavos: 50000,
      discountCentavos: 10000,
    });
    expect(row?.description).toContain("Senior citizen");
  });

  it("accepts a percentage discount as an integer basis-point count", async () => {
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([invoiceSummaryRow()]); // handler pre-read: joined row
    fakeDatabase.queueSelectRows([installationFeeLineItemRow()]); // handler pre-read: lines
    fakeDatabase.queueSelectRows([invoiceSummaryRow()]); // service: lock the invoice
    fakeDatabase.queueInsertRows([]); // discount line item insert
    fakeDatabase.queueUpdateRows([]); // invoice totals update
    fakeDatabase.queueSelectRows([
      invoiceSummaryRow({ subtotalCentavos: 58002, totalAmountCentavos: 58002, remainingBalanceCentavos: 58002 }),
    ]); // loadInvoiceDetail: joined row
    fakeDatabase.queueSelectRows([installationFeeLineItemRow(), discountLineItemRow(1998)]); // lines
    fakeDatabase.queueInsertRows([]); // audit insert

    const response = await server.inject({
      method: "POST",
      url: `/api/invoices/${INVOICE_ID}/discount`,
      headers: authorizationHeader(token),
      payload: { discountRateBasisPoints: 333, reason: "Promo" },
    });

    expect(response.statusCode).toBe(200);
    // 3.33% of 60000 = 1998.0 exactly, so the charged total is 58002.
    const updatedValues = fakeDatabase.updatedRows[0]?.values as Record<string, unknown>;
    expect(updatedValues.totalAmountCentavos).toBe(58002);
  });

  it("refuses a percentage discount expressed as a float", async () => {
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID });
    fakeDatabase.queueSelectRows([]); // authenticate

    const response = await server.inject({
      method: "POST",
      url: `/api/invoices/${INVOICE_ID}/discount`,
      headers: authorizationHeader(token),
      payload: { discountRateBasisPoints: 3.33, reason: "Promo" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
    expect(insertedInto(invoices)).toHaveLength(0);
  });

  it("requires a reason and exactly one discount form", async () => {
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID });
    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([]); // authenticate

    const noReason = await server.inject({
      method: "POST",
      url: `/api/invoices/${INVOICE_ID}/discount`,
      headers: authorizationHeader(token),
      payload: { discountCentavos: 10000 },
    });
    expect(noReason.statusCode).toBe(400);

    const bothForms = await server.inject({
      method: "POST",
      url: `/api/invoices/${INVOICE_ID}/discount`,
      headers: authorizationHeader(token),
      payload: { discountCentavos: 10000, discountRateBasisPoints: 100, reason: "Both" },
    });
    expect(bothForms.statusCode).toBe(400);
    expect(bothForms.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("refuses to discount a finalized invoice with a conflict, not a silent mutation", async () => {
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID });

    const posted = invoiceSummaryRow({ status: "unpaid" });
    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([posted]); // handler pre-read: joined row
    fakeDatabase.queueSelectRows([installationFeeLineItemRow()]); // handler pre-read: lines
    fakeDatabase.queueSelectRows([posted]); // service: lock the invoice (already finalized)

    const response = await server.inject({
      method: "POST",
      url: `/api/invoices/${INVOICE_ID}/discount`,
      headers: authorizationHeader(token),
      payload: { discountCentavos: 10000, reason: "Too late" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONFLICT");
    // Nothing was written: no line item, no total change, no audit row.
    expect(insertedInto(invoiceLineItems)).toHaveLength(0);
    expect(fakeDatabase.updatedRows).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it("refuses a discount larger than the invoice's unpaid total", async () => {
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([invoiceSummaryRow()]); // handler pre-read: joined row
    fakeDatabase.queueSelectRows([installationFeeLineItemRow()]); // handler pre-read: lines
    fakeDatabase.queueSelectRows([invoiceSummaryRow()]); // service: lock the invoice

    const response = await server.inject({
      method: "POST",
      url: `/api/invoices/${INVOICE_ID}/discount`,
      headers: authorizationHeader(token),
      payload: { discountCentavos: 60001, reason: "Too much" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
    expect(insertedInto(invoiceLineItems)).toHaveLength(0);
    expect(fakeDatabase.updatedRows).toHaveLength(0);
  });

  it("allows a discount that takes the invoice total exactly to zero", async () => {
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([invoiceSummaryRow()]); // handler pre-read: joined row
    fakeDatabase.queueSelectRows([installationFeeLineItemRow()]); // handler pre-read: lines
    fakeDatabase.queueSelectRows([invoiceSummaryRow()]); // service: lock the invoice
    fakeDatabase.queueInsertRows([]); // discount line item insert
    fakeDatabase.queueUpdateRows([]); // invoice totals update
    fakeDatabase.queueSelectRows([
      invoiceSummaryRow({ subtotalCentavos: 0, totalAmountCentavos: 0, remainingBalanceCentavos: 0 }),
    ]); // loadInvoiceDetail: joined row
    fakeDatabase.queueSelectRows([installationFeeLineItemRow(), discountLineItemRow(60000)]); // lines
    fakeDatabase.queueInsertRows([]); // audit insert

    const response = await server.inject({
      method: "POST",
      url: `/api/invoices/${INVOICE_ID}/discount`,
      headers: authorizationHeader(token),
      payload: { discountCentavos: 60000, reason: "Full waiver" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.totalAmountCentavos).toBe(0);
    expect(response.json().data.remainingBalanceCentavos).toBe(0);
    expect(fakeDatabase.updatedRows[0]?.values).toMatchObject({
      totalAmountCentavos: 0,
      remainingBalanceCentavos: 0,
    });
  });

  it("denies a cashier the discount route but allows the installation fee to a billing clerk", async () => {
    const cashier = signTestToken({ role: "cashier", sub: CASHIER_ID });
    fakeDatabase.queueSelectRows([]); // authenticate (the guard denies before the handler)

    const denied = await server.inject({
      method: "POST",
      url: `/api/invoices/${INVOICE_ID}/discount`,
      headers: authorizationHeader(cashier.token),
      payload: { discountCentavos: 10000, reason: "Cashier discount attempt" },
    });

    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("FORBIDDEN");
    expect(insertedInto(invoiceLineItems)).toHaveLength(0);

    fakeDatabase.reset();
    const clerk = signTestToken({ role: "billing_clerk", sub: ADMIN_ID });
    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([{ id: SERVICE_ACCOUNT_ID, planName: "Fiber 25Mbps" }]); // account
    fakeDatabase.queueSelectRows([]); // no invoice numbers yet
    fakeDatabase.queueSelectRows([{ balanceCentavos: 0 }]); // no advance credit
    fakeDatabase.queueInsertRows([{ id: INVOICE_ID }]); // invoice insert
    fakeDatabase.queueInsertRows([]); // line item insert
    fakeDatabase.queueSelectRows([invoiceSummaryRow()]); // loadInvoiceDetail: joined row
    fakeDatabase.queueSelectRows([installationFeeLineItemRow()]); // loadInvoiceDetail: lines
    fakeDatabase.queueInsertRows([]); // audit insert
    // The fake DB's own resolver is bypassed by the compiled-matrix test setup, so
    // the legacy role in the token is what the guard reads.

    const allowed = await server.inject({
      method: "POST",
      url: "/api/invoices/installation-fee",
      headers: authorizationHeader(clerk.token),
      payload: { serviceAccountId: SERVICE_ACCOUNT_ID, installationFeeCentavos: 60000 },
    });

    expect(allowed.statusCode).toBe(201);
  });
});
