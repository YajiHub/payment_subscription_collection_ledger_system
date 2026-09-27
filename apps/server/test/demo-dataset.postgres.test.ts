// The demo dataset, checked against a real PostgreSQL database (S9-1 … S9-3).
//
// The suite generates the dataset through the real domain services, then proves
// THREE things by QUERYING THE DATABASE — never the generator's own bookkeeping:
//
//   • every section 8 minimum is present, in the counts it asks for;
//   • the ledger reconciles (debits minus credits equals the outstanding invoice
//     balances) and the AR aging buckets sum to the outstanding total;
//   • every invoice and receipt number is unique.
//
// It then proves S9-2 for real: it removes the demo rows, runs the generator again
// with the same seed, and requires identical counts and identical totals.
//
// The suite skips itself when no database answers, exactly like the other
// `.postgres.test.ts` suites.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { classifyInvoiceAge, type AgingBucket } from "@bcis/shared";
import { closeDatabaseConnection, pool } from "../src/db/connection";
import { generateDemoDataset, assertDemoTargetIsSafe, type DemoDatasetSummary } from "../src/db/demo/demo-dataset";
import { utcMidnightOfDay } from "../src/shared/date";
import { deleteDemoDataset } from "./support/demo-cleanup";

const SEED = 20_250_115;

/** Every debit entry type, spelled out so the reconciliation query cannot drift silently. */
const DEBIT_ENTRY_TYPES = [
  "invoice_posted",
  "late_fee",
  "manual_debit",
  "payment_reversal",
  "advance_credit_applied",
] as const;

async function isDatabaseReachable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

const databaseIsReachable = await isDatabaseReachable();

/** The counts and totals the assertions compare, read straight from the database. */
interface DemoSnapshot {
  counts: Record<string, number>;
  totals: Record<string, number>;
}

/** One row of a scalar-count query, as a map of column name to number. */
async function queryCounts(sql: string): Promise<Record<string, number>> {
  const result = await pool.query(sql);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) {
    throw new Error("Snapshot query returned no row");
  }
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(row)) {
    counts[key] = Number(value);
  }
  return counts;
}

/** Reads the whole demo dataset's counts and totals from the database. */
async function loadDemoSnapshot(): Promise<DemoSnapshot> {
  const counts = await queryCounts(`
    WITH demo_subscribers AS (
      SELECT id FROM subscribers WHERE internal_notes LIKE 'DEMO-DATA%'
    ),
    demo_accounts AS (
      SELECT sa.id, sp.service_type
        FROM service_accounts sa
        JOIN subscription_plans sp ON sp.id = sa.plan_id
       WHERE sa.subscriber_id IN (SELECT id FROM demo_subscribers)
    ),
    demo_invoices AS (
      SELECT i.service_account_id, i.status, i.remaining_balance_centavos,
             i.billing_period_year, i.billing_period_month
        FROM invoices i
       WHERE i.service_account_id IN (SELECT id FROM demo_accounts)
    ),
    demo_payments AS (
      SELECT p.id, p.payment_method, p.status, p.advance_credit_centavos
        FROM payments p
       WHERE p.service_account_id IN (SELECT id FROM demo_accounts)
    ),
    demo_collectors AS (
      SELECT id FROM users WHERE username LIKE 'demo.collector.%'
    )
    SELECT
      (SELECT count(*) FROM users WHERE username LIKE 'demo.%')::int AS users,
      (SELECT count(*) FROM users WHERE username LIKE 'demo.collector.%' AND role = 'collector')::int AS collectors,
      (SELECT count(*) FROM collection_areas WHERE code LIKE 'DEMO-%')::int AS areas,
      (SELECT count(*) FROM subscription_plans WHERE name LIKE 'Demo %')::int AS plans,
      (SELECT count(*) FROM subscription_plans WHERE name LIKE 'Demo %' AND service_type = 'internet')::int AS internet_plans,
      (SELECT count(*) FROM subscription_plans WHERE name LIKE 'Demo %' AND service_type = 'cable_tv')::int AS cable_plans,
      (SELECT count(*) FROM subscription_plans WHERE name LIKE 'Demo %' AND service_type = 'bundle')::int AS combo_plans,
      (SELECT count(*) FROM demo_subscribers)::int AS subscribers,
      (SELECT count(*) FROM demo_accounts)::int AS service_accounts,
      (SELECT count(*) FROM demo_accounts WHERE service_type = 'internet')::int AS internet_accounts,
      (SELECT count(*) FROM demo_accounts WHERE service_type = 'cable_tv')::int AS cable_accounts,
      (SELECT count(*) FROM demo_accounts WHERE service_type = 'bundle')::int AS combo_accounts,
      (SELECT count(DISTINCT (billing_period_year, billing_period_month)) FROM demo_invoices WHERE billing_period_year IS NOT NULL)::int AS billing_months,
      (SELECT count(*) FROM demo_invoices)::int AS invoices,
      (SELECT count(*) FROM demo_payments)::int AS payments,
      (SELECT count(*) FROM demo_payments WHERE payment_method = 'cash')::int AS cash_payments,
      (SELECT count(*) FROM demo_payments WHERE payment_method = 'gcash')::int AS gcash_payments,
      (SELECT count(*) FROM gcash_payments g JOIN demo_payments p ON p.id = g.payment_id WHERE g.verified_at IS NOT NULL)::int AS verified_gcash_payments,
      (SELECT count(*) FROM gcash_payments g JOIN demo_payments p ON p.id = g.payment_id WHERE p.status = 'pending_verification')::int AS pending_gcash_payments,
      (SELECT count(*) FROM gcash_payments g JOIN demo_payments p ON p.id = g.payment_id WHERE g.rejected_at IS NOT NULL)::int AS rejected_gcash_payments,
      (SELECT count(*) FROM demo_payments WHERE status = 'reversed')::int AS reversed_payments,
      (SELECT count(DISTINCT pa.payment_id)
         FROM payment_allocations pa
         JOIN invoices i ON i.id = pa.invoice_id
        WHERE i.service_account_id IN (SELECT id FROM demo_accounts)
          AND i.status = 'partially_paid')::int AS partial_payments,
      (SELECT count(*) FROM demo_payments WHERE advance_credit_centavos > 0)::int AS advance_credit_payments,
      (SELECT count(DISTINCT service_account_id) FROM demo_invoices
        WHERE status IN ('unpaid', 'partially_paid', 'overdue')
          AND remaining_balance_centavos > 0)::int AS overdue_accounts,
      (SELECT count(*) FROM suspension_records WHERE service_account_id IN (SELECT id FROM demo_accounts))::int AS suspension_records,
      (SELECT count(*) FROM reconnection_records WHERE service_account_id IN (SELECT id FROM demo_accounts))::int AS reconnection_records,
      (SELECT count(*) FROM collector_batches WHERE collector_id IN (SELECT id FROM demo_collectors))::int AS collector_batches
  `);

  const totals = await queryCounts(`
    WITH demo_accounts AS (
      SELECT sa.id
        FROM service_accounts sa
       WHERE sa.subscriber_id IN (
         SELECT id FROM subscribers WHERE internal_notes LIKE 'DEMO-DATA%'
       )
    )
    SELECT
      (SELECT coalesce(sum(total_amount_centavos), 0)
         FROM invoices WHERE service_account_id IN (SELECT id FROM demo_accounts))::int AS invoiced_centavos,
      (SELECT coalesce(sum(amount_centavos), 0)
         FROM payments
        WHERE service_account_id IN (SELECT id FROM demo_accounts)
          AND status = 'posted')::int AS collected_centavos,
      (SELECT coalesce(sum(remaining_balance_centavos), 0)
         FROM invoices
        WHERE service_account_id IN (SELECT id FROM demo_accounts)
          AND status IN ('unpaid', 'partially_paid', 'overdue')
          AND remaining_balance_centavos > 0)::int AS outstanding_centavos,
      (SELECT coalesce(sum(
                CASE WHEN entry_type::text = ANY(ARRAY['invoice_posted', 'late_fee', 'manual_debit', 'payment_reversal', 'advance_credit_applied'])
                     THEN amount_centavos ELSE -amount_centavos END), 0)
         FROM ledger_entries
        WHERE service_account_id IN (SELECT id FROM demo_accounts))::int AS ledger_net_centavos
  `);

  return { counts, totals };
}

/** The demo user ids, so cleanup can remove them (and their audit rows). */
async function loadDemoUserIds(): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    "SELECT id FROM users WHERE username LIKE 'demo.%'"
  );
  return result.rows.map((row) => row.id);
}

/** The bootstrap Administrator's id, if it exists. */
async function loadAdministratorId(administratorUsername: string): Promise<string | null> {
  const result = await pool.query<{ id: string }>("SELECT id FROM users WHERE username = $1", [
    administratorUsername,
  ]);
  return result.rows[0]?.id ?? null;
}

describe.skipIf(!databaseIsReachable)("Demo dataset against real PostgreSQL", () => {
  let startedAt: Date;
  let firstRun: DemoDatasetSummary;
  let firstSnapshot: DemoSnapshot;
  let demoUserIds: string[] = [];
  let administratorId: string | null = null;

  /** Removes the demo rows; keeps or removes the bootstrap Administrator. */
  async function cleanUpDemoData(keepAdministrator: boolean): Promise<void> {
    const userIds = [...(await loadDemoUserIds())];
    if (!keepAdministrator && administratorId !== null && firstRun.administratorCreated) {
      userIds.push(administratorId);
    }
    await deleteDemoDataset({ userIds, billingRunsSince: startedAt });
  }

  beforeAll(async () => {
    startedAt = new Date();
    firstRun = await generateDemoDataset({ seed: SEED });
    firstSnapshot = await loadDemoSnapshot();
    demoUserIds = await loadDemoUserIds();
    administratorId = await loadAdministratorId("admin");
  });

  afterAll(async () => {
    await cleanUpDemoData(false);
    await closeDatabaseConnection();
  });

  it("seeds every section 8 minimum in the counts it requires", () => {
    const { counts } = firstSnapshot;

    expect(counts.users).toBeGreaterThanOrEqual(5);
    expect(counts.plans).toBe(7);
    expect(counts.internet_plans).toBe(3);
    expect(counts.cable_plans).toBe(2);
    expect(counts.combo_plans).toBe(2);
    expect(counts.collectors).toBe(2);
    expect(counts.areas).toBe(3);
    expect(counts.subscribers).toBe(50);
    expect(counts.service_accounts).toBeGreaterThanOrEqual(60);
    expect(counts.internet_accounts).toBeGreaterThan(0);
    expect(counts.cable_accounts).toBeGreaterThan(0);
    expect(counts.combo_accounts).toBeGreaterThan(0);
    expect(counts.billing_months).toBeGreaterThanOrEqual(3);
    expect(counts.cash_payments).toBeGreaterThanOrEqual(1);
    expect(counts.gcash_payments).toBeGreaterThanOrEqual(1);
    expect(counts.verified_gcash_payments).toBeGreaterThanOrEqual(1);
    expect(counts.partial_payments).toBeGreaterThanOrEqual(1);
    expect(counts.advance_credit_payments).toBeGreaterThanOrEqual(1);
    expect(counts.overdue_accounts).toBeGreaterThanOrEqual(10);
    expect(counts.reversed_payments).toBeGreaterThanOrEqual(1);
    expect(counts.suspension_records).toBeGreaterThanOrEqual(2);
    expect(counts.reconnection_records).toBeGreaterThanOrEqual(2);
    expect(counts.collector_batches).toBeGreaterThanOrEqual(1);
  });

  it("covers the required user categories with real RBAC grants", () => {
    return pool
      .query<{ role_code: string }>(
        `SELECT DISTINCT r.code AS role_code
           FROM users u
           JOIN user_roles ur ON ur.user_id = u.id
           JOIN roles r ON r.id = ur.role_id
          WHERE u.username LIKE 'demo.%'`
      )
      .then((result) => {
        const granted = new Set(result.rows.map((row) => row.role_code));
        expect(granted.has("administrator") || granted.has("owner")).toBe(true);
        expect(granted.has("cashier")).toBe(true);
        expect(granted.has("collection_supervisor")).toBe(true);
        expect(
          granted.has("accounting_auditor") || granted.has("read_only_viewer")
        ).toBe(true);
        expect(granted.has("technician")).toBe(true);
      });
  });

  it("keeps the ledger reconciled: debits minus credits equal the outstanding balances", async () => {
    const mismatches = await pool.query(
      `WITH demo_accounts AS (
         SELECT sa.id
           FROM service_accounts sa
          WHERE sa.subscriber_id IN (
            SELECT id FROM subscribers WHERE internal_notes LIKE 'DEMO-DATA%'
          )
       ),
       ledger AS (
         SELECT service_account_id,
                sum(CASE WHEN entry_type::text = ANY($1::text[])
                         THEN amount_centavos ELSE -amount_centavos END)::int AS net
           FROM ledger_entries
          WHERE service_account_id IN (SELECT id FROM demo_accounts)
          GROUP BY service_account_id
       ),
       owed AS (
         SELECT service_account_id, sum(remaining_balance_centavos)::int AS outstanding
           FROM invoices
          WHERE service_account_id IN (SELECT id FROM demo_accounts)
            AND status IN ('unpaid', 'partially_paid', 'overdue')
            AND remaining_balance_centavos > 0
          GROUP BY service_account_id
       )
       SELECT coalesce(ledger.service_account_id, owed.service_account_id) AS service_account_id,
              coalesce(ledger.net, 0) AS ledger_net,
              coalesce(owed.outstanding, 0) AS outstanding
         FROM ledger
         FULL OUTER JOIN owed USING (service_account_id)
        WHERE coalesce(ledger.net, 0) <> coalesce(owed.outstanding, 0)`,
      [[...DEBIT_ENTRY_TYPES]]
    );

    expect(mismatches.rows).toEqual([]);
    expect(firstSnapshot.totals.ledger_net_centavos).toBe(
      firstSnapshot.totals.outstanding_centavos
    );
  });

  it("buckets the outstanding balance into aging buckets that sum back to the total", async () => {
    const rows = await pool.query<{ due_date: string; remaining_balance_centavos: number }>(
      `SELECT i.due_date::text AS due_date, i.remaining_balance_centavos
         FROM invoices i
        WHERE i.service_account_id IN (
                SELECT sa.id FROM service_accounts sa
                 WHERE sa.subscriber_id IN (
                   SELECT id FROM subscribers WHERE internal_notes LIKE 'DEMO-DATA%'
                 )
              )
          AND i.status IN ('unpaid', 'partially_paid', 'overdue')
          AND i.remaining_balance_centavos > 0`
    );

    const asOf = utcMidnightOfDay(new Date().toISOString().slice(0, 10));
    const bucketTotals = new Map<AgingBucket, number>();
    let bucketSum = 0;

    for (const row of rows.rows) {
      const bucket = classifyInvoiceAge(utcMidnightOfDay(row.due_date), asOf);
      bucketTotals.set(bucket, (bucketTotals.get(bucket) ?? 0) + row.remaining_balance_centavos);
      bucketSum += row.remaining_balance_centavos;
    }

    // The buckets were computed from the same rows; the INDEPENDENT number is the
    // SQL total of every outstanding invoice, and the two must agree.
    expect(bucketSum).toBe(firstSnapshot.totals.outstanding_centavos);
    expect(rows.rows.length).toBeGreaterThan(0);

    // ...and they must actually span more than one bucket.
    const nonEmptyBuckets = [...bucketTotals.entries()].filter(([, total]) => total > 0);
    expect(nonEmptyBuckets.length).toBeGreaterThanOrEqual(2);
  });

  it("issues unique invoice, receipt and reversal receipt numbers", async () => {
    const duplicates = await pool.query(
      `SELECT 'invoice' AS kind, invoice_number AS value FROM invoices GROUP BY 1, 2 HAVING count(*) > 1
        UNION ALL
       SELECT 'receipt' AS kind, receipt_number AS value FROM payments GROUP BY 1, 2 HAVING count(*) > 1
        UNION ALL
       SELECT 'reversal_receipt' AS kind, reversal_receipt_number AS value FROM payment_reversals GROUP BY 1, 2 HAVING count(*) > 1`
    );

    expect(duplicates.rows).toEqual([]);
  });

  it("marks every generated row as obviously synthetic", async () => {
    const result = await pool.query<{ synthetic_subscribers: number; subscribers: number }>(
      `SELECT
         (SELECT count(*) FROM subscribers WHERE internal_notes LIKE 'DEMO-DATA%')::int AS subscribers,
         (SELECT count(*) FROM subscribers
           WHERE internal_notes LIKE 'DEMO-DATA%'
             AND primary_phone LIKE '0900%'
             AND service_address LIKE '%Demo Street%')::int AS synthetic_subscribers`
    );

    const row = result.rows[0];
    expect(row?.subscribers).toBe(50);
    expect(row?.synthetic_subscribers).toBe(row?.subscribers);

    const references = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM gcash_payments WHERE gcash_reference_number NOT LIKE 'DEMOGCASH-%'`
    );
    expect(references.rows[0]?.count).toBe(0);
  });

  it("refuses to seed a second demo dataset into the same database", async () => {
    await expect(generateDemoDataset({ seed: SEED })).rejects.toThrow(
      /already holds a demo dataset/
    );
  });

  it("is deterministic: the same seed reproduces identical counts and identical totals", async () => {
    // Read the first run's snapshot before removing anything, then remove ONLY the
    // demo rows and run the generator again with the same seed.
    const firstCounts = firstSnapshot.counts;
    const firstTotals = firstSnapshot.totals;

    await cleanUpDemoData(true);

    const secondRun = await generateDemoDataset({ seed: SEED });
    const secondSnapshot = await loadDemoSnapshot();

    expect(secondSnapshot.counts).toEqual(firstCounts);
    expect(secondSnapshot.totals).toEqual(firstTotals);
    expect(secondRun.counts).toEqual(firstRun.counts);
    expect(secondRun.totals).toEqual(firstRun.totals);
  });

  it("refuses to seed over non-demo subscribers unless confirmed", async () => {
    await cleanUpDemoData(true);

    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO subscribers
         (account_number, first_name, last_name, primary_phone, service_address,
          service_barangay, service_municipality, service_province, created_by)
       VALUES ('SUB-TEST-NONDEMO', 'Not', 'Demo', '09171234567', '1 Real Street',
               'Real Barangay', 'Real City', 'Real Province', $1)
       RETURNING id`,
      [administratorId ?? demoUserIds[0]]
    );
    const nonDemoSubscriberId = inserted.rows[0]?.id as string;

    try {
      await expect(assertDemoTargetIsSafe(false)).rejects.toThrow(/not demo data/);
      await expect(assertDemoTargetIsSafe(true)).resolves.toBeUndefined();
    } finally {
      await pool.query("DELETE FROM subscribers WHERE id = $1", [nonDemoSubscriberId]);
    }
  });
});
