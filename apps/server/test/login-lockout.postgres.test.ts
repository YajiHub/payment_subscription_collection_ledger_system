// S5-5 — the derived counter, against real PostgreSQL.
//
// "A successful login must clear the counter" is implemented without deleting an
// audit row: the counter is the number of failures AFTER the account's last
// success. This suite proves that reading, which a mocked database cannot.

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabaseConnection, pool } from "../src/db/connection";
import { getRecentFailureState } from "../src/modules/auth/login-lockout.service";

async function isDatabaseReachable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

const databaseIsReachable = await isDatabaseReachable();

const THRESHOLD = 3;
const COOLDOWN_MS = 15 * 60_000;

describe.skipIf(!databaseIsReachable)("login failure counter against PostgreSQL", () => {
  const username = `wp5.lockout.${randomUUID()}`;

  async function recordAttempt(success: boolean): Promise<void> {
    await pool.query(
      "INSERT INTO login_audit_log (username, success, ip_address) VALUES ($1, $2, $3)",
      [username, success, "10.0.0.1"]
    );
  }

  beforeAll(async () => {
    await recordAttempt(false);
    await recordAttempt(false);
    await recordAttempt(false);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM login_audit_log WHERE username = $1", [username]);
    await closeDatabaseConnection();
  });

  it("counts three consecutive failures and anchors a lock", async () => {
    const state = await getRecentFailureState(username, THRESHOLD, COOLDOWN_MS);
    expect(state.failureCount).toBe(3);
    expect(state.lastFailureAt).not.toBeNull();
    expect(state.lockStartedAt).not.toBeNull();
  });

  it("clears the counter after a successful login, without deleting a row", async () => {
    await recordAttempt(true);

    const state = await getRecentFailureState(username, THRESHOLD, COOLDOWN_MS);
    expect(state.failureCount).toBe(0);
    expect(state.lockStartedAt).toBeNull();

    // The rows are all still there; nothing was deleted to reset the counter.
    const remaining = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM login_audit_log WHERE username = $1",
      [username]
    );
    expect(Number(remaining.rows[0]?.count)).toBe(4);
  });

  it("counts only the failures that follow the last success", async () => {
    await recordAttempt(false);
    await recordAttempt(false);

    const state = await getRecentFailureState(username, THRESHOLD, COOLDOWN_MS);
    expect(state.failureCount).toBe(2);
    expect(state.lockStartedAt).toBeNull();
  });
});
