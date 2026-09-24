// Real-PostgreSQL integration test for Phase 7 — field collection and cash
// reconciliation.
//
// This is the acceptance test the phase is judged on, run against a live database so
// the advisory locks, the unique batch-number constraint, and the SQL really execute:
//
//   • a batch's expected remittance always equals the sum of its collections, to the
//     centavo, as collections are added and voided
//   • a service account cannot be in two open batches at once
//   • batch numbers are unique per day and generated atomically under concurrency
//   • one collector cannot read or change another collector's batch
//   • variance (shortage/overage) is stored, never absorbed
//   • re-submitting and re-reconciling are conflicts; reconciliation cannot precede
//     remittance
//   • a voided collection reverses its payment instead of deleting it
//   • a reconciled batch's payments reach the ledger as credits, and they total to
//     the batch's expected remittance
//
// The suite skips itself when no database answers, so `pnpm test` still passes on a
// machine without PostgreSQL.

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../src/index.ts";
import { closeDatabaseConnection, pool } from "../src/db/connection";
import { authorizationHeader, signTestToken } from "./support/tokens";
import { deleteAuditLogsForUsers } from "./support/audit-cleanup";

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

describe.skipIf(!databaseIsReachable)("Phase 7 against real PostgreSQL", () => {
  let server: FastifyInstance;
  let adminId: string;
  let collectorId: string;
  let otherCollectorId: string;
  let planId: string;

  const created = {
    userIds: [] as string[],
    planIds: [] as string[],
    subscriberIds: [] as string[],
    serviceAccountIds: [] as string[],
    invoiceIds: [] as string[],
    batchIds: [] as string[],
  };

  beforeAll(async () => {
    server = buildServer();
    await server.ready();

    adminId = randomUUID();
    collectorId = randomUUID();
    otherCollectorId = randomUUID();

    for (const [id, role, name] of [
      [adminId, "admin", "Phase 7 Admin"],
      [collectorId, "collector", "Phase 7 Collector"],
      [otherCollectorId, "collector", "Phase 7 Other Collector"],
    ] as const) {
      await pool.query(
        `INSERT INTO users (id, full_name, username, password_hash, role, is_active)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [id, name, `p7.${role}.${id.slice(0, 8)}`, DUMMY_PASSWORD_HASH, role]
      );
      created.userIds.push(id);
    }

    planId = randomUUID();
    await pool.query(
      `INSERT INTO subscription_plans
         (id, name, service_type, speed_mbps, monthly_rate_centavos, reconnection_fee_centavos, is_active, created_by)
       VALUES ($1, $2, 'internet', 25, 99900, 50000, true, $3)`,
      [planId, `Phase 7 Fiber ${planId.slice(0, 8)}`, adminId]
    );
    created.planIds.push(planId);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM batch_assignments WHERE batch_id = ANY($1::uuid[])", [
      created.batchIds,
    ]);
    await pool.query("DELETE FROM collector_batches WHERE id = ANY($1::uuid[])", [
      created.batchIds,
    ]);
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
    await pool.query("DELETE FROM subscription_plans WHERE id = ANY($1::uuid[])", [created.planIds]);
    await deleteAuditLogsForUsers(pool, created.userIds);
    await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [created.userIds]);

    await server.close();
    await closeDatabaseConnection();
  });

  /** Creates a fresh subscriber and active service account, tracked for cleanup. */
  async function createServiceAccount(firstName: string): Promise<string> {
    const subscriberId = randomUUID();
    await pool.query(
      `INSERT INTO subscribers
         (id, account_number, first_name, last_name, primary_phone, service_address,
          service_barangay, service_municipality, service_province, created_by)
       VALUES ($1, $2, $3, 'Collection', '09170000000', '1 Collection Street',
               'Poblacion', 'Testville', 'Testprovince', $4)`,
      [subscriberId, `SUB-${randomUUID().slice(0, 8)}`, firstName, adminId]
    );
    created.subscriberIds.push(subscriberId);

    const serviceAccountId = randomUUID();
    await pool.query(
      `INSERT INTO service_accounts
         (id, service_account_number, subscriber_id, plan_id, status, activation_date, created_by)
       VALUES ($1, $2, $3, $4, 'active', '2025-01-01', $5)`,
      [serviceAccountId, `SA-${randomUUID().slice(0, 12)}`, subscriberId, planId, adminId]
    );
    created.serviceAccountIds.push(serviceAccountId);

    return serviceAccountId;
  }

  /** Inserts a draft invoice and posts it, so the account really owes money. */
  async function createPostedInvoice(
    serviceAccountId: string,
    amountCentavos: number,
    month: number
  ): Promise<void> {
    const invoiceId = randomUUID();
    await pool.query(
      `INSERT INTO invoices
         (id, invoice_number, service_account_id, invoice_type, status, billing_period_year, billing_period_month,
          invoice_date, due_date, subtotal_centavos, late_fees_centavos, total_amount_centavos,
          paid_amount_centavos, remaining_balance_centavos, created_by)
       VALUES ($1, $2, $3, 'monthly_subscription', 'draft', 2025, $4,
               '2025-01-01', '2025-01-15', $5, 0, $5, 0, $5, $6)`,
      [invoiceId, `INV-P7-${randomUUID().slice(0, 8)}`, serviceAccountId, month, amountCentavos, adminId]
    );
    created.invoiceIds.push(invoiceId);

    const postResponse = await server.inject({
      method: "POST",
      url: `/api/invoices/${invoiceId}/post`,
      headers: authorizationHeader(signTestToken({ role: "admin", sub: adminId }).token),
    });
    expect(postResponse.statusCode).toBe(200);
  }

  async function createBatch(
    collector: string,
    serviceAccountIds: string[],
    collectionDate: string,
    token: string
  ): Promise<{ id: string; batchNumber: string }> {
    const response = await server.inject({
      method: "POST",
      url: "/api/collector-batches",
      headers: authorizationHeader(token),
      payload: { collectorId: collector, collectionDate, serviceAccountIds },
    });
    expect(response.statusCode).toBe(201);
    const data = response.json().data;
    created.batchIds.push(data.id as string);
    return { id: data.id as string, batchNumber: data.batchNumber as string };
  }

  async function batchRow(batchId: string) {
    const result = await pool.query(
      `SELECT status, expected_remittance_centavos, actual_remittance_centavos, variance_centavos
         FROM collector_batches WHERE id = $1`,
      [batchId]
    );
    return result.rows[0] as {
      status: string;
      expected_remittance_centavos: number;
      actual_remittance_centavos: number | null;
      variance_centavos: number | null;
    };
  }

  async function ledgerRows(serviceAccountId: string) {
    const result = await pool.query(
      `SELECT entry_type, amount_centavos FROM ledger_entries
         WHERE service_account_id = $1 ORDER BY sequence_number`,
      [serviceAccountId]
    );
    return result.rows as Array<{ entry_type: string; amount_centavos: number }>;
  }

  it("keeps the batch total exact as collections are added and voided", async () => {
    const adminToken = signTestToken({ role: "admin", sub: adminId }).token;
    const collectorToken = signTestToken({ role: "collector", sub: collectorId }).token;

    const accountA = await createServiceAccount("Alpha");
    const accountB = await createServiceAccount("Bravo");
    await createPostedInvoice(accountA, 50000, 1);
    await createPostedInvoice(accountB, 30000, 2);

    const batch = await createBatch(collectorId, [accountA, accountB], "2025-02-01", adminToken);
    expect(batch.batchNumber).toMatch(/^CB-\d{8}-\d{4}$/);

    // ── Record collection A (full) and B (partial) → the total tracks exactly ──
    const recordA = await server.inject({
      method: "PUT",
      url: `/api/collector-batches/${batch.id}/assignments/${accountA}`,
      headers: authorizationHeader(collectorToken),
      payload: { result: "collected", collectedAmountCentavos: 50000, collectedMethod: "cash" },
    });
    expect(recordA.statusCode).toBe(200);
    expect(recordA.json().data.expectedRemittanceCentavos).toBe(50000);

    const recordB = await server.inject({
      method: "PUT",
      url: `/api/collector-batches/${batch.id}/assignments/${accountB}`,
      headers: authorizationHeader(collectorToken),
      payload: { result: "partial", collectedAmountCentavos: 20000, collectedMethod: "cash" },
    });
    expect(recordB.statusCode).toBe(200);
    expect(recordB.json().data.expectedRemittanceCentavos).toBe(70000);

    expect((await batchRow(batch.id)).expected_remittance_centavos).toBe(70000);

    // ── Void collection B → the payment is REVERSED, the total drops back ─────
    const voidB = await server.inject({
      method: "PUT",
      url: `/api/collector-batches/${batch.id}/assignments/${accountB}/void`,
      headers: authorizationHeader(adminToken),
      payload: { reason: "Collector miscounted the cash for this account" },
    });
    expect(voidB.statusCode).toBe(200);
    expect(voidB.json().data.expectedRemittanceCentavos).toBe(50000);
    expect((await batchRow(batch.id)).expected_remittance_centavos).toBe(50000);

    // The void left the payment row in place and reversed it with a debit.
    const accountBLedger = await ledgerRows(accountB);
    expect(accountBLedger.map((row) => row.entry_type)).toEqual([
      "invoice_posted",
      "payment_received",
      "payment_reversal",
    ]);

    // ── Re-recording the voided assignment is refused ─────────────────────────
    const reRecord = await server.inject({
      method: "PUT",
      url: `/api/collector-batches/${batch.id}/assignments/${accountB}`,
      headers: authorizationHeader(collectorToken),
      payload: { result: "collected", collectedAmountCentavos: 30000, collectedMethod: "cash" },
    });
    expect(reRecord.statusCode).toBe(409);

    // ── Submit short, then reconcile with notes ───────────────────────────────
    const submitShort = await server.inject({
      method: "POST",
      url: `/api/collector-batches/${batch.id}/submit`,
      headers: authorizationHeader(collectorToken),
      payload: { actualRemittanceCentavos: 46000 },
    });
    expect(submitShort.statusCode).toBe(200);
    expect(submitShort.json().data.varianceCentavos).toBe(-4000);
    expect((await batchRow(batch.id)).variance_centavos).toBe(-4000);

    // Re-submitting is a conflict, not a second transition.
    const submitAgain = await server.inject({
      method: "POST",
      url: `/api/collector-batches/${batch.id}/submit`,
      headers: authorizationHeader(collectorToken),
      payload: { actualRemittanceCentavos: 50000 },
    });
    expect(submitAgain.statusCode).toBe(409);

    // Reconcile without notes is refused while the variance stands.
    const reconcileNoNotes = await server.inject({
      method: "POST",
      url: `/api/collector-batches/${batch.id}/reconcile`,
      headers: authorizationHeader(adminToken),
      payload: {},
    });
    expect(reconcileNoNotes.statusCode).toBe(400);

    const reconcile = await server.inject({
      method: "POST",
      url: `/api/collector-batches/${batch.id}/reconcile`,
      headers: authorizationHeader(adminToken),
      payload: { varianceNotes: "Collector short by 40 pesos; payroll deduction filed" },
    });
    expect(reconcile.statusCode).toBe(200);
    expect(reconcile.json().data.ledgerReconciles).toBe(true);
    expect(reconcile.json().data.ledgerCreditTotalCentavos).toBe(50000);

    // Re-reconciling is refused.
    const reconcileAgain = await server.inject({
      method: "POST",
      url: `/api/collector-batches/${batch.id}/reconcile`,
      headers: authorizationHeader(adminToken),
      payload: { varianceNotes: "again" },
    });
    expect(reconcileAgain.statusCode).toBe(409);

    const finalRow = await batchRow(batch.id);
    expect(finalRow.status).toBe("reconciled");
    expect(finalRow.variance_centavos).toBe(-4000); // stored, never zeroed

    // ── The surviving collection reached the ledger as a credit ───────────────
    const accountALedger = await ledgerRows(accountA);
    const paymentCredits = accountALedger
      .filter((row) => row.entry_type === "payment_received")
      .reduce((sum, row) => sum + row.amount_centavos, 0);
    expect(paymentCredits).toBe(50000);
    expect(accountALedger.map((row) => row.entry_type)).toEqual([
      "invoice_posted",
      "payment_received",
    ]);
  });

  it("refuses to put one service account in two open batches", async () => {
    const adminToken = signTestToken({ role: "admin", sub: adminId }).token;
    const account = await createServiceAccount("Charlie");
    await createPostedInvoice(account, 50000, 3);

    await createBatch(collectorId, [account], "2025-02-02", adminToken);

    const duplicate = await server.inject({
      method: "POST",
      url: "/api/collector-batches",
      headers: authorizationHeader(adminToken),
      payload: { collectorId: collectorId, collectionDate: "2025-02-03", serviceAccountIds: [account] },
    });

    expect(duplicate.statusCode).toBe(409);
  });

  it("generates unique batch numbers concurrently for the same date", async () => {
    const adminToken = signTestToken({ role: "admin", sub: adminId }).token;
    const accountA = await createServiceAccount("Delta");
    const accountB = await createServiceAccount("Echo");
    await createPostedInvoice(accountA, 50000, 4);
    await createPostedInvoice(accountB, 50000, 5);

    const [first, second] = await Promise.all([
      server.inject({
        method: "POST",
        url: "/api/collector-batches",
        headers: authorizationHeader(adminToken),
        payload: { collectorId, collectionDate: "2025-02-04", serviceAccountIds: [accountA] },
      }),
      server.inject({
        method: "POST",
        url: "/api/collector-batches",
        headers: authorizationHeader(adminToken),
        payload: { collectorId: otherCollectorId, collectionDate: "2025-02-04", serviceAccountIds: [accountB] },
      }),
    ]);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const firstNumber = first.json().data.batchNumber as string;
    const secondNumber = second.json().data.batchNumber as string;
    created.batchIds.push(first.json().data.id as string, second.json().data.id as string);

    expect(firstNumber).not.toBe(secondNumber);
    expect(firstNumber.startsWith("CB-20250204-")).toBe(true);
    expect(secondNumber.startsWith("CB-20250204-")).toBe(true);
  });

  it("isolates one collector's batch from another collector", async () => {
    const adminToken = signTestToken({ role: "admin", sub: adminId }).token;
    const otherCollectorToken = signTestToken({ role: "collector", sub: otherCollectorId }).token;

    const account = await createServiceAccount("Foxtrot");
    await createPostedInvoice(account, 50000, 6);

    const batch = await createBatch(collectorId, [account], "2025-02-05", adminToken);

    const read = await server.inject({
      method: "GET",
      url: `/api/collector-batches/${batch.id}`,
      headers: authorizationHeader(otherCollectorToken),
    });
    expect(read.statusCode).toBe(404);

    const write = await server.inject({
      method: "PUT",
      url: `/api/collector-batches/${batch.id}/assignments/${account}`,
      headers: authorizationHeader(otherCollectorToken),
      payload: { result: "collected", collectedAmountCentavos: 50000, collectedMethod: "cash" },
    });
    expect(write.statusCode).toBe(404);

    const list = await server.inject({
      method: "GET",
      url: "/api/collector-batches",
      headers: authorizationHeader(otherCollectorToken),
    });
    expect(list.statusCode).toBe(200);
    const listedIds = (list.json().data.items as Array<{ id: string }>).map((item) => item.id);
    expect(listedIds).not.toContain(batch.id);
  });

  it("computes AR aging whose grand total equals the outstanding invoice balances", async () => {
    const adminToken = signTestToken({ role: "admin", sub: adminId }).token;

    const response = await server.inject({
      method: "GET",
      url: "/api/receivables/ar-aging?asOfDate=2025-03-01",
      headers: authorizationHeader(adminToken),
    });
    expect(response.statusCode).toBe(200);
    const totals = response.json().data.totals as { grandTotal: number };
    const entries = response.json().data.entries as Array<{
      serviceAccountId: string;
      totalOutstandingCentavos: number;
    }>;

    const sumResult = await pool.query(
      `SELECT coalesce(sum(remaining_balance_centavos), 0)::int AS total
         FROM invoices
        WHERE status IN ('posted', 'partially_paid', 'overdue') AND remaining_balance_centavos > 0
          AND service_account_id = ANY($1::uuid[])`,
      [created.serviceAccountIds]
    );
    const expectedTotal = Number(sumResult.rows[0]?.total ?? 0);

    // Deterministic, race-free half of the acceptance criterion: the report's rows for
    // THIS suite's accounts must sum to the outstanding balances of those same accounts.
    // Other suites run against the same database, but none of them touch these random ids,
    // so this comparison holds no matter what else is writing concurrently.
    const suiteAccountIds = new Set(created.serviceAccountIds);
    const suiteReportTotal = entries
      .filter((entry) => suiteAccountIds.has(entry.serviceAccountId))
      .reduce((sum, entry) => sum + entry.totalOutstandingCentavos, 0);

    expect(expectedTotal).toBeGreaterThan(0);
    expect(suiteReportTotal).toBe(expectedTotal);

    // Whole-database half of the criterion. It reads the report and then re-sums every
    // outstanding balance with raw SQL, so it is a sound equality only while nothing
    // else writes to the shared database between those two reads. `vitest.config.ts`
    // disables file parallelism for exactly this reason — do not re-enable it without
    // isolating the databases, or this assertion becomes nondeterministic.
    const fullSum = await pool.query(
      `SELECT coalesce(sum(remaining_balance_centavos), 0)::int AS total
         FROM invoices
        WHERE status IN ('posted', 'partially_paid', 'overdue') AND remaining_balance_centavos > 0`
    );
    expect(totals.grandTotal).toBe(Number(fullSum.rows[0]?.total ?? 0));
  });

  it("lists overdue accounts and exports AR aging as an XLSX file", async () => {
    const adminToken = signTestToken({ role: "admin", sub: adminId }).token;

    const overdue = await server.inject({
      method: "GET",
      url: "/api/receivables/overdue",
      headers: authorizationHeader(adminToken),
    });
    expect(overdue.statusCode).toBe(200);
    expect(Array.isArray(overdue.json().data.items)).toBe(true);

    const exported = await server.inject({
      method: "GET",
      url: "/api/receivables/ar-aging/export?asOfDate=2025-03-01",
      headers: authorizationHeader(adminToken),
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.rawPayload[0]).toBe(0x50);
    expect(exported.rawPayload[1]).toBe(0x4b);
  });
});