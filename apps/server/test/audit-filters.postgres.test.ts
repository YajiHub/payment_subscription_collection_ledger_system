// The audit trail's filters against real PostgreSQL.
//
// The username filter is an ILIKE over the denormalized `performed_by_username`, and
// what it does cannot be exercised by a fake database: the behaviour that matters is
// how SQL matches a name, including that a wildcard someone types into the box must
// not quietly turn the filter into "match everything".
//
// The suite skips itself when no database answers, so `pnpm test` still passes on a
// machine without PostgreSQL.

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabaseConnection, pool } from "../src/db/connection";
import { listAuditLogs } from "../src/modules/audit/audit.service";

async function isDatabaseReachable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

const databaseIsReachable = await isDatabaseReachable();

describe.skipIf(!databaseIsReachable)("audit trail filters against real PostgreSQL", () => {
  const insertedIds: string[] = [];
  /** Marks this suite's rows, so the action filter isolates them from the trail. */
  const fixtureAction = `test.audit_filter_${randomUUID().slice(0, 8)}`;

  /** An actor recorded the old way: the id on the row, the name nowhere. */
  const legacyUserId = randomUUID();
  const legacyUsername = `auditfilter.${randomUUID().slice(0, 8)}`;
  const DUMMY_PASSWORD_HASH =
    "$2b$12$OMlJdIjzDLp3Jfn.9NR3qOBmwx5aLVRkyrFhSH6e5J1g.kCBMSeJe";

  async function insertEntry(
    performedByUsername: string | null,
    performedBy: string | null = null
  ): Promise<void> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO audit_logs
         (id, action, entity_type, entity_id, description, performed_by, performed_by_username)
       VALUES ($1, $2, 'test_entity', $3, 'audit filter fixture', $4, $5)`,
      [id, fixtureAction, randomUUID(), performedBy, performedByUsername]
    );
    insertedIds.push(id);
  }

  /** The fixture rows the filter matched, so counts cannot be skewed by the trail. */
  async function matchingIds(performedByUsername?: string): Promise<string[]> {
    const page = await listAuditLogs({
      action: fixtureAction,
      performedByUsername,
      page: 1,
      pageSize: 100,
    });
    return page.items.map((item) => item.id).sort();
  }

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO users (id, full_name, username, password_hash, role, is_active)
       VALUES ($1, 'Legacy Actor', $2, $3, 'cashier', true)`,
      [legacyUserId, legacyUsername, DUMMY_PASSWORD_HASH]
    );

    await insertEntry("demo.cashier");
    await insertEntry("demo.owner");
    await insertEntry("demo.auditor");
    await insertEntry(null); // a system event, which has no name at all
    await insertEntry(null, legacyUserId); // the old way: id recorded, name not
  });

  afterAll(async () => {
    // The trail is append-only, so removal needs the same deliberate escape hatch the
    // other suites use: the trigger off for this one statement, then straight back on.
    if (insertedIds.length > 0) {
      await pool.query("ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only");
      try {
        await pool.query("DELETE FROM audit_logs WHERE id = ANY($1::uuid[])", [insertedIds]);
      } finally {
        await pool.query("ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only");
      }
    }

    await pool.query("DELETE FROM users WHERE id = $1", [legacyUserId]);
    await closeDatabaseConnection();
  });

  it("finds every fixture row when no name is given", async () => {
    expect(await matchingIds()).toHaveLength(5);
  });

  it("narrows to one named user", async () => {
    expect(await matchingIds("demo.cashier")).toHaveLength(1);
  });

  it("finds an action whose id was recorded but whose name was not", async () => {
    // The demo seed writes the id and no name, so matching only the recorded name
    // would hide most of a user's own trail while appearing to work.
    expect(await matchingIds(legacyUsername)).toHaveLength(1);
  });

  it("matches part of a name and ignores case", async () => {
    expect(await matchingIds("CASH")).toHaveLength(1);
    expect(await matchingIds("demo.")).toHaveLength(3);
  });

  it("treats a typed wildcard as a literal, not as match-everything", async () => {
    // Unescaped, both of these would return all four rows and look like they worked.
    expect(await matchingIds("%")).toHaveLength(0);
    expect(await matchingIds("_")).toHaveLength(0);
  });

  it("finds nothing for a name that performed nothing", async () => {
    expect(await matchingIds("nobody.here")).toHaveLength(0);
  });
});
