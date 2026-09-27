// Real-PostgreSQL integration test for Phase 5.
//
// This is the "post → verify invoice status → reverse → verify restoration"
// acceptance test from the specification, run against a live database so the
// transaction boundaries, unique constraints, and SQL really execute.
//
// The suite skips itself when no database answers, so `pnpm test` still passes on
// a machine without PostgreSQL. It runs against DATABASE_URL, which vitest points
// at a dedicated bcis_test database.

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../src/index.ts";
import { closeDatabaseConnection, pool } from "../src/db/connection";
import { generateInvoiceForCandidate } from "../src/modules/billing/monthly-billing.service.ts";
import { authorizationHeader, signTestToken } from "./support/tokens";
import { deleteAuditLogsForUsers } from "./support/audit-cleanup";
import { deleteLedgerEntriesForServiceAccounts } from "./support/ledger-cleanup";

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

describe.skipIf(!databaseIsReachable)("Phase 5 against real PostgreSQL", () => {
  let server: FastifyInstance;
  let adminId: string;
  let planId: string;
  let subscriberId: string;
  let serviceAccountId: string;
  let oldestInvoiceId: string;
  let newestInvoiceId: string;

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
      [adminId, "Integration Admin", `integration.admin.${adminId.slice(0, 8)}`, DUMMY_PASSWORD_HASH]
    );
    created.userIds.push(adminId);

    planId = randomUUID();
    await pool.query(
      `INSERT INTO subscription_plans
         (id, name, service_type, speed_mbps, monthly_rate_centavos, reconnection_fee_centavos, is_active, created_by)
       VALUES ($1, $2, 'internet', 25, 99900, 50000, true, $3)`,
      [planId, `Integration Payment Fiber ${planId.slice(0, 8)}`, adminId]
    );
    created.planIds.push(planId);

    subscriberId = randomUUID();
    await pool.query(
      `INSERT INTO subscribers
         (id, account_number, first_name, last_name, primary_phone, service_address,
          service_barangay, service_municipality, service_province, created_by)
       VALUES ($1, $2, 'Paula', 'Payment', '09170000000', '1 Test Street',
               'Poblacion', 'Testville', 'Testprovince', $3)`,
      [subscriberId, `SUB-${randomUUID().slice(0, 8)}`, adminId]
    );
    created.subscriberIds.push(subscriberId);

    serviceAccountId = randomUUID();
    await pool.query(
      `INSERT INTO service_accounts
         (id, service_account_number, subscriber_id, plan_id, status, activation_date, created_by)
       VALUES ($1, $2, $3, $4, 'active', '2025-01-01', $5)`,
      [serviceAccountId, `SA-${randomUUID().slice(0, 8)}`, subscriberId, planId, adminId]
    );
    created.serviceAccountIds.push(serviceAccountId);

    oldestInvoiceId = randomUUID();
    newestInvoiceId = randomUUID();
    await pool.query(
      `INSERT INTO invoices
         (id, invoice_number, service_account_id, invoice_type, status, billing_period_year, billing_period_month,
          invoice_date, due_date, subtotal_centavos, late_fees_centavos, total_amount_centavos,
          paid_amount_centavos, remaining_balance_centavos, created_by)
       VALUES
         ($1, $2, $5, 'monthly_subscription', 'unpaid', 2025, 1, '2025-01-01', '2025-01-15', 50000, 0, 50000, 0, 50000, $6),
         ($3, $4, $5, 'monthly_subscription', 'unpaid', 2025, 2, '2025-02-01', '2025-02-15', 80000, 0, 80000, 0, 80000, $6)`,
      [
        oldestInvoiceId,
        `INV-INT-${randomUUID().slice(0, 8)}`,
        newestInvoiceId,
        `INV-INT-${randomUUID().slice(0, 8)}`,
        serviceAccountId,
        adminId,
      ]
    );
    created.invoiceIds.push(oldestInvoiceId, newestInvoiceId);
  });

  afterAll(async () => {
    // Remove this suite's rows in foreign-key order.
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
    // The ledger references both payments and invoices, so it is cleared first.
    await deleteLedgerEntriesForServiceAccounts(created.serviceAccountIds);
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
    await pool.query("DELETE FROM subscription_plans WHERE id = ANY($1::uuid[])", [created.planIds]);
    await deleteAuditLogsForUsers(pool, created.userIds);
    await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [created.userIds]);

    await server.close();
    await closeDatabaseConnection();
  });

  async function invoiceState(invoiceId: string) {
    const result = await pool.query(
      "SELECT status, paid_amount_centavos, remaining_balance_centavos FROM invoices WHERE id = $1",
      [invoiceId]
    );
    return result.rows[0];
  }

  async function ledgerNetCentavos(): Promise<number> {
    const result = await pool.query(
      `SELECT coalesce(sum(case
          when entry_type in ('invoice_posted','late_fee','manual_debit','payment_reversal')
            then amount_centavos else -amount_centavos end), 0)::int AS net
         FROM ledger_entries WHERE service_account_id = $1`,
      [serviceAccountId]
    );
    return result.rows[0].net;
  }

  /** The net of one account's ledger, for a test that owns its whole ledger. */
  async function ledgerNetFor(accountId: string): Promise<number> {
    const result = await pool.query(
      `SELECT coalesce(sum(case
          when entry_type in ('invoice_posted','late_fee','manual_debit','payment_reversal','advance_credit_applied')
            then amount_centavos else -amount_centavos end), 0)::int AS net
         FROM ledger_entries WHERE service_account_id = $1`,
      [accountId]
    );
    return result.rows[0].net;
  }

  /**
   * A brand-new account with one unpaid invoice and nothing else on its ledger, so
   * a test can assert whole-balance facts without another suite's rows in the way.
   */
  async function createAccountWithInvoice(
    label: string,
    invoiceCentavos: number
  ): Promise<{ serviceAccountId: string; invoiceId: string }> {
    const freshPlanId = randomUUID();
    await pool.query(
      `INSERT INTO subscription_plans
         (id, name, service_type, speed_mbps, monthly_rate_centavos, reconnection_fee_centavos, is_active, created_by)
       VALUES ($1, $2, 'internet', 25, 99900, 50000, true, $3)`,
      [freshPlanId, `WP3 ${label} Fiber ${freshPlanId.slice(0, 8)}`, adminId]
    );
    created.planIds.push(freshPlanId);

    const freshSubscriberId = randomUUID();
    await pool.query(
      `INSERT INTO subscribers
         (id, account_number, first_name, last_name, primary_phone, service_address,
          service_barangay, service_municipality, service_province, created_by)
       VALUES ($1, $2, $3, $4, '09170000009', '9 Test Street',
               'Poblacion', 'Testville', 'Testprovince', $5)`,
      [freshSubscriberId, `SUB-${randomUUID().slice(0, 8)}`, label, "Payment", adminId]
    );
    created.subscriberIds.push(freshSubscriberId);

    const freshAccountId = randomUUID();
    await pool.query(
      `INSERT INTO service_accounts
         (id, service_account_number, subscriber_id, plan_id, status, activation_date, created_by)
       VALUES ($1, $2, $3, $4, 'active', '2025-01-01', $5)`,
      [freshAccountId, `SA-${randomUUID().slice(0, 8)}`, freshSubscriberId, freshPlanId, adminId]
    );
    created.serviceAccountIds.push(freshAccountId);

    const freshInvoiceId = randomUUID();
    await pool.query(
      `INSERT INTO invoices
         (id, invoice_number, service_account_id, invoice_type, status, billing_period_year, billing_period_month,
          invoice_date, due_date, subtotal_centavos, late_fees_centavos, total_amount_centavos,
          paid_amount_centavos, remaining_balance_centavos, created_by)
       VALUES ($1, $2, $3, 'monthly_subscription', 'unpaid', 2025, 3,
               '2025-03-01', '2025-03-15', $4, 0, $4, 0, $4, $5)`,
      [freshInvoiceId, `INV-WP3-${randomUUID().slice(0, 8)}`, freshAccountId, invoiceCentavos, adminId]
    );
    created.invoiceIds.push(freshInvoiceId);

    return { serviceAccountId: freshAccountId, invoiceId: freshInvoiceId };
  }

  it("posts a payment oldest-first, then reverses it and restores the invoice balances", async () => {
    const { token } = signTestToken({ role: "admin", sub: adminId });
    const headers = authorizationHeader(token);

    // ── Post a payment that spans both invoices ──────────────────────────────
    const postResponse = await server.inject({
      method: "POST",
      url: "/api/payments",
      headers,
      payload: {
        serviceAccountId,
        paymentMethod: "cash",
        amountCentavos: 100000,
        paymentDate: "2025-03-01",
      },
    });

    expect(postResponse.statusCode).toBe(201);
    const posted = postResponse.json().data;
    expect(posted.payment.receiptNumber).toMatch(/^OR-\d{4}-\d{6}$/);
    // Oldest invoice (50000) is filled first, then 50000 of the second.
    expect(posted.allocations).toEqual([
      { invoiceId: oldestInvoiceId, amountCentavos: 50000 },
      { invoiceId: newestInvoiceId, amountCentavos: 50000 },
    ]);
    expect(posted.allocatedCentavos + posted.advanceCreditCentavos).toBe(100000);

    // ── Verify the invoice statuses in the database ──────────────────────────
    expect(await invoiceState(oldestInvoiceId)).toMatchObject({
      status: "paid",
      paid_amount_centavos: 50000,
      remaining_balance_centavos: 0,
    });
    expect(await invoiceState(newestInvoiceId)).toMatchObject({
      status: "partially_paid",
      paid_amount_centavos: 50000,
      remaining_balance_centavos: 30000,
    });

    const paymentId = posted.payment.id as string;

    // ── Reverse the payment ──────────────────────────────────────────────────
    const reverseResponse = await server.inject({
      method: "POST",
      url: `/api/payments/${paymentId}/reverse`,
      headers,
      payload: { reason: "Cashier posted to the wrong account" },
    });

    expect(reverseResponse.statusCode).toBe(200);
    expect(reverseResponse.json().data.reversalReceiptNumber).toMatch(/^RV-\d{4}-\d{6}$/);

    // ── Verify the restoration and that nothing was deleted ──────────────────
    expect(await invoiceState(oldestInvoiceId)).toMatchObject({
      status: "unpaid",
      paid_amount_centavos: 0,
      remaining_balance_centavos: 50000,
    });
    expect(await invoiceState(newestInvoiceId)).toMatchObject({
      status: "unpaid",
      paid_amount_centavos: 0,
      remaining_balance_centavos: 80000,
    });

    const paymentRow = await pool.query(
      "SELECT status, amount_centavos FROM payments WHERE id = $1",
      [paymentId]
    );
    expect(paymentRow.rowCount).toBe(1); // the original row still exists
    expect(paymentRow.rows[0]).toMatchObject({ status: "reversed", amount_centavos: 100000 });

    const reversalRow = await pool.query(
      "SELECT reason FROM payment_reversals WHERE original_payment_id = $1",
      [paymentId]
    );
    expect(reversalRow.rowCount).toBe(1);

    // The payment credits and the reversal debit cancel exactly.
    expect(await ledgerNetCentavos()).toBe(0);
  });

  it("applies an advance credit to the next generated monthly invoice", async () => {
    const { token } = signTestToken({ role: "admin", sub: adminId });
    const headers = authorizationHeader(token);

    // A fresh, debt-free account so the whole payment becomes advance credit.
    const freshPlanId = randomUUID();
    await pool.query(
      `INSERT INTO subscription_plans
         (id, name, service_type, speed_mbps, monthly_rate_centavos, reconnection_fee_centavos, is_active, created_by)
       VALUES ($1, $2, 'internet', 25, 99900, 50000, true, $3)`,
      [freshPlanId, `Advance Credit Fiber ${freshPlanId.slice(0, 8)}`, adminId]
    );
    created.planIds.push(freshPlanId);

    const freshSubscriberId = randomUUID();
    await pool.query(
      `INSERT INTO subscribers
         (id, account_number, first_name, last_name, primary_phone, service_address,
          service_barangay, service_municipality, service_province, created_by)
       VALUES ($1, $2, 'Nestor', 'Overpaid', '09170000001', '2 Test Street',
               'Poblacion', 'Testville', 'Testprovince', $3)`,
      [freshSubscriberId, `SUB-${randomUUID().slice(0, 8)}`, adminId]
    );
    created.subscriberIds.push(freshSubscriberId);

    const freshAccountId = randomUUID();
    await pool.query(
      `INSERT INTO service_accounts
         (id, service_account_number, subscriber_id, plan_id, status, activation_date, created_by)
       VALUES ($1, $2, $3, $4, 'active', '2025-01-01', $5)`,
      [freshAccountId, `SA-${randomUUID().slice(0, 8)}`, freshSubscriberId, freshPlanId, adminId]
    );
    created.serviceAccountIds.push(freshAccountId);

    // Overpay by 300.00 with nothing owed: the payment is all advance credit.
    const postResponse = await server.inject({
      method: "POST",
      url: "/api/payments",
      headers,
      payload: {
        serviceAccountId: freshAccountId,
        paymentMethod: "cash",
        amountCentavos: 30000,
        paymentDate: "2031-07-01",
      },
    });
    expect(postResponse.statusCode).toBe(201);
    expect(postResponse.json().data.advanceCreditCentavos).toBe(30000);

    // The next billing run must consume the credit on the new invoice.
    const wasGenerated = await generateInvoiceForCandidate(
      {
        serviceAccountId: freshAccountId,
        planName: `Advance Credit Fiber ${freshPlanId.slice(0, 8)}`,
        monthlyRateCentavos: 99900,
      },
      2031,
      7,
      adminId
    );
    expect(wasGenerated).toBe(true);

    const invoiceResult = await pool.query(
      `SELECT id, status, total_amount_centavos, paid_amount_centavos, remaining_balance_centavos
         FROM invoices
        WHERE service_account_id = $1 AND billing_period_year = 2031 AND billing_period_month = 7`,
      [freshAccountId]
    );
    expect(invoiceResult.rowCount).toBe(1);
    const generatedInvoice = invoiceResult.rows[0];
    created.invoiceIds.push(generatedInvoice.id);
    expect(generatedInvoice).toMatchObject({
      status: "draft",
      total_amount_centavos: 99900,
      paid_amount_centavos: 30000,
      remaining_balance_centavos: 69900,
    });

    const allocationResult = await pool.query(
      "SELECT payment_id, allocated_amount_centavos FROM payment_allocations WHERE invoice_id = $1",
      [generatedInvoice.id]
    );
    expect(allocationResult.rowCount).toBe(1);
    expect(allocationResult.rows[0]).toMatchObject({ allocated_amount_centavos: 30000 });

    const appliedEntries = await pool.query(
      "SELECT entry_type, amount_centavos FROM ledger_entries WHERE service_account_id = $1 AND entry_type = 'advance_credit_applied'",
      [freshAccountId]
    );
    expect(appliedEntries.rows).toEqual([
      { entry_type: "advance_credit_applied", amount_centavos: 30000 },
    ]);

    // Credit consumed, invoice debt not yet posted: the net ledger balance is zero.
    const netResult = await pool.query(
      `SELECT coalesce(sum(case when entry_type in ('invoice_posted','late_fee','manual_debit','payment_reversal','advance_credit_applied')
          then amount_centavos else -amount_centavos end), 0)::int AS net
         FROM ledger_entries WHERE service_account_id = $1`,
      [freshAccountId]
    );
    expect(netResult.rows[0].net).toBe(0);
  });

  it("rejects a duplicate GCash reference number with a 409", async () => {
    const { token } = signTestToken({ role: "admin", sub: adminId });
    const headers = authorizationHeader(token);
    const referenceNumber = `GCASH-INT-${randomUUID().slice(0, 8)}`;

    const first = await server.inject({
      method: "POST",
      url: "/api/payments",
      headers,
      payload: {
        serviceAccountId,
        paymentMethod: "gcash",
        amountCentavos: 1000,
        paymentDate: "2025-03-02",
        gcash: { referenceNumber },
      },
    });
    expect(first.statusCode).toBe(201);

    const duplicate = await server.inject({
      method: "POST",
      url: "/api/payments",
      headers,
      payload: {
        serviceAccountId,
        paymentMethod: "gcash",
        amountCentavos: 1000,
        paymentDate: "2025-03-02",
        gcash: { referenceNumber },
      },
    });

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("CONFLICT");
  });

  it("posts cash, bank transfer, cheque and other through the real database (S3-1)", async () => {
    const { token } = signTestToken({ role: "admin", sub: adminId });
    const headers = authorizationHeader(token);
    const account = await createAccountWithInvoice("Methods", 200000);

    for (const paymentMethod of ["cash", "bank_transfer", "check", "other"] as const) {
      const response = await server.inject({
        method: "POST",
        url: "/api/payments",
        headers,
        payload: {
          serviceAccountId: account.serviceAccountId,
          paymentMethod,
          amountCentavos: 1000,
          paymentDate: "2025-03-03",
        },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().data.payment).toMatchObject({ paymentMethod, status: "posted" });
    }

    const stored = await pool.query(
      "SELECT payment_method, status FROM payments WHERE service_account_id = $1 ORDER BY receipt_number",
      [account.serviceAccountId]
    );
    expect(stored.rows.map((row) => row.payment_method)).toEqual([
      "cash",
      "bank_transfer",
      "check",
      "other",
    ]);
    expect(stored.rows.every((row) => row.status === "posted")).toBe(true);

    // Every one of them allocated and moved the invoice by its own amount.
    expect(await invoiceState(account.invoiceId)).toMatchObject({
      paid_amount_centavos: 4000,
      remaining_balance_centavos: 196000,
    });
  });

  it("keeps a GCash payment out of the balances until a verifier confirms it, then reverses it (S3-2, S3-6)", async () => {
    const { token } = signTestToken({ role: "admin", sub: adminId });
    const headers = authorizationHeader(token);
    const account = await createAccountWithInvoice("GcashVerification", 50000);

    const reference = `GCASH WP3 ${randomUUID().slice(0, 8)}`;
    const normalizedReference = reference.replace(/\s+/g, "").toUpperCase();

    // ── Record the claim. It must not move a single centavo. ────────────────
    const recorded = await server.inject({
      method: "POST",
      url: "/api/payments",
      headers,
      payload: {
        serviceAccountId: account.serviceAccountId,
        paymentMethod: "gcash",
        amountCentavos: 50000,
        paymentDate: "2025-03-04",
        gcash: { referenceNumber: reference },
      },
    });

    expect(recorded.statusCode).toBe(201);
    const paymentId = recorded.json().data.payment.id as string;
    expect(recorded.json().data.payment.status).toBe("pending_verification");

    expect(await invoiceState(account.invoiceId)).toMatchObject({
      status: "unpaid",
      paid_amount_centavos: 0,
      remaining_balance_centavos: 50000,
    });
    expect(await ledgerNetFor(account.serviceAccountId)).toBe(0);

    const storedClaim = await pool.query(
      "SELECT gcash_reference_number, verified_at, verified_by FROM gcash_payments WHERE payment_id = $1",
      [paymentId]
    );
    // S12-7: the reference is stored normalized, so a reformatted one collides.
    expect(storedClaim.rows[0]).toMatchObject({
      gcash_reference_number: normalizedReference,
      verified_at: null,
      verified_by: null,
    });

    const reformatted = await server.inject({
      method: "POST",
      url: "/api/payments",
      headers,
      payload: {
        serviceAccountId: account.serviceAccountId,
        paymentMethod: "gcash",
        amountCentavos: 50000,
        paymentDate: "2025-03-04",
        gcash: { referenceNumber: `  ${reference.toLowerCase().replace(/\s+/g, "  ")} ` },
      },
    });
    expect(reformatted.statusCode).toBe(409);
    expect(reformatted.json().error.code).toBe("CONFLICT");

    // ── Verify it: now it posts, allocates and retains who did it. ───────────
    const verified = await server.inject({
      method: "POST",
      url: `/api/payments/gcash/${paymentId}/verify`,
      headers,
      payload: {},
    });

    expect(verified.statusCode).toBe(200);
    expect(verified.json().data.payment.status).toBe("posted");
    expect(await invoiceState(account.invoiceId)).toMatchObject({
      status: "paid",
      paid_amount_centavos: 50000,
      remaining_balance_centavos: 0,
    });
    expect(await ledgerNetFor(account.serviceAccountId)).toBe(-50000);

    const storedVerification = await pool.query(
      "SELECT verified_at, verified_by FROM gcash_payments WHERE payment_id = $1",
      [paymentId]
    );
    expect(storedVerification.rows[0].verified_by).toBe(adminId);
    expect(storedVerification.rows[0].verified_at).not.toBeNull();

    const verifyAudit = await pool.query(
      "SELECT performed_by FROM audit_logs WHERE entity_id = $1 AND action = 'payment.gcash_verified'",
      [paymentId]
    );
    expect(verifyAudit.rowCount).toBe(1);
    expect(verifyAudit.rows[0].performed_by).toBe(adminId);

    // ── Reverse it: the money comes back and the row stops reading as posted. ─
    const reversed = await server.inject({
      method: "POST",
      url: `/api/payments/${paymentId}/reverse`,
      headers,
      payload: { reason: "Transfer was recalled by the sender" },
    });

    expect(reversed.statusCode).toBe(200);
    const storedPayment = await pool.query("SELECT status FROM payments WHERE id = $1", [paymentId]);
    expect(storedPayment.rows[0]).toMatchObject({ status: "reversed" });
    expect(await invoiceState(account.invoiceId)).toMatchObject({
      status: "unpaid",
      paid_amount_centavos: 0,
      remaining_balance_centavos: 50000,
    });
    expect(await ledgerNetFor(account.serviceAccountId)).toBe(0);
  });
});
