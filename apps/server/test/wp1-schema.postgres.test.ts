// WP1 — the schema, constraint and seed invariants the new migrations install,
// checked against a real PostgreSQL database (S1-1 … S1-11).
//
// The unit suite proves the constants; this one proves what the database actually
// does: that the period key is unique, that the ledger refuses to change, that
// the seven roles and their matrix really landed, and that the search and
// due-date indexes exist.
//
// Fixtures are created inside one transaction that is rolled back in `afterAll`,
// so this suite leaves nothing behind — which is also the only way to insert a
// ledger row without breaking the append-only rule for everyone else. Each
// expected failure is wrapped in a savepoint, because a failed statement aborts
// the surrounding transaction.

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";

import { closeDatabaseConnection, pool } from "../src/db/connection";
import {
  LEGACY_ROLE_TO_SYSTEM_ROLE,
  PERMISSION_DESCRIPTIONS,
  ROLE_PERMISSIONS,
  SYSTEM_ROLES,
  SYSTEM_ROLE_PERMISSIONS,
  USER_ROLES,
  type Permission,
  type UserRole,
} from "@bcis/shared";

async function isDatabaseReachable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

const databaseIsReachable = await isDatabaseReachable();

const NEW_TABLES = [
  "backup_history",
  "collection_areas",
  "collector_remittances",
  "permissions",
  "reconnection_records",
  "role_permissions",
  "roles",
  "subscriber_addresses",
  "suspension_records",
  "user_roles",
];

const TRIGRAM_INDEXES = [
  "gcash_payments_reference_trgm_idx",
  "invoices_invoice_number_trgm_idx",
  "payments_receipt_number_trgm_idx",
  "subscribers_account_number_trgm_idx",
  "subscribers_email_address_trgm_idx",
  "subscribers_first_name_trgm_idx",
  "subscribers_last_name_trgm_idx",
  "subscribers_middle_name_trgm_idx",
  "subscribers_primary_phone_trgm_idx",
  "subscribers_secondary_phone_trgm_idx",
  "subscribers_service_address_trgm_idx",
  "subscribers_service_barangay_trgm_idx",
  "subscribers_service_municipality_trgm_idx",
];

describe.skipIf(!databaseIsReachable)("WP1 schema invariants against real PostgreSQL", () => {
  let client: PoolClient;
  let userId: string;
  let planId: string;
  let subscriberId: string;
  let serviceAccountId: string;

  /** Runs a statement that must fail, then puts the transaction back on its feet. */
  async function expectStatementToFail(
    sql: string,
    parameters: unknown[],
    expectedMessage: RegExp
  ): Promise<void> {
    await client.query("SAVEPOINT wp1_probe");
    await expect(client.query(sql, parameters)).rejects.toThrow(expectedMessage);
    await client.query("ROLLBACK TO SAVEPOINT wp1_probe");
  }

  beforeAll(async () => {
    client = await pool.connect();
    await client.query("BEGIN");

    userId = randomUUID();
    planId = randomUUID();
    subscriberId = randomUUID();
    serviceAccountId = randomUUID();
    const suffix = userId.slice(0, 8);

    await client.query(
      `INSERT INTO users (id, full_name, username, password_hash, role, is_active)
       VALUES ($1, 'WP1 Probe Clerk', $2, 'not-a-real-hash', 'billing_clerk', true)`,
      [userId, `wp1.probe.${suffix}`]
    );

    // The migration backfills user_roles with this same mapping; the fixture does
    // it explicitly so the permission assertions below are not vacuous.
    await client.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, r.id FROM roles r WHERE r.code = $2`,
      [userId, LEGACY_ROLE_TO_SYSTEM_ROLE.billing_clerk]
    );

    await client.query(
      `INSERT INTO subscription_plans
         (id, name, service_type, speed_mbps, monthly_rate_centavos, reconnection_fee_centavos, is_active, created_by)
       VALUES ($1, $2, 'internet', 25, 99900, 50000, true, $3)`,
      [planId, `WP1 Probe Fiber ${suffix}`, userId]
    );

    await client.query(
      `INSERT INTO subscribers
         (id, account_number, first_name, last_name, primary_phone,
          service_address, service_barangay, service_municipality, service_province, created_by)
       VALUES ($1, $2, 'Probe', 'Subscriber', '09000000000',
          '1 Probe Street', 'Poblacion', 'Quezon', 'Bukidnon', $3)`,
      [subscriberId, `SUB-WP1-${suffix}`, userId]
    );

    await client.query(
      `INSERT INTO service_accounts
         (id, service_account_number, subscriber_id, plan_id, status, created_by)
       VALUES ($1, $2, $3, $4, 'active', $5)`,
      [serviceAccountId, `SA-WP1-${suffix}`, subscriberId, planId, userId]
    );
  });

  afterAll(async () => {
    await client.query("ROLLBACK");
    client.release();
    await closeDatabaseConnection();
  });

  it("creates every table the work package adds", async () => {
    const result = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [NEW_TABLES]
    );
    const found = result.rows.map((row) => row.table_name).sort();
    expect(found).toEqual([...NEW_TABLES].sort());
  });

  it("seeds the seven roles and the permission catalogue", async () => {
    const roles = await client.query<{ code: string }>("SELECT code FROM roles ORDER BY code");
    expect(roles.rows.map((row) => row.code)).toEqual([...SYSTEM_ROLES].sort());

    const permissionCount = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM permissions"
    );
    expect(permissionCount.rows[0]?.count).toBe(String(Object.keys(PERMISSION_DESCRIPTIONS).length));
  });

  it("stores a role → permission matrix identical to the shared constants", async () => {
    const result = await client.query<{ role_code: string; permission_code: string }>(
      `SELECT r.code AS role_code, p.code AS permission_code
       FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
       JOIN permissions p ON p.id = rp.permission_id`
    );

    for (const role of SYSTEM_ROLES) {
      const stored = result.rows
        .filter((row) => row.role_code === role)
        .map((row) => row.permission_code)
        .sort();
      expect(stored, `matrix mismatch for ${role}`).toEqual(
        [...SYSTEM_ROLE_PERMISSIONS[role]].sort()
      );
    }
  });

  it("grants every user the stored role their legacy role maps onto", async () => {
    const users = await client.query<{ id: string; username: string; role: UserRole }>(
      "SELECT id, username, role::text AS role FROM users"
    );
    const grants = await client.query<{ user_id: string; permission_code: string }>(
      `SELECT ur.user_id, p.code AS permission_code
       FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       JOIN permissions p ON p.id = rp.permission_id`
    );

    for (const user of users.rows) {
      const storedRole = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = $1 AND r.code = $2`,
        [user.id, LEGACY_ROLE_TO_SYSTEM_ROLE[user.role]]
      );
      expect(storedRole.rows[0]?.count, `${user.username} is missing its mapped role`).toBe("1");

      const effective = new Set(
        grants.rows
          .filter((row) => row.user_id === user.id)
          .map((row) => row.permission_code as Permission)
      );
      for (const permission of ROLE_PERMISSIONS[user.role]) {
        expect(
          effective.has(permission),
          `${user.username} (${user.role}) lost ${permission}`
        ).toBe(true);
      }
    }

    // The five legacy values are the only ones that can appear, and the mapping
    // must cover all of them.
    expect(Object.keys(LEGACY_ROLE_TO_SYSTEM_ROLE).sort()).toEqual([...USER_ROLES].sort());
  });

  it("rejects a second live invoice for the same service account and period", async () => {
    await client.query(
      `INSERT INTO invoices
         (invoice_number, service_account_id, invoice_type, status, billing_period_year,
          billing_period_month, invoice_date, due_date, subtotal_centavos,
          total_amount_centavos, remaining_balance_centavos, created_by)
       VALUES ('INV-WP1-PROBE-0001', $1, 'monthly_subscription', 'draft', 2031, 1,
               CURRENT_DATE, CURRENT_DATE, 10000, 10000, 10000, $2)`,
      [serviceAccountId, userId]
    );

    await expectStatementToFail(
      `INSERT INTO invoices
         (invoice_number, service_account_id, invoice_type, status, billing_period_year,
          billing_period_month, invoice_date, due_date, subtotal_centavos,
          total_amount_centavos, remaining_balance_centavos, created_by)
       VALUES ('INV-WP1-PROBE-0002', $1, 'monthly_subscription', 'unpaid', 2031, 1,
               CURRENT_DATE, CURRENT_DATE, 10000, 10000, 10000, $2)`,
      [serviceAccountId, userId],
      /invoices_service_account_period_uq/
    );
  });

  it("still allows a re-bill for a period whose invoice was voided", async () => {
    const voided = await client.query(
      `INSERT INTO invoices
         (invoice_number, service_account_id, invoice_type, status, billing_period_year,
          billing_period_month, invoice_date, due_date, subtotal_centavos,
          total_amount_centavos, remaining_balance_centavos, created_by)
       VALUES ('INV-WP1-PROBE-0003', $1, 'monthly_subscription', 'void', 2031, 2,
               CURRENT_DATE, CURRENT_DATE, 10000, 10000, 10000, $2)`,
      [serviceAccountId, userId]
    );
    expect(voided.rowCount).toBe(1);

    const reBill = await client.query(
      `INSERT INTO invoices
         (invoice_number, service_account_id, invoice_type, status, billing_period_year,
          billing_period_month, invoice_date, due_date, subtotal_centavos,
          total_amount_centavos, remaining_balance_centavos, created_by)
       VALUES ('INV-WP1-PROBE-0004', $1, 'monthly_subscription', 'draft', 2031, 2,
               CURRENT_DATE, CURRENT_DATE, 10000, 10000, 10000, $2)`,
      [serviceAccountId, userId]
    );
    expect(reBill.rowCount).toBe(1);
  });

  it("refuses to update a ledger entry", async () => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO ledger_entries
         (service_account_id, entry_type, amount_centavos, sequence_number,
          running_balance_centavos, description, created_by)
       VALUES ($1, 'manual_debit', 10000, 5001, 10000, 'WP1 append-only probe', $2)
       RETURNING id`,
      [serviceAccountId, userId]
    );
    const ledgerEntryId = inserted.rows[0]?.id;

    await expectStatementToFail(
      "UPDATE ledger_entries SET amount_centavos = 1 WHERE id = $1",
      [ledgerEntryId],
      /ledger_entries is append-only: UPDATE is not permitted/
    );
  });

  it("refuses to delete a ledger entry", async () => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO ledger_entries
         (service_account_id, entry_type, amount_centavos, sequence_number,
          running_balance_centavos, description, created_by)
       VALUES ($1, 'manual_debit', 10000, 5002, 20000, 'WP1 append-only probe', $2)
       RETURNING id`,
      [serviceAccountId, userId]
    );
    const ledgerEntryId = inserted.rows[0]?.id;

    await expectStatementToFail(
      "DELETE FROM ledger_entries WHERE id = $1",
      [ledgerEntryId],
      /ledger_entries is append-only: DELETE is not permitted/
    );
  });

  it("bounds a per-account billing-day override to a day every month has", async () => {
    await client.query("UPDATE service_accounts SET due_day = 15 WHERE id = $1", [
      serviceAccountId,
    ]);

    await expectStatementToFail(
      "UPDATE service_accounts SET due_day = 31 WHERE id = $1",
      [serviceAccountId],
      /service_accounts_due_day_check/
    );
    await expectStatementToFail(
      "UPDATE service_accounts SET billing_day = 0 WHERE id = $1",
      [serviceAccountId],
      /service_accounts_billing_day_check/
    );
  });

  it("keeps the collection area reachable from a subscriber and a service account", async () => {
    const areaId = randomUUID();
    await client.query(
      `INSERT INTO collection_areas (id, code, name, description, created_by)
       VALUES ($1, $2, 'WP1 Probe Area', 'route sheet probe', $3)`,
      [areaId, `WP1-${areaId.slice(0, 8)}`, userId]
    );

    await client.query("UPDATE subscribers SET area_id = $1 WHERE id = $2", [areaId, subscriberId]);
    await client.query("UPDATE service_accounts SET area_id = $1 WHERE id = $2", [
      areaId,
      serviceAccountId,
    ]);

    // The denormalized barangay string is untouched by the area assignment.
    const subscriber = await client.query<{ service_barangay: string; area_id: string }>(
      "SELECT service_barangay, area_id FROM subscribers WHERE id = $1",
      [subscriberId]
    );
    expect(subscriber.rows[0]).toMatchObject({
      service_barangay: "Poblacion",
      area_id: areaId,
    });
  });

  it("allows a subscriber several addresses but only one primary", async () => {
    const primary = randomUUID();
    const secondary = randomUUID();

    await client.query(
      `INSERT INTO subscriber_addresses
         (id, subscriber_id, label, address_line, barangay, municipality, province, is_primary, created_by)
       VALUES ($1, $2, 'Primary', '1 Probe Street', 'Poblacion', 'Quezon', 'Bukidnon', true, $3),
              ($4, $2, 'Store', '2 Probe Street', 'Poblacion', 'Quezon', 'Bukidnon', false, $3)`,
      [primary, subscriberId, userId, secondary]
    );

    const stored = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM subscriber_addresses WHERE subscriber_id = $1",
      [subscriberId]
    );
    expect(stored.rows[0]?.count).toBe("2");

    await expectStatementToFail(
      `INSERT INTO subscriber_addresses
         (subscriber_id, label, address_line, is_primary, created_by)
       VALUES ($1, 'Second primary', '3 Probe Street', true, $2)`,
      [subscriberId, userId],
      /subscriber_addresses_primary_uq/
    );
  });

  it("refuses a remittance whose method split does not add up", async () => {
    const batchId = randomUUID();
    await client.query(
      `INSERT INTO collector_batches
         (id, batch_number, collector_id, status, collection_date, created_by)
       VALUES ($1, $2, $3, 'open', CURRENT_DATE, $3)`,
      [batchId, `CB-WP1-${batchId.slice(0, 8)}`, userId]
    );

    const stored = await client.query(
      `INSERT INTO collector_remittances
         (batch_id, amount_centavos, cash_amount_centavos, gcash_amount_centavos, remitted_by, notes)
       VALUES ($1, 10000, 6000, 4000, $2, 'first hand-in')`,
      [batchId, userId]
    );
    expect(stored.rowCount).toBe(1);

    // A second remittance against the same batch is allowed: that is the point of
    // the table. A split that does not add up is not.
    const corrected = await client.query(
      `INSERT INTO collector_remittances
         (batch_id, amount_centavos, cash_amount_centavos, gcash_amount_centavos, remitted_by, notes)
       VALUES ($1, 5000, 5000, 0, $2, 'balance handed in later')`,
      [batchId, userId]
    );
    expect(corrected.rowCount).toBe(1);

    await expectStatementToFail(
      `INSERT INTO collector_remittances
         (batch_id, amount_centavos, cash_amount_centavos, gcash_amount_centavos, remitted_by)
       VALUES ($1, 10000, 6000, 3000, $2)`,
      [batchId, userId],
      /collector_remittances_split_check/
    );
  });

  it("installs pg_trgm, the trigram indexes and the invoice due-date index", async () => {
    const extension = await client.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'"
    );
    expect(extension.rows).toHaveLength(1);

    const indexes = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = ANY($1::text[])`,
      [[...TRIGRAM_INDEXES, "invoices_due_date_idx", "subscribers_area_idx"]]
    );
    expect(indexes.rows.map((row) => row.indexname).sort()).toEqual(
      [...TRIGRAM_INDEXES, "invoices_due_date_idx", "subscribers_area_idx"].sort()
    );

    // The trigram index must actually be usable for the ILIKE search the
    // subscriber list issues, which is the whole reason it exists.
    await client.query("SET LOCAL enable_seqscan = off");
    const plan = await client.query<{ "QUERY PLAN": string }>(
      `EXPLAIN (COSTS OFF) SELECT id FROM subscribers WHERE first_name ILIKE '%probe%'`
    );
    expect(plan.rows.map((row) => row["QUERY PLAN"]).join("\n")).toContain(
      "subscribers_first_name_trgm_idx"
    );
  });
});
