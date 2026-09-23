// Acceptance tests for Phase 4 — billing and invoicing.
//
// They run against the real Fastify app via `app.inject()` with the database
// swapped for an in-memory stand-in, so no PostgreSQL is required. What is being
// pinned down is the financial behaviour: one invoice per account per period,
// duplicate prevention, and the ledger debit/credit produced by posting and voiding.

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
import { billingRuns, invoiceLineItems, invoices } from "../src/db/schema/billing";
import { ledgerEntries } from "../src/db/schema/ledger";
import { paymentAllocations } from "../src/db/schema/payments";
import { fakeDatabase, type RecordedInsert } from "./support/fake-database";
import { authorizationHeader, signTestToken } from "./support/tokens";

const ADMIN_ID = randomUUID();
const SERVICE_ACCOUNT_ID = randomUUID();
const SUBSCRIBER_ID = randomUUID();
const INVOICE_ID = randomUUID();
const ADVANCE_PAYMENT_ID = randomUUID();

function monthlyBillingCandidate(overrides: Record<string, unknown> = {}) {
  return {
    serviceAccountId: SERVICE_ACCOUNT_ID,
    planName: "Fiber 25Mbps",
    monthlyRateCentavos: 99900,
    ...overrides,
  };
}

function invoiceSummaryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    invoiceNumber: "INV-2025-01-000001",
    serviceAccountId: SERVICE_ACCOUNT_ID,
    serviceAccountNumber: "SA-20250124-00001",
    subscriberId: SUBSCRIBER_ID,
    subscriberFirstName: "Maria",
    subscriberLastName: "Santos",
    invoiceType: "monthly_subscription",
    status: "draft",
    billingPeriodYear: 2025,
    billingPeriodMonth: 1,
    invoiceDate: "2025-01-01",
    dueDate: "2025-01-15",
    subtotalCentavos: 99900,
    lateFeesCentavos: 0,
    totalAmountCentavos: 99900,
    paidAmountCentavos: 0,
    remainingBalanceCentavos: 99900,
    notes: null,
    voidedByTransactionId: null,
    createdAt: new Date(),
    postedAt: null,
    voidedAt: null,
    ...overrides,
  };
}

function lineItemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    description: "Fiber 25Mbps — January 2025",
    quantity: 1,
    unitAmountCentavos: 99900,
    totalAmountCentavos: 99900,
    ...overrides,
  };
}

/** Every insert recorded against a specific table. */
function insertedInto(table: unknown): RecordedInsert[] {
  return fakeDatabase.insertedRows.filter((row) => row.table === table);
}

describe("billing and invoice routes", () => {
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

  it("generates exactly one draft invoice per active account and writes no ledger entry", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([monthlyBillingCandidate()]); // active accounts
    fakeDatabase.queueSelectRows([]); // lock the account row
    fakeDatabase.queueSelectRows([]); // no existing invoice for the period
    fakeDatabase.queueSelectRows([]); // existing invoice numbers for the period
    fakeDatabase.queueSelectRows([{ balanceCentavos: 0 }]); // ledger balance: no credit to apply
    fakeDatabase.queueInsertRows([{ id: INVOICE_ID }]); // invoice insert ... returning
    fakeDatabase.queueInsertRows([]); // line item insert
    fakeDatabase.queueInsertRows([]); // billing run insert

    const response = await server.inject({
      method: "POST",
      url: "/api/billing/run",
      headers: authorizationHeader(token),
      payload: { year: 2025, month: 1 },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data.totalInvoicesGenerated).toBe(1);
    expect(response.json().data.totalAmountBilledCentavos).toBe(99900);

    const createdInvoices = insertedInto(invoices);
    expect(createdInvoices).toHaveLength(1);

    const invoiceValues = createdInvoices[0]?.values as Record<string, unknown>;
    expect(invoiceValues.status).toBe("draft");
    expect(invoiceValues.totalAmountCentavos).toBe(99900);
    expect(invoiceValues.remainingBalanceCentavos).toBe(99900);
    expect(invoiceValues.invoiceNumber).toBe("INV-2025-01-000001");

    const createdLineItems = insertedInto(invoiceLineItems);
    expect(createdLineItems).toHaveLength(1);

    // A draft is not a debt yet: nothing may reach the ledger during generation.
    expect(insertedInto(ledgerEntries)).toHaveLength(0);
    expect(insertedInto(billingRuns)).toHaveLength(1);
  });

  it("applies an account's advance credit to the newly generated invoice", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([monthlyBillingCandidate()]); // active accounts
    fakeDatabase.queueSelectRows([]); // lock the account row
    fakeDatabase.queueSelectRows([]); // no existing invoice for the period
    fakeDatabase.queueSelectRows([]); // existing invoice numbers for the period
    fakeDatabase.queueSelectRows([{ balanceCentavos: -30000 }]); // ledger balance: 300.00 credit held
    fakeDatabase.queueSelectRows([
      { paymentId: ADVANCE_PAYMENT_ID, amountCentavos: 30000 },
    ]); // the advance payment that created the credit
    fakeDatabase.queueSelectRows([{ balanceCentavos: -30000 }]); // balance when the application is recorded
    fakeDatabase.queueInsertRows([{ id: INVOICE_ID }]); // invoice insert
    fakeDatabase.queueInsertRows([]); // line item insert
    fakeDatabase.queueInsertRows([]); // payment allocation insert
    fakeDatabase.queueInsertRows([{ id: randomUUID() }]); // ledger entry insert
    fakeDatabase.queueInsertRows([]); // billing run insert
    fakeDatabase.queueUpdateRows([]); // invoice paid/remaining update

    const response = await server.inject({
      method: "POST",
      url: "/api/billing/run",
      headers: authorizationHeader(token),
      payload: { year: 2025, month: 1 },
    });

    expect(response.statusCode).toBe(201);

    // The new invoice is still a draft, but 300.00 of it is already covered.
    const invoiceValues = insertedInto(invoices)[0]?.values as Record<string, unknown>;
    expect(invoiceValues.status).toBe("draft");
    expect(invoiceValues.totalAmountCentavos).toBe(99900);

    // The credit is attributed to the advance payment that funded it.
    const allocationValues = insertedInto(paymentAllocations)[0]?.values as Record<
      string,
      unknown
    >;
    expect(allocationValues).toMatchObject({
      paymentId: ADVANCE_PAYMENT_ID,
      invoiceId: INVOICE_ID,
      allocatedAmountCentavos: 30000,
    });

    // And an advance_credit_applied DEBIT cancels the credit it consumed.
    const ledgerWrites = insertedInto(ledgerEntries);
    expect(ledgerWrites).toHaveLength(1);
    expect(ledgerWrites[0]?.values).toMatchObject({
      entryType: "advance_credit_applied",
      amountCentavos: 30000,
      runningBalanceCentavos: 0,
    });

    expect(fakeDatabase.updatedRows[0]?.values).toMatchObject({
      paidAmountCentavos: 30000,
      remainingBalanceCentavos: 69900,
    });
  });

  it("posts a credit-reduced draft for its remaining balance only", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      {
        id: INVOICE_ID,
        invoiceNumber: "INV-2025-01-000001",
        serviceAccountId: SERVICE_ACCOUNT_ID,
        status: "draft",
        totalAmountCentavos: 99900,
        remainingBalanceCentavos: 69900,
        billingPeriodYear: 2025,
        billingPeriodMonth: 1,
      },
    ]); // invoice for update
    fakeDatabase.queueUpdateRows([]); // status -> posted
    fakeDatabase.queueSelectRows([{ balanceCentavos: 0 }]); // current ledger balance
    fakeDatabase.queueInsertRows([{ id: randomUUID() }]); // ledger entry insert
    fakeDatabase.queueSelectRows([invoiceSummaryRow({ status: "posted" })]); // reload summary
    fakeDatabase.queueSelectRows([lineItemRow()]); // reload line items

    const response = await server.inject({
      method: "POST",
      url: `/api/invoices/${INVOICE_ID}/post`,
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);

    // Only the still-owed part becomes a new debt.
    const ledgerValues = insertedInto(ledgerEntries)[0]?.values as Record<string, unknown>;
    expect(ledgerValues.entryType).toBe("invoice_posted");
    expect(ledgerValues.amountCentavos).toBe(69900);
    expect(ledgerValues.runningBalanceCentavos).toBe(69900);
  });

  it("posts a fully credit-covered draft as paid without a new ledger debit", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      {
        id: INVOICE_ID,
        invoiceNumber: "INV-2025-01-000001",
        serviceAccountId: SERVICE_ACCOUNT_ID,
        status: "draft",
        totalAmountCentavos: 99900,
        remainingBalanceCentavos: 0,
        billingPeriodYear: 2025,
        billingPeriodMonth: 1,
      },
    ]); // invoice for update
    fakeDatabase.queueUpdateRows([]); // status -> paid
    fakeDatabase.queueSelectRows([invoiceSummaryRow({ status: "paid" })]); // reload summary
    fakeDatabase.queueSelectRows([lineItemRow()]); // reload line items

    const response = await server.inject({
      method: "POST",
      url: `/api/invoices/${INVOICE_ID}/post`,
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe("paid");

    // Nothing new is owed, so no invoice_posted debit is written.
    expect(insertedInto(ledgerEntries)).toHaveLength(0);
    expect(fakeDatabase.updatedRows[0]?.values).toMatchObject({ status: "paid" });
  });

  it("does not create a duplicate when the billing job runs twice for the same month", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: ADMIN_ID });

    // First run: no invoice exists yet, so one is generated.
    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([monthlyBillingCandidate()]); // active accounts
    fakeDatabase.queueSelectRows([]); // lock the account row
    fakeDatabase.queueSelectRows([]); // no existing invoice
    fakeDatabase.queueSelectRows([]); // no invoice numbers yet
    fakeDatabase.queueInsertRows([{ id: INVOICE_ID }]); // invoice insert
    fakeDatabase.queueInsertRows([]); // line item insert
    fakeDatabase.queueInsertRows([]); // billing run insert

    const firstRun = await server.inject({
      method: "POST",
      url: "/api/billing/run",
      headers: authorizationHeader(token),
      payload: { year: 2025, month: 1 },
    });

    expect(firstRun.statusCode).toBe(201);
    expect(firstRun.json().data.totalInvoicesGenerated).toBe(1);
    expect(insertedInto(invoices)).toHaveLength(1);

    // Second run for the same month: an invoice already exists, so the account is skipped.
    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([monthlyBillingCandidate()]); // active accounts
    fakeDatabase.queueSelectRows([]); // lock the account row
    fakeDatabase.queueSelectRows([{ id: INVOICE_ID }]); // existing invoice found
    fakeDatabase.queueInsertRows([]); // billing run insert

    const secondRun = await server.inject({
      method: "POST",
      url: "/api/billing/run",
      headers: authorizationHeader(token),
      payload: { year: 2025, month: 1 },
    });

    expect(secondRun.statusCode).toBe(201);
    expect(secondRun.json().data.totalInvoicesGenerated).toBe(0);
    expect(secondRun.json().data.totalInvoicesSkipped).toBe(1);

    // Still exactly one invoice: the second run added none.
    expect(insertedInto(invoices)).toHaveLength(1);
  });

  it("posts an invoice and creates a matching ledger DEBIT entry", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      {
        id: INVOICE_ID,
        invoiceNumber: "INV-2025-01-000001",
        serviceAccountId: SERVICE_ACCOUNT_ID,
        status: "draft",
        totalAmountCentavos: 99900,
        remainingBalanceCentavos: 99900,
        billingPeriodYear: 2025,
        billingPeriodMonth: 1,
      },
    ]); // invoice for update
    fakeDatabase.queueUpdateRows([]); // status -> posted
    fakeDatabase.queueSelectRows([{ balanceCentavos: 0 }]); // current ledger balance
    fakeDatabase.queueInsertRows([{ id: randomUUID() }]); // ledger entry insert
    fakeDatabase.queueSelectRows([invoiceSummaryRow({ status: "posted" })]); // reload summary
    fakeDatabase.queueSelectRows([lineItemRow()]); // reload line items

    const response = await server.inject({
      method: "POST",
      url: `/api/invoices/${INVOICE_ID}/post`,
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe("posted");

    const ledgerWrites = insertedInto(ledgerEntries);
    expect(ledgerWrites).toHaveLength(1);

    const ledgerValues = ledgerWrites[0]?.values as Record<string, unknown>;
    expect(ledgerValues.entryType).toBe("invoice_posted");
    expect(ledgerValues.amountCentavos).toBe(99900);
    expect(ledgerValues.runningBalanceCentavos).toBe(99900);

    expect(fakeDatabase.updatedRows[0]?.values).toMatchObject({ status: "posted" });
  });

  it("voids an invoice: marks it void, keeps the row, and creates a ledger CREDIT entry", async () => {
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      {
        id: INVOICE_ID,
        invoiceNumber: "INV-2025-01-000001",
        serviceAccountId: SERVICE_ACCOUNT_ID,
        status: "posted",
        totalAmountCentavos: 99900,
        remainingBalanceCentavos: 99900,
        billingPeriodYear: 2025,
        billingPeriodMonth: 1,
      },
    ]); // invoice for update
    fakeDatabase.queueSelectRows([{ balanceCentavos: 99900 }]); // current ledger balance
    fakeDatabase.queueInsertRows([{ id: randomUUID() }]); // ledger entry insert
    fakeDatabase.queueUpdateRows([]); // status -> void
    fakeDatabase.queueSelectRows([invoiceSummaryRow({ status: "void", notes: "Entered wrongly" })]); // reload
    fakeDatabase.queueSelectRows([lineItemRow()]); // reload line items

    const response = await server.inject({
      method: "POST",
      url: `/api/invoices/${INVOICE_ID}/void`,
      headers: authorizationHeader(token),
      payload: { reason: "Entered wrongly" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe("void");

    const ledgerWrites = insertedInto(ledgerEntries);
    expect(ledgerWrites).toHaveLength(1);

    const ledgerValues = ledgerWrites[0]?.values as Record<string, unknown>;
    expect(ledgerValues.entryType).toBe("invoice_void");
    expect(ledgerValues.amountCentavos).toBe(99900);
    expect(ledgerValues.runningBalanceCentavos).toBe(0);

    // The invoice row is updated, never deleted.
    expect(fakeDatabase.updatedRows[0]?.values).toMatchObject({ status: "void" });
  });

  it("refuses to void a fully paid invoice", async () => {
    const { token } = signTestToken({ role: "admin", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      {
        id: INVOICE_ID,
        invoiceNumber: "INV-2025-01-000001",
        serviceAccountId: SERVICE_ACCOUNT_ID,
        status: "paid",
        totalAmountCentavos: 99900,
        remainingBalanceCentavos: 0,
        billingPeriodYear: 2025,
        billingPeriodMonth: 1,
      },
    ]); // invoice for update

    const response = await server.inject({
      method: "POST",
      url: `/api/invoices/${INVOICE_ID}/void`,
      headers: authorizationHeader(token),
      payload: { reason: "Trying to erase a paid invoice" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONFLICT");
    expect(insertedInto(ledgerEntries)).toHaveLength(0);
  });

  it("adds a late fee line item, updates the totals, and records a ledger debit", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      {
        id: INVOICE_ID,
        invoiceNumber: "INV-2025-01-000001",
        serviceAccountId: SERVICE_ACCOUNT_ID,
        status: "overdue",
        totalAmountCentavos: 99900,
        lateFeesCentavos: 0,
        remainingBalanceCentavos: 99900,
        billingPeriodYear: 2025,
        billingPeriodMonth: 1,
      },
    ]); // overdue invoices
    fakeDatabase.queueSelectRows([
      {
        id: INVOICE_ID,
        invoiceNumber: "INV-2025-01-000001",
        serviceAccountId: SERVICE_ACCOUNT_ID,
        status: "overdue",
        totalAmountCentavos: 99900,
        lateFeesCentavos: 0,
        remainingBalanceCentavos: 99900,
        billingPeriodYear: 2025,
        billingPeriodMonth: 1,
      },
    ]); // invoice re-read FOR UPDATE (still chargeable)
    fakeDatabase.queueInsertRows([]); // late fee line item insert
    fakeDatabase.queueUpdateRows([]); // invoice totals update
    fakeDatabase.queueSelectRows([{ balanceCentavos: 99900 }]); // current ledger balance
    fakeDatabase.queueInsertRows([{ id: randomUUID() }]); // ledger entry insert

    const response = await server.inject({
      method: "POST",
      url: "/api/billing/apply-late-fees",
      headers: authorizationHeader(token),
      payload: { lateFeeCentavos: 5000 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.invoicesCharged).toBe(1);

    const createdLineItems = insertedInto(invoiceLineItems);
    expect(createdLineItems).toHaveLength(1);
    expect(createdLineItems[0]?.values).toMatchObject({
      description: expect.stringContaining("Late Payment Fee"),
      totalAmountCentavos: 5000,
    });

    expect(fakeDatabase.updatedRows[0]?.values).toMatchObject({
      lateFeesCentavos: 5000,
      totalAmountCentavos: 104900,
      remainingBalanceCentavos: 104900,
      status: "overdue",
    });

    const ledgerValues = insertedInto(ledgerEntries)[0]?.values as Record<string, unknown>;
    expect(ledgerValues.entryType).toBe("late_fee");
    expect(ledgerValues.amountCentavos).toBe(5000);
  });

  it("does not charge a late fee on an invoice voided after the overdue scan", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: ADMIN_ID });

    // The coarse scan still sees the invoice (it was posted when the scan ran)...
    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      {
        id: INVOICE_ID,
        invoiceNumber: "INV-2025-01-000001",
        serviceAccountId: SERVICE_ACCOUNT_ID,
        status: "posted",
        totalAmountCentavos: 99900,
        lateFeesCentavos: 0,
        remainingBalanceCentavos: 99900,
        billingPeriodYear: 2025,
        billingPeriodMonth: 1,
      },
    ]); // overdue invoices
    // ...but by the time the per-invoice transaction locks it, a void has committed.
    fakeDatabase.queueSelectRows([
      {
        id: INVOICE_ID,
        invoiceNumber: "INV-2025-01-000001",
        serviceAccountId: SERVICE_ACCOUNT_ID,
        status: "void",
        totalAmountCentavos: 99900,
        lateFeesCentavos: 0,
        remainingBalanceCentavos: 99900,
        billingPeriodYear: 2025,
        billingPeriodMonth: 1,
      },
    ]); // invoice re-read FOR UPDATE (voided)

    const response = await server.inject({
      method: "POST",
      url: "/api/billing/apply-late-fees",
      headers: authorizationHeader(token),
      payload: { lateFeeCentavos: 5000 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.invoicesCharged).toBe(0);

    // Nothing may be written for a voided invoice: no line item, no status flip
    // back to overdue, and no late-fee ledger debit on a reversed debt.
    expect(insertedInto(invoiceLineItems)).toHaveLength(0);
    expect(fakeDatabase.updatedRows).toHaveLength(0);
    expect(insertedInto(ledgerEntries)).toHaveLength(0);
  });

  it("does not charge a second fee when an invoice is already paid by the time it is locked", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      {
        id: INVOICE_ID,
        invoiceNumber: "INV-2025-01-000001",
        serviceAccountId: SERVICE_ACCOUNT_ID,
        status: "overdue",
        totalAmountCentavos: 99900,
        lateFeesCentavos: 0,
        remainingBalanceCentavos: 99900,
        billingPeriodYear: 2025,
        billingPeriodMonth: 1,
      },
    ]); // overdue invoices
    fakeDatabase.queueSelectRows([
      {
        id: INVOICE_ID,
        invoiceNumber: "INV-2025-01-000001",
        serviceAccountId: SERVICE_ACCOUNT_ID,
        status: "paid",
        totalAmountCentavos: 104900,
        lateFeesCentavos: 5000,
        remainingBalanceCentavos: 0,
        billingPeriodYear: 2025,
        billingPeriodMonth: 1,
      },
    ]); // invoice re-read FOR UPDATE (no longer chargeable)

    const response = await server.inject({
      method: "POST",
      url: "/api/billing/apply-late-fees",
      headers: authorizationHeader(token),
      payload: { lateFeeCentavos: 5000 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.invoicesCharged).toBe(0);
    expect(insertedInto(invoiceLineItems)).toHaveLength(0);
    expect(fakeDatabase.updatedRows).toHaveLength(0);
    expect(insertedInto(ledgerEntries)).toHaveLength(0);
  });

  it("generates a reconnection fee invoice for a service account", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: ADMIN_ID });

    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([
      {
        id: SERVICE_ACCOUNT_ID,
        planName: "Fiber 25Mbps",
        reconnectionFeeCentavos: 50000,
      },
    ]); // account joined with its plan
    fakeDatabase.queueSelectRows([]); // existing invoice numbers
    fakeDatabase.queueSelectRows([{ balanceCentavos: 0 }]); // ledger balance: no credit to apply
    fakeDatabase.queueInsertRows([{ id: INVOICE_ID }]); // invoice insert
    fakeDatabase.queueInsertRows([]); // line item insert
    fakeDatabase.queueSelectRows([
      invoiceSummaryRow({ invoiceType: "reconnection_fee", status: "draft" }),
    ]); // reload summary
    fakeDatabase.queueSelectRows([lineItemRow({ description: "Reconnection Fee — Fiber 25Mbps" })]); // reload line items

    const response = await server.inject({
      method: "POST",
      url: "/api/invoices/reconnection-fee",
      headers: authorizationHeader(token),
      payload: { serviceAccountId: SERVICE_ACCOUNT_ID, reason: "Reconnected after payment plan" },
    });

    expect(response.statusCode).toBe(201);

    const createdInvoices = insertedInto(invoices);
    expect(createdInvoices).toHaveLength(1);
    expect(createdInvoices[0]?.values).toMatchObject({
      invoiceType: "reconnection_fee",
      totalAmountCentavos: 50000,
      status: "draft",
    });
  });

  it("refuses to run the billing job for a Cashier, who has no billing permission", async () => {
    const { token } = signTestToken({ role: "cashier", sub: ADMIN_ID });
    fakeDatabase.queueSelectRows([]); // authenticate only; authorize rejects the request

    const response = await server.inject({
      method: "POST",
      url: "/api/billing/run",
      headers: authorizationHeader(token),
      payload: { year: 2025, month: 1 },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
    expect(insertedInto(invoices)).toHaveLength(0);
  });

  it("refuses to void an invoice for a Billing Clerk, who has no void permission", async () => {
    const { token } = signTestToken({ role: "billing_clerk", sub: ADMIN_ID });
    fakeDatabase.queueSelectRows([]); // authenticate only

    const response = await server.inject({
      method: "POST",
      url: `/api/invoices/${INVOICE_ID}/void`,
      headers: authorizationHeader(token),
      payload: { reason: "Should not be allowed" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
  });
});
