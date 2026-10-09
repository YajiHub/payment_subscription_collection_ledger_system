// D6 against real PostgreSQL — the statement period floors at the OFFICE day.
//
// `entry_date` is an instant, so the calendar day a ledger row belongs to depends
// on where the day boundary is. This probe inserts one entry at 17:30 UTC on the
// 9th — which is 01:30 LOCAL on the 10th for the +08:00 office — and asks for the
// statement of the 10th:
//
//   • the LOCAL day includes the row (1 line) and its opening balance excludes it;
//   • the UTC day the code used before the fix excluded the row (0 lines) and
//     counted its whole amount in the opening balance.
//
// The suite skips itself when no database answers, so `pnpm test` still passes on
// a machine without PostgreSQL.

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabaseConnection, pool } from "../src/db/connection";
import { getStatementOfAccount } from "../src/modules/ledger/statement-of-account.service";
import { deleteAuditLogsForUsers } from "./support/audit-cleanup";
import { deleteLedgerEntriesForServiceAccounts } from "./support/ledger-cleanup";

/** A valid bcrypt hash. The value is never checked here — only its shape. */
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

describe.skipIf(!databaseIsReachable)("statement local-day period against real PostgreSQL", () => {
  const userId = randomUUID();
  const planId = randomUUID();
  const subscriberId = randomUUID();
  const serviceAccountId = randomUUID();

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO users (id, full_name, username, password_hash, role, is_active)
       VALUES ($1, $2, $3, $4, 'admin', true)`,
      [userId, "Statement Probe Admin", `statement.probe.${userId.slice(0, 8)}`, DUMMY_PASSWORD_HASH]
    );

    await pool.query(
      `INSERT INTO subscription_plans
         (id, name, service_type, speed_mbps, monthly_rate_centavos, reconnection_fee_centavos, is_active, created_by)
       VALUES ($1, $2, 'internet', 25, 99900, 50000, true, $3)`,
      [planId, `Statement Probe Plan ${planId.slice(0, 8)}`, userId]
    );

    await pool.query(
      `INSERT INTO subscribers
         (id, account_number, first_name, last_name, primary_phone, service_address,
          service_barangay, service_municipality, service_province, created_by)
       VALUES ($1, $2, 'Probe', 'Local', '09170000000', '1 Probe Street',
               'Poblacion', 'Testville', 'Testprovince', $3)`,
      [subscriberId, `SUB-${randomUUID().slice(0, 8)}`, userId]
    );

    await pool.query(
      `INSERT INTO service_accounts
         (id, service_account_number, subscriber_id, plan_id, status, activation_date, created_by)
       VALUES ($1, $2, $3, $4, 'active', '2026-01-01', $5)`,
      [serviceAccountId, `SA-${randomUUID().slice(0, 8)}`, subscriberId, planId, userId]
    );

    // 2026-10-09T17:30:00Z is 2026-10-10 01:30 in the +08:00 office.
    await pool.query(
      `INSERT INTO ledger_entries
         (id, service_account_id, entry_type, amount_centavos, sequence_number,
          running_balance_centavos, description, entry_date, created_by)
       VALUES ($1, $2, 'invoice_posted', 100000, 1, 100000, 'Probe invoice', $3, $4)`,
      [randomUUID(), serviceAccountId, "2026-10-09T17:30:00Z", userId]
    );
  });

  afterAll(async () => {
    await deleteLedgerEntriesForServiceAccounts([serviceAccountId]);
    await pool.query("DELETE FROM service_accounts WHERE id = $1", [serviceAccountId]);
    await pool.query("DELETE FROM subscribers WHERE id = $1", [subscriberId]);
    await pool.query("DELETE FROM subscription_plans WHERE id = $1", [planId]);
    await deleteAuditLogsForUsers(pool, [userId]);
    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    await closeDatabaseConnection();
  });

  it("puts a 17:30Z entry in the 10 October local-day period", async () => {
    const statement = await getStatementOfAccount(serviceAccountId, {
      fromDate: "2026-10-10",
      toDate: "2026-10-10",
    });

    expect(statement.lines).toHaveLength(1);
    expect(statement.lines[0]?.date).toBe("2026-10-10");
    // The row is AFTER the local start of the 10th, so it is not in the opening.
    expect(statement.openingBalanceCentavos).toBe(0);
    expect(statement.closingBalanceCentavos).toBe(100000);
  });

  it("reports the 9 October period as empty (the entry is on the 10th locally)", async () => {
    const statement = await getStatementOfAccount(serviceAccountId, {
      fromDate: "2026-10-09",
      toDate: "2026-10-09",
    });

    expect(statement.lines).toHaveLength(0);
    expect(statement.closingBalanceCentavos).toBe(statement.openingBalanceCentavos);
  });
});
