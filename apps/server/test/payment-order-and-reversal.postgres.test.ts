// Regression tests for three allocation/reversal defects that no whole-database
// invariant could catch, run against a real PostgreSQL database so the real SQL —
// including the ORDER BY that decides which debt is oldest — really executes.
//
//   1. ORDER. `invoice_date` is the day the DOCUMENT was printed, and one monthly
//      billing run stamps the same date on every period it generates. Ordering
//      arrears by it (and then by a random invoice UUID) settles arbitrary periods
//      and leaves genuinely older debt untouched, which is what acceptance test
//      AT-04 ("oldest-first arrears") is about. The age of a debt is its billing
//      period, so that is what must order the sweep.
//   2. REVERSAL STATUS. Reversing one payment must not relabel an invoice that still
//      holds another payment: a partly-paid invoice stays `partially_paid`.
//   3. ADVANCE-CREDIT PROVENANCE. A reversed payment's advance credit is cancelled
//      by its own reversal debit, so it can never be the source of a later
//      allocation. The surviving credit belongs to the payment that still holds it.
//
// The suite skips itself when no database answers, like the other .postgres suites.

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../src/index.ts";
import { closeDatabaseConnection, pool } from "../src/db/connection";
import { generateInvoiceForCandidate } from "../src/modules/billing/monthly-billing.service.ts";
import { authorizationHeader, signTestToken } from "./support/tokens";
import { deleteAuditLogsForUsers } from "./support/audit-cleanup";
import { deleteLedgerEntriesForServiceAccounts } from "./support/ledger-cleanup";

/** A valid bcrypt hash. Its value is never checked here — only its shape. */
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

describe.skipIf(!databaseIsReachable)("payment order and reversal against real PostgreSQL", () => {
  let server: FastifyInstance;
  let adminId: string;
  let headers: { authorization: string };

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
        "Fix Suite Admin",
        `fix.suite.admin.${adminId.slice(0, 8)}`,
        DUMMY_PASSWORD_HASH,
      ]
    );
    created.userIds.push(adminId);

    headers = authorizationHeader(signTestToken({ role: "admin", sub: adminId }).token);
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
      "DELETE FROM payment_allocations WHERE invoice_id = ANY($1::uuid[])",
      [created.invoiceIds]
    );
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

  /** A plan of its own and an active account on it, so each test owns its ledger. */
  async function createAccount(
    label: string,
    monthlyRateCentavos = 99900
  ): Promise<{ serviceAccountId: string; planName: string }> {
    const planId = randomUUID();
    const planName = `Fix Suite ${label} Fiber ${planId.slice(0, 8)}`;
    await pool.query(
      `INSERT INTO subscription_plans
         (id, name, service_type, speed_mbps, monthly_rate_centavos, reconnection_fee_centavos, is_active, created_by)
       VALUES ($1, $2, 'internet', 25, $3, 50000, true, $4)`,
      [planId, planName, monthlyRateCentavos, adminId]
    );
    created.planIds.push(planId);

    const subscriberId = randomUUID();
    await pool.query(
      `INSERT INTO subscribers
         (id, account_number, first_name, last_name, primary_phone, service_address,
          service_barangay, service_municipality, service_province, created_by)
       VALUES ($1, $2, $3, 'Fix', '09170000000', '1 Test Street',
               'Poblacion', 'Testville', 'Testprovince', $4)`,
      [subscriberId, `SUB-${randomUUID().slice(0, 8)}`, label, adminId]
    );
    created.subscriberIds.push(subscriberId);

    const serviceAccountId = randomUUID();
    await pool.query(
      `INSERT INTO service_accounts
         (id, service_account_number, subscriber_id, plan_id, status, activation_date, created_by)
       VALUES ($1, $2, $3, $4, 'active', '2026-01-01', $5)`,
      [serviceAccountId, `SA-${randomUUID().slice(0, 8)}`, subscriberId, planId, adminId]
    );
    created.serviceAccountIds.push(serviceAccountId);

    return { serviceAccountId, planName };
  }

  /**
   * One invoice fixture.
   *
   * `id` can be pinned so a test can put the UUID order the OPPOSITE way to the
   * billing-period order. That is deliberate: a test that accidentally falls back to
   * ordering by id (the defect) then fails every run instead of one run in six.
   */
  async function insertInvoice(input: {
    id?: string;
    invoiceNumber: string;
    serviceAccountId: string;
    invoiceDate: string;
    totalCentavos: number;
    invoiceType?: "monthly_subscription" | "reconnection_fee";
    billingPeriodYear?: number;
    billingPeriodMonth?: number;
  }): Promise<string> {
    const id = input.id ?? randomUUID();
    await pool.query(
      `INSERT INTO invoices
         (id, invoice_number, service_account_id, invoice_type, status, billing_period_year, billing_period_month,
          invoice_date, due_date, subtotal_centavos, late_fees_centavos, total_amount_centavos,
          paid_amount_centavos, remaining_balance_centavos, created_by)
       VALUES ($1, $2, $3, $4, 'unpaid', $5, $6, $7, $7, $8, 0, $8, 0, $8, $9)`,
      [
        id,
        input.invoiceNumber,
        input.serviceAccountId,
        input.invoiceType ?? "monthly_subscription",
        input.billingPeriodYear ?? null,
        input.billingPeriodMonth ?? null,
        input.invoiceDate,
        input.totalCentavos,
        adminId,
      ]
    );
    created.invoiceIds.push(id);
    return id;
  }

  async function postCashPayment(
    serviceAccountId: string,
    amountCentavos: number,
    paymentDate: string
  ): Promise<{
    payment: { id: string; status: string };
    allocations: { invoiceNumber: string; allocatedAmountCentavos: number }[];
    advanceCreditCentavos: number;
  }> {
    const response = await server.inject({
      method: "POST",
      url: "/api/payments",
      headers,
      payload: { serviceAccountId, paymentMethod: "cash", amountCentavos, paymentDate },
    });
    expect(response.statusCode).toBe(201);
    return response.json().data;
  }

  async function reversePayment(paymentId: string, reason: string): Promise<void> {
    const response = await server.inject({
      method: "POST",
      url: `/api/payments/${paymentId}/reverse`,
      headers,
      payload: { reason },
    });
    expect(response.statusCode).toBe(200);
  }

  async function invoiceState(invoiceId: string) {
    const result = await pool.query(
      "SELECT status, paid_amount_centavos, remaining_balance_centavos FROM invoices WHERE id = $1",
      [invoiceId]
    );
    return result.rows[0];
  }

  /** The net of one account's ledger, with the same direction rule the app uses. */
  async function ledgerNetCentavos(serviceAccountId: string): Promise<number> {
    const result = await pool.query(
      `SELECT coalesce(sum(case
          when entry_type in ('invoice_posted','late_fee','manual_debit','payment_reversal','advance_credit_applied')
            then amount_centavos else -amount_centavos end), 0)::int AS net
         FROM ledger_entries WHERE service_account_id = $1`,
      [serviceAccountId]
    );
    return result.rows[0].net;
  }

  // ─── Defect 1: allocation ignores the billing period ───────────────────────

  it("settles shared-invoice-date invoices in billing-period order (AT-04)", async () => {
    const account = await createAccount("Period Order");

    // Every invoice shares ONE invoice_date, exactly as one monthly billing run
    // produces. Only the billing period distinguishes them. The pinned ids run the
    // other way round on purpose, so ordering by id can only produce the wrong answer.
    const june = await insertInvoice({
      id: "ffffffff-0000-4000-8000-000000000003",
      invoiceNumber: "INV-FIX-PERIOD-JUN",
      serviceAccountId: account.serviceAccountId,
      billingPeriodYear: 2026,
      billingPeriodMonth: 6,
      invoiceDate: "2026-10-09",
      totalCentavos: 10000,
    });
    const july = await insertInvoice({
      id: "ffffffff-0000-4000-8000-000000000002",
      invoiceNumber: "INV-FIX-PERIOD-JUL",
      serviceAccountId: account.serviceAccountId,
      billingPeriodYear: 2026,
      billingPeriodMonth: 7,
      invoiceDate: "2026-10-09",
      totalCentavos: 10000,
    });
    const august = await insertInvoice({
      id: "ffffffff-0000-4000-8000-000000000001",
      invoiceNumber: "INV-FIX-PERIOD-AUG",
      serviceAccountId: account.serviceAccountId,
      billingPeriodYear: 2026,
      billingPeriodMonth: 8,
      invoiceDate: "2026-10-09",
      totalCentavos: 10000,
    });

    const posted = await postCashPayment(account.serviceAccountId, 20000, "2026-10-10");

    // The two OLDEST periods are settled; the newest is untouched.
    expect(posted.allocations.map((allocation) => allocation.invoiceNumber)).toEqual([
      "INV-FIX-PERIOD-JUN",
      "INV-FIX-PERIOD-JUL",
    ]);
    expect(await invoiceState(june)).toMatchObject({ status: "paid", paid_amount_centavos: 10000 });
    expect(await invoiceState(july)).toMatchObject({ status: "paid", paid_amount_centavos: 10000 });
    expect(await invoiceState(august)).toMatchObject({
      status: "unpaid",
      paid_amount_centavos: 0,
      remaining_balance_centavos: 10000,
    });
  });

  it("gives a one-off charge its own date, not the oldest or newest place", async () => {
    const account = await createAccount("One-off Order");

    // Three periods share one invoice_date again, and two one-off charges have NO
    // billing period: one issued after the June period started and before July, one
    // issued after every period. A NULL period must not mean "oldest" or "newest".
    await insertInvoice({
      id: "eeeeeeee-0000-4000-8000-000000000005",
      invoiceNumber: "INV-FIX-ONEOFF-JUN",
      serviceAccountId: account.serviceAccountId,
      billingPeriodYear: 2026,
      billingPeriodMonth: 6,
      invoiceDate: "2026-10-09",
      totalCentavos: 10000,
    });
    await insertInvoice({
      id: "eeeeeeee-0000-4000-8000-000000000004",
      invoiceNumber: "INV-FIX-ONEOFF-FEE-OLD",
      serviceAccountId: account.serviceAccountId,
      invoiceType: "reconnection_fee",
      invoiceDate: "2026-06-15",
      totalCentavos: 10000,
    });
    await insertInvoice({
      id: "eeeeeeee-0000-4000-8000-000000000003",
      invoiceNumber: "INV-FIX-ONEOFF-JUL",
      serviceAccountId: account.serviceAccountId,
      billingPeriodYear: 2026,
      billingPeriodMonth: 7,
      invoiceDate: "2026-10-09",
      totalCentavos: 10000,
    });
    await insertInvoice({
      id: "eeeeeeee-0000-4000-8000-000000000002",
      invoiceNumber: "INV-FIX-ONEOFF-AUG",
      serviceAccountId: account.serviceAccountId,
      billingPeriodYear: 2026,
      billingPeriodMonth: 8,
      invoiceDate: "2026-10-09",
      totalCentavos: 10000,
    });
    await insertInvoice({
      id: "eeeeeeee-0000-4000-8000-000000000001",
      invoiceNumber: "INV-FIX-ONEOFF-FEE-NEW",
      serviceAccountId: account.serviceAccountId,
      invoiceType: "reconnection_fee",
      invoiceDate: "2026-10-09",
      totalCentavos: 10000,
    });

    // 45000 of the 50000 owed: everything but the last 5000 of the newest fee.
    const posted = await postCashPayment(account.serviceAccountId, 45000, "2026-10-10");

    expect(posted.allocations).toEqual([
      { invoiceId: expect.any(String), invoiceNumber: "INV-FIX-ONEOFF-JUN", allocatedAmountCentavos: 10000 },
      { invoiceId: expect.any(String), invoiceNumber: "INV-FIX-ONEOFF-FEE-OLD", allocatedAmountCentavos: 10000 },
      { invoiceId: expect.any(String), invoiceNumber: "INV-FIX-ONEOFF-JUL", allocatedAmountCentavos: 10000 },
      { invoiceId: expect.any(String), invoiceNumber: "INV-FIX-ONEOFF-AUG", allocatedAmountCentavos: 10000 },
      { invoiceId: expect.any(String), invoiceNumber: "INV-FIX-ONEOFF-FEE-NEW", allocatedAmountCentavos: 5000 },
    ]);
  });

  // ─── Defect 2: reversing a payment resets a partly-paid invoice ────────────

  it("keeps an invoice partially_paid while another payment still covers part of it", async () => {
    const account = await createAccount("Reversal Status");
    const invoiceId = await insertInvoice({
      invoiceNumber: "INV-FIX-REVERSAL",
      serviceAccountId: account.serviceAccountId,
      billingPeriodYear: 2026,
      billingPeriodMonth: 5,
      invoiceDate: "2026-05-01",
      totalCentavos: 50000,
    });

    const first = await postCashPayment(account.serviceAccountId, 30000, "2026-05-02");
    const second = await postCashPayment(account.serviceAccountId, 10000, "2026-05-03");
    expect(await invoiceState(invoiceId)).toMatchObject({
      status: "partially_paid",
      paid_amount_centavos: 40000,
      remaining_balance_centavos: 10000,
    });

    // Reversing the second payment leaves the first 30000 applied, so the invoice is
    // STILL partially paid — never relabelled `unpaid` while holding money.
    await reversePayment(second.payment.id, "Duplicate receipt for the same deposit");
    expect(await invoiceState(invoiceId)).toMatchObject({
      status: "partially_paid",
      paid_amount_centavos: 30000,
      remaining_balance_centavos: 20000,
    });

    // With nothing left applied, `unpaid` is the correct status.
    await reversePayment(first.payment.id, "Posted against the wrong account");
    expect(await invoiceState(invoiceId)).toMatchObject({
      status: "unpaid",
      paid_amount_centavos: 0,
      remaining_balance_centavos: 50000,
    });
  });

  // ─── Defect 3: a reversed payment is credited with funding a later invoice ──

  it("never credits a reversed payment with funding a later invoice", async () => {
    const account = await createAccount("Advance Credit Provenance");

    // No invoice and no debt, so both payments become advance credit.
    const first = await postCashPayment(account.serviceAccountId, 10000, "2031-07-01");
    const second = await postCashPayment(account.serviceAccountId, 20000, "2031-07-02");
    expect(first.advanceCreditCentavos).toBe(10000);
    expect(second.advanceCreditCentavos).toBe(20000);

    // Reversing the second cancels its 20000; the 10000 the first holds survives.
    await reversePayment(second.payment.id, "Second deposit credited in error");
    expect(await ledgerNetCentavos(account.serviceAccountId)).toBe(-10000);

    // A later invoice consumes the surviving credit — and must name the POSTED
    // payment as its source, never the reversed one.
    const wasGenerated = await generateInvoiceForCandidate(
      {
        serviceAccountId: account.serviceAccountId,
        planName: account.planName,
        monthlyRateCentavos: 99900,
      },
      2031,
      7,
      adminId
    );
    expect(wasGenerated).toBe(true);

    const generatedInvoice = await pool.query(
      `SELECT id, paid_amount_centavos, remaining_balance_centavos
         FROM invoices
        WHERE service_account_id = $1 AND billing_period_year = 2031 AND billing_period_month = 7`,
      [account.serviceAccountId]
    );
    expect(generatedInvoice.rowCount).toBe(1);
    created.invoiceIds.push(generatedInvoice.rows[0].id);
    expect(generatedInvoice.rows[0]).toMatchObject({
      paid_amount_centavos: 10000,
      remaining_balance_centavos: 89900,
    });

    const allocations = await pool.query(
      "SELECT payment_id, allocated_amount_centavos FROM payment_allocations WHERE invoice_id = $1",
      [generatedInvoice.rows[0].id]
    );
    expect(allocations.rows).toEqual([
      { payment_id: first.payment.id, allocated_amount_centavos: 10000 },
    ]);

    // The money did not change — only which payment owns the credit: the same 10000
    // of credit was consumed, so the account is back to a zero net balance.
    expect(await ledgerNetCentavos(account.serviceAccountId)).toBe(0);
  });
});
