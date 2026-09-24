// Phase 9 system-wide invariants, checked against a real PostgreSQL database.
//
// The unit suites prove the arithmetic in one account. These queries prove the
// SAME guarantees hold across every row in the database at once:
//
//   • the audit trail cannot be updated or deleted;
//   • every monetary column is a 4-byte integer, never a float;
//   • a payment's allocations sum exactly to what the payment says it allocated;
//   • an invoice's paid amount equals the allocations applied to it;
//   • every ledger chain is contiguous and its last balance equals the net.
//
// The suite skips itself when no database answers.

import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabaseConnection, pool } from "../src/db/connection";

async function isDatabaseReachable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

const databaseIsReachable = await isDatabaseReachable();

// Every debit entry type, spelled out because it is the highest-risk part of the
// ledger arithmetic. It must match DEBIT_ENTRY_TYPES in the shared package.
const DEBIT_TYPES = [
  "invoice_posted",
  "late_fee",
  "manual_debit",
  "payment_reversal",
  "advance_credit_applied",
];

describe.skipIf(!databaseIsReachable)("Phase 9 invariants against real PostgreSQL", () => {
  afterAll(async () => {
    await closeDatabaseConnection();
  });

  it("refuses to update or delete an audit row", async () => {
    const inserted = await pool.query(
      `INSERT INTO audit_logs (action, entity_type, entity_id, description)
       VALUES ('test.event', 'session', $1, 'append-only probe')
       RETURNING id`,
      [randomUUID()]
    );
    const auditId = inserted.rows[0].id as string;

    await expect(
      pool.query("UPDATE audit_logs SET description = 'tampered' WHERE id = $1", [auditId])
    ).rejects.toThrow(/append-only/);

    await expect(
      pool.query("DELETE FROM audit_logs WHERE id = $1", [auditId])
    ).rejects.toThrow(/append-only/);

    // Remove the probe through the one documented cleanup path.
    await pool.query("ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only");
    await pool.query("DELETE FROM audit_logs WHERE id = $1", [auditId]);
    await pool.query("ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only");

    const after = await pool.query("SELECT 1 FROM audit_logs WHERE id = $1", [auditId]);
    expect(after.rowCount).toBe(0);
  });

  it("seeded the default business rules into system_settings", async () => {
    const result = await pool.query("SELECT key, value FROM system_settings");
    const byKey = new Map<string, string>(
      result.rows.map((row) => [row.key as string, row.value as string])
    );

    expect(byKey.get("late_fee_centavos")).toBe("5000");
    expect(byKey.get("invoice_due_day_of_month")).toBe("15");
    expect(byKey.get("suspension_after_days")).toBe("30");
    expect(byKey.get("company_name")).toBe("My ISP");
    expect(byKey.size).toBeGreaterThanOrEqual(7);
  });

  it("stores every monetary column as a 4-byte integer, never a float", async () => {
    const result = await pool.query(
      `SELECT table_name, column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name LIKE '%centavos%'`
    );

    expect(result.rowCount).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.data_type, `${row.table_name}.${row.column_name}`).toBe("integer");
    }
  });

  it("keeps every payment's allocations summing exactly to its allocated amount", async () => {
    const allocationMismatch = await pool.query(
      `SELECT p.id
         FROM payments p
         LEFT JOIN payment_allocations a ON a.payment_id = p.id
        GROUP BY p.id, p.allocated_centavos
       HAVING p.allocated_centavos <> coalesce(sum(a.allocated_amount_centavos), 0)::int`
    );
    expect(allocationMismatch.rows).toEqual([]);

    const splitMismatch = await pool.query(
      `SELECT id FROM payments
        WHERE amount_centavos <> allocated_centavos + advance_credit_centavos`
    );
    expect(splitMismatch.rows).toEqual([]);
  });

  it("keeps every invoice's paid amount equal to its allocations plus advance credit", async () => {
    // An invoice's paid amount grows two ways: a payment allocation, and an
    // advance credit applied to a draft invoice (which has no allocation row but
    // does have an `advance_credit_applied` ledger entry). Together they must add
    // up to the stored paid amount exactly.
    const result = await pool.query(
      `WITH allocations AS (
         SELECT invoice_id, sum(allocated_amount_centavos)::int AS allocated
           FROM payment_allocations
          GROUP BY invoice_id
       ),
       advance_credit AS (
         SELECT invoice_id, sum(amount_centavos)::int AS applied
           FROM ledger_entries
          WHERE entry_type = 'advance_credit_applied'
          GROUP BY invoice_id
       )
       SELECT i.id, i.paid_amount_centavos,
              coalesce(allocations.allocated, 0) AS allocated,
              coalesce(advance_credit.applied, 0) AS advance_applied
         FROM invoices i
         LEFT JOIN allocations ON allocations.invoice_id = i.id
         LEFT JOIN advance_credit ON advance_credit.invoice_id = i.id
        WHERE i.paid_amount_centavos
              <> coalesce(allocations.allocated, 0) + coalesce(advance_credit.applied, 0)`
    );
    expect(result.rows).toEqual([]);
  });

  it("keeps every ledger chain contiguous with no gaps or duplicate sequence numbers", async () => {
    const result = await pool.query(
      `WITH ordered AS (
         SELECT service_account_id, sequence_number,
                row_number() OVER (
                  PARTITION BY service_account_id ORDER BY sequence_number
                ) AS expected
           FROM ledger_entries
       )
       SELECT service_account_id, sequence_number, expected
         FROM ordered
        WHERE sequence_number <> expected`
    );

    expect(result.rows).toEqual([]);
  });

  it("keeps every ledger's last balance equal to its debits minus its credits", async () => {
    // The debit types travel as a bound parameter, never interpolated into SQL.
    const result = await pool.query(
      `WITH net AS (
         SELECT service_account_id,
                sum(case when entry_type::text = ANY($1::text[])
                         then amount_centavos else -amount_centavos end)::int AS net
           FROM ledger_entries
          GROUP BY service_account_id
       ),
       last_entry AS (
         SELECT DISTINCT ON (service_account_id)
                service_account_id, running_balance_centavos
           FROM ledger_entries
          ORDER BY service_account_id, sequence_number DESC
       )
       SELECT net.service_account_id, net.net, last_entry.running_balance_centavos
         FROM net
         JOIN last_entry USING (service_account_id)
        WHERE net.net <> last_entry.running_balance_centavos`,
      [[...DEBIT_TYPES]]
    );

    expect(result.rows).toEqual([]);
  });
});
