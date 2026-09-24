// Real-PostgreSQL integration test for Phase 6 — the ledger and financial integrity.
//
// This is the acceptance test the phase is judged on, run against a live database so
// the advisory lock, the unique sequence index, and the SQL really execute:
//
//   • invoice → payment → reversal → verify the ledger sequence
//   • the running balances form an unbroken chain in strict sequence order
//   • two concurrent postings for ONE account are serialized (no duplicate sequence)
//   • verifyLedgerIntegrity genuinely detects a corrupted chain
//
// The suite skips itself when no database answers, so `pnpm test` still passes on a
// machine without PostgreSQL.

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../src/index.ts";
import { closeDatabaseConnection, pool } from "../src/db/connection";
import { authorizationHeader, signTestToken } from "./support/tokens";

/** A valid bcrypt hash. The value is never checked in this test — only its shape. */
const DUMMY_PASSWORD_HASH = "$2b$12$OMlJdIjzDLp3Jfn.9NR3qOBmwx5aLVRkyrFhSH6e5J1g.kCBMSeJe";

async function isDatabaseReachable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

const databaseIsReachable = await isDatabaseReachable();

describe.skipIf(!databaseIsReachable)("Phase 6 against real PostgreSQL", () => {
  let server: FastifyInstance;
  let adminId: string;
  let planId: string;
  let planName: string;

  const created = {
    userIds: [] as string[],
    planIds: [] as string[],
    subscriberIds: [] as string[],
    serviceAccountIds: [] as string[],
    invoiceIds: [] as string[],
  };

  beforeAll(async () => {
    server = buildServer();
    await server.ready();

    adminId = randomUUID();
    await pool.query(
      `INSERT INTO users (id, full_name, username, password_hash, role, is_active)
       VALUES ($1, $2, $3, $4, 'admin', true)`,
      [
        adminId,
        "Ledger Integration Admin",
        `ledger.admin.${adminId.slice(0, 8)}`,
        DUMMY_PASSWORD_HASH,
      ]
    );
    created.userIds.push(adminId);

    planId = randomUUID();
    planName = `Ledger Fiber ${planId.slice(0, 8)}`;
    await pool.query(
      `INSERT INTO subscription_plans
         (id, name, service_type, speed_mbps, monthly_rate_centavos, reconnection_fee_centavos, is_active, created_by)
       VALUES ($1, $2, 'internet', 25, 99900, 50000, true, $3)`,
      [planId, planName, adminId]
    );
    created.planIds.push(planId);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM ledger_entries WHERE service_account_id = ANY($1::uuid[])", [
      created.serviceAccountIds,
    ]);
    await pool.query(
      "DELETE FROM payment_reversals WHERE original_payment_id IN (SELECT id FROM payments WHERE service_account_id = ANY($1::uuid[]))",
      [created.serviceAccountIds]
    );
    await pool.query(
      "DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM payments WHERE service_account_id = ANY($1::uuid[]))",
      [created.serviceAccountIds]
    );
    await pool.query(
      "DELETE FROM gcash_payments WHERE payment_id IN (SELECT id FROM payments WHERE service_account_id = ANY($1::uuid[]))",
      [created.serviceAccountIds]
    );
    await pool.query("DELETE FROM payments WHERE service_account_id = ANY($1::uuid[])", [
      created.serviceAccountIds,
    ]);
    await pool.query("DELETE FROM invoice_line_items WHERE invoice_id = ANY($1::uuid[])", [
      created.invoiceIds,
    ]);
    await pool.query("DELETE FROM invoices WHERE id = ANY($1::uuid[])", [created.invoiceIds]);
    await pool.query("DELETE FROM service_accounts WHERE id = ANY($1::uuid[])", [
      created.serviceAccountIds,
    ]);
    await pool.query("DELETE FROM subscribers WHERE id = ANY($1::uuid[])", [created.subscriberIds]);
    await pool.query("DELETE FROM subscription_plans WHERE id = ANY($1::uuid[])", [
      created.planIds,
    ]);
    await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [created.userIds]);

    await server.close();
    await closeDatabaseConnection();
  });

  /** Creates a fresh subscriber and service account, and tracks them for cleanup. */
  async function createServiceAccount(firstName: string): Promise<string> {
    const subscriberId = randomUUID();
    await pool.query(
      `INSERT INTO subscribers
         (id, account_number, first_name, last_name, primary_phone, service_address,
          service_barangay, service_municipality, service_province, created_by)
       VALUES ($1, $2, $3, 'Ledger', '09170000000', '1 Ledger Street',
               'Poblacion', 'Testville', 'Testprovince', $4)`,
      [subscriberId, `SUB-${randomUUID().slice(0, 8)}`, firstName, adminId]
    );
    created.subscriberIds.push(subscriberId);

    const serviceAccountId = randomUUID();
    await pool.query(
      `INSERT INTO service_accounts
         (id, service_account_number, subscriber_id, plan_id, status, activation_date, created_by)
       VALUES ($1, $2, $3, $4, 'active', '2025-01-01', $5)`,
      [serviceAccountId, `SA-${randomUUID().slice(0, 8)}`, subscriberId, planId, adminId]
    );
    created.serviceAccountIds.push(serviceAccountId);

    return serviceAccountId;
  }

  /** Inserts a draft invoice and returns its id. */
  async function createDraftInvoice(
    serviceAccountId: string,
    amountCentavos: number,
    periodMonth: number
  ): Promise<string> {
    const invoiceId = randomUUID();
    await pool.query(
      `INSERT INTO invoices
         (id, invoice_number, service_account_id, invoice_type, status, billing_period_year, billing_period_month,
          invoice_date, due_date, subtotal_centavos, late_fees_centavos, total_amount_centavos,
          paid_amount_centavos, remaining_balance_centavos, created_by)
       VALUES ($1, $2, $3, 'monthly_subscription', 'draft', 2025, $4,
               '2025-01-01', '2025-01-15', $5, 0, $5, 0, $5, $6)`,
      [
        invoiceId,
        `INV-LEDGER-${randomUUID().slice(0, 8)}`,
        serviceAccountId,
        periodMonth,
        amountCentavos,
        adminId,
      ]
    );
    created.invoiceIds.push(invoiceId);
    return invoiceId;
  }

  /** The ledger rows of an account, in sequence order. */
  async function ledgerRows(serviceAccountId: string) {
    const result = await pool.query(
      `SELECT sequence_number, entry_type, amount_centavos, running_balance_centavos
         FROM ledger_entries WHERE service_account_id = $1 ORDER BY sequence_number`,
      [serviceAccountId]
    );
    return result.rows as Array<{
      sequence_number: number;
      entry_type: string;
      amount_centavos: number;
      running_balance_centavos: number;
    }>;
  }

  it("posts invoice → payment → reversal and keeps the ledger chain sound", async () => {
    const { token } = signTestToken({ role: "admin", sub: adminId });
    const headers = authorizationHeader(token);
    const serviceAccountId = await createServiceAccount("Chain");
    const invoiceId = await createDraftInvoice(serviceAccountId, 99900, 1);

    // ── Post the invoice: a DEBIT ────────────────────────────────────────────
    const postInvoiceResponse = await server.inject({
      method: "POST",
      url: `/api/invoices/${invoiceId}/post`,
      headers,
    });
    expect(postInvoiceResponse.statusCode).toBe(200);

    // ── Post a partial payment: a CREDIT ─────────────────────────────────────
    const postPaymentResponse = await server.inject({
      method: "POST",
      url: "/api/payments",
      headers,
      payload: {
        serviceAccountId,
        paymentMethod: "cash",
        amountCentavos: 50000,
        paymentDate: "2025-01-10",
      },
    });
    expect(postPaymentResponse.statusCode).toBe(201);
    const paymentId = postPaymentResponse.json().data.payment.id as string;

    // ── Balance comes from the latest entry ──────────────────────────────────
    const balanceResponse = await server.inject({
      method: "GET",
      url: `/api/service-accounts/${serviceAccountId}/balance`,
      headers,
    });
    expect(balanceResponse.statusCode).toBe(200);
    expect(balanceResponse.json().data.balanceCentavos).toBe(49900);

    // ── Statement reconciles exactly ─────────────────────────────────────────
    const statementResponse = await server.inject({
      method: "GET",
      url: `/api/service-accounts/${serviceAccountId}/statement`,
      headers,
    });
    expect(statementResponse.statusCode).toBe(200);
    const statement = statementResponse.json().data;
    expect(statement.openingBalanceCentavos).toBe(0);
    expect(statement.totalDebitsCentavos).toBe(99900);
    expect(statement.totalCreditsCentavos).toBe(50000);
    expect(statement.closingBalanceCentavos).toBe(49900);
    expect(
      statement.openingBalanceCentavos +
        statement.totalDebitsCentavos -
        statement.totalCreditsCentavos
    ).toBe(statement.closingBalanceCentavos);

    // ── Reverse the payment: a DEBIT that restores the debt ──────────────────
    const reverseResponse = await server.inject({
      method: "POST",
      url: `/api/payments/${paymentId}/reverse`,
      headers,
      payload: { reason: "Cashier posted to the wrong account" },
    });
    expect(reverseResponse.statusCode).toBe(200);

    // ── The chain: types, amounts, and running balances, in sequence order ───
    const rows = await ledgerRows(serviceAccountId);
    expect(rows.map((row) => row.entry_type)).toEqual([
      "invoice_posted",
      "payment_received",
      "payment_reversal",
    ]);
    expect(rows.map((row) => row.sequence_number)).toEqual([1, 2, 3]);
    expect(rows.map((row) => row.amount_centavos)).toEqual([99900, 50000, 50000]);
    expect(rows.map((row) => row.running_balance_centavos)).toEqual([99900, 49900, 99900]);

    // ── Integrity check agrees, and no row was updated or deleted ────────────
    const verifyResponse = await server.inject({
      method: "GET",
      url: `/api/ledger/verify/${serviceAccountId}`,
      headers,
    });
    expect(verifyResponse.statusCode).toBe(200);
    expect(verifyResponse.json().data).toMatchObject({
      isValid: true,
      failure: null,
      lastComputedBalanceCentavos: 99900,
      lastStoredBalanceCentavos: 99900,
    });
    expect(await ledgerRows(serviceAccountId)).toHaveLength(3);
  });

  it("serializes two concurrent postings for the same account", async () => {
    const { token } = signTestToken({ role: "admin", sub: adminId });
    const headers = authorizationHeader(token);
    const serviceAccountId = await createServiceAccount("Concurrent");
    const firstInvoiceId = await createDraftInvoice(serviceAccountId, 30000, 2);
    const secondInvoiceId = await createDraftInvoice(serviceAccountId, 20000, 3);

    // Two postings racing for the same account. The advisory lock must let exactly
    // one writer at a time compute the next sequence number and running balance.
    const [first, second] = await Promise.all([
      server.inject({ method: "POST", url: `/api/invoices/${firstInvoiceId}/post`, headers }),
      server.inject({ method: "POST", url: `/api/invoices/${secondInvoiceId}/post`, headers }),
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const rows = await ledgerRows(serviceAccountId);
    // No duplicate or missing sequence numbers, despite the race.
    expect(rows.map((row) => row.sequence_number)).toEqual([1, 2]);
    // Both debits landed, and the chain is exactly previous + amount.
    const total = rows.reduce((sum, row) => sum + row.amount_centavos, 0);
    expect(total).toBe(50000);
    expect(rows[1]!.running_balance_centavos).toBe(
      rows[0]!.running_balance_centavos + rows[1]!.amount_centavos
    );

    const verifyResponse = await server.inject({
      method: "GET",
      url: `/api/ledger/verify/${serviceAccountId}`,
      headers,
    });
    expect(verifyResponse.json().data).toMatchObject({ isValid: true, entryCount: 2 });
  });

  it("detects a deleted middle entry as a sequence gap", async () => {
    const { token } = signTestToken({ role: "admin", sub: adminId });
    const headers = authorizationHeader(token);
    const serviceAccountId = await createServiceAccount("CorruptGap");
    const firstInvoiceId = await createDraftInvoice(serviceAccountId, 30000, 4);
    const secondInvoiceId = await createDraftInvoice(serviceAccountId, 20000, 5);

    await server.inject({ method: "POST", url: `/api/invoices/${firstInvoiceId}/post`, headers });
    await server.inject({ method: "POST", url: `/api/invoices/${secondInvoiceId}/post`, headers });

    // Deliberately corrupt the ledger (the test plays the attacker): remove the
    // first entry and leave the second in place.
    await pool.query(
      "DELETE FROM ledger_entries WHERE service_account_id = $1 AND sequence_number = 1",
      [serviceAccountId]
    );

    const verifyResponse = await server.inject({
      method: "GET",
      url: `/api/ledger/verify/${serviceAccountId}`,
      headers,
    });
    expect(verifyResponse.json().data).toMatchObject({
      isValid: false,
      failure: "sequence_gap",
      missingSequenceNumber: 1,
    });
  });

  it("detects a broken running balance", async () => {
    const { token } = signTestToken({ role: "admin", sub: adminId });
    const headers = authorizationHeader(token);
    const serviceAccountId = await createServiceAccount("CorruptBalance");
    const invoiceId = await createDraftInvoice(serviceAccountId, 99900, 6);

    await server.inject({ method: "POST", url: `/api/invoices/${invoiceId}/post`, headers });

    // Tamper with the cached running balance so it no longer matches the arithmetic.
    await pool.query(
      "UPDATE ledger_entries SET running_balance_centavos = running_balance_centavos + 1 WHERE service_account_id = $1",
      [serviceAccountId]
    );

    const verifyResponse = await server.inject({
      method: "GET",
      url: `/api/ledger/verify/${serviceAccountId}`,
      headers,
    });
    expect(verifyResponse.json().data).toMatchObject({
      isValid: false,
      failure: "broken_running_balance",
      discrepancyCentavos: -1,
    });
  });
});
