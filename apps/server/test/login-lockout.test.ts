// S5-5 — per-account failed-login lockout.
//
// Three layers are proved:
//   • the boundary rule, as a pure function (N-1 still allows the correct password,
//     N locks, the cooldown releases it);
//   • the ANCHOR rule: the lock is measured from when the count reached the
//     threshold, so hammering a locked account cannot extend it (item 7);
//   • the HTTP behaviour, through the real login route with the database mocked:
//     a locked account is refused with 429 BEFORE bcrypt runs, the refusal is
//     recorded, and an unknown username looks identical to a known one.

import { randomUUID } from "node:crypto";

import bcrypt from "bcrypt";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../src/db/connection", async () => {
  const { fakeDatabase } = await import("./support/fake-database");
  return {
    db: fakeDatabase.db,
    pool: {},
    checkDatabaseConnection: async () => ({ isReachable: true, latencyMs: 0, errorMessage: null }),
    closeDatabaseConnection: async () => {},
  };
});

import { buildServer } from "../src/index.ts";
import { auditLogs } from "../src/db/schema/audit";
import { loginAuditLog } from "../src/db/schema/users";
import {
  evaluateLoginLockout,
  summarizeFailureStreak,
  type LoginFailureState,
  type LoginLockoutPolicy,
} from "../src/modules/auth/login-lockout.service";
import { fakeDatabase } from "./support/fake-database";

const POLICY: LoginLockoutPolicy = { threshold: 5, cooldownMs: 15 * 60_000 };
const NOW = new Date("2025-01-01T12:00:00.000Z");

function state(failureCount: number, minutesAgo: number | null): LoginFailureState {
  const lastFailureAt =
    minutesAgo === null ? null : new Date(NOW.getTime() - minutesAgo * 60_000);
  return { failureCount, lastFailureAt, lockStartedAt: lastFailureAt };
}

describe("login lockout boundary rule", () => {
  it("keeps the account open at N-1 failures", () => {
    const decision = evaluateLoginLockout(state(4, 1), POLICY, NOW);
    expect(decision.locked).toBe(false);
    expect(decision.remainingAttempts).toBe(1);
  });

  it("locks the account at N failures", () => {
    const decision = evaluateLoginLockout(state(5, 1), POLICY, NOW);
    expect(decision.locked).toBe(true);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
    expect(decision.remainingAttempts).toBe(0);
  });

  it("unlocks once the cooldown has elapsed", () => {
    const justInside = evaluateLoginLockout(state(5, 14), POLICY, NOW);
    const justOutside = evaluateLoginLockout(state(5, 16), POLICY, NOW);

    expect(justInside.locked).toBe(true);
    expect(justOutside.locked).toBe(false);
  });

  it("treats a successful login (no failures since) as an open account", () => {
    const decision = evaluateLoginLockout(state(0, null), POLICY, NOW);
    expect(decision.locked).toBe(false);
    expect(decision.remainingAttempts).toBe(5);
  });
});

// Item 7: the lock is anchored to when the count reached the threshold, not to the
// latest failure, so one request per cooldown cannot keep an account locked forever.
describe("login lockout anchor (item 7)", () => {
  const threshold = 3;
  const cooldownMs = 15 * 60_000;
  const policy: LoginLockoutPolicy = { threshold, cooldownMs };
  const firstFailure = new Date("2025-01-01T12:00:00.000Z");
  const anchor = new Date(firstFailure.getTime() + 2 * 60_000); // the 3rd failure

  /** Failures from `firstFailure`, hammered every minute through `minutes`. */
  function hammeredThrough(minutes: number): Date[] {
    const times: Date[] = [];
    for (let minute = 0; minute <= minutes; minute++) {
      times.push(new Date(firstFailure.getTime() + minute * 60_000));
    }
    return times;
  }

  it("cannot be extended by hammering while locked", () => {
    const times = hammeredThrough(14); // an attempt every minute up to minute 14
    const at = new Date(anchor.getTime() + 14 * 60_000);

    const decision = evaluateLoginLockout(
      summarizeFailureStreak(times, threshold, cooldownMs),
      policy,
      at
    );

    expect(decision.locked).toBe(true);
  });

  it("unlocks on schedule however many attempts arrived", () => {
    // Attempts arrive every minute up to minute 16, all INSIDE the lock window
    // (which ends at minute 17). None of them may push the unlock out.
    const times = hammeredThrough(16);
    const at = new Date(anchor.getTime() + 16 * 60_000);

    const decision = evaluateLoginLockout(
      summarizeFailureStreak(times, threshold, cooldownMs),
      policy,
      at
    );

    expect(decision.locked).toBe(false);
    expect(decision.retryAfterSeconds).toBe(0);
  });

  it("forms a fresh lock after the cooldown, so protection resumes", () => {
    const times = hammeredThrough(20); // hammered through minute 20, past the lock
    // After the anchor + cooldown the streak resets; failures from minute 15 on
    // rebuild a fresh streak that reaches the threshold again.
    const stateAfterReset = summarizeFailureStreak(times, threshold, cooldownMs);
    const at = new Date(anchor.getTime() + 20 * 60_000);

    expect(stateAfterReset.lockStartedAt).not.toBeNull();
    expect(evaluateLoginLockout(stateAfterReset, policy, at).locked).toBe(true);
  });
});

const PASSWORD = "correct-horse-battery";

async function buildTestUser(username: string) {
  return {
    id: randomUUID(),
    fullName: "Test User",
    username,
    passwordHash: await bcrypt.hash(PASSWORD, 4),
    role: "cashier",
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: null,
  };
}

/** The settings rows that pin a small threshold so the lockout trips quickly. */
const LOCKOUT_SETTINGS = [
  {
    key: "login_lockout_threshold",
    value: "3",
    description: "threshold",
    updatedAt: new Date(),
    updatedBy: null,
  },
  {
    key: "login_lockout_cooldown_minutes",
    value: "15",
    description: "cooldown",
    updatedAt: new Date(),
    updatedBy: null,
  },
];

/** Three recent failures: enough for a threshold of 3 to lock the account. */
function recentFailures(count: number): { attemptedAt: Date }[] {
  const now = Date.now();
  return Array.from({ length: count }, (_unused, index) => ({
    attemptedAt: new Date(now - (count - index) * 1_000),
  }));
}

describe("login lockout over the API", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    fakeDatabase.reset();
  });

  it("refuses a locked account with 429 before the password is verified", async () => {
    const user = await buildTestUser("locked.user");

    fakeDatabase.queueSelectRows([user]); // the username lookup
    fakeDatabase.queueSelectRows(LOCKOUT_SETTINGS); // the policy
    fakeDatabase.queueSelectRows(recentFailures(3)); // the failure streak

    const compareSpy = vi.spyOn(bcrypt, "compare");

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "locked.user", password: PASSWORD },
    });

    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe("TOO_MANY_REQUESTS");
    // The refusal happens before verification: the password was never compared.
    expect(compareSpy).not.toHaveBeenCalled();
    compareSpy.mockRestore();
  });

  it("records the lockout in login_audit_log and the audit trail", async () => {
    const user = await buildTestUser("locked.audit");

    fakeDatabase.queueSelectRows([user]);
    fakeDatabase.queueSelectRows(LOCKOUT_SETTINGS);
    fakeDatabase.queueSelectRows(recentFailures(3));

    await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "locked.audit", password: PASSWORD },
    });

    const loginRow = fakeDatabase.insertedRows.find((row) => row.table === loginAuditLog)?.values as
      | Record<string, unknown>
      | undefined;
    expect(loginRow).toMatchObject({ username: "locked.audit", success: false });

    const auditRow = fakeDatabase.insertedRows.find((row) => row.table === auditLogs)?.values as
      | Record<string, unknown>
      | undefined;
    expect(auditRow).toMatchObject({ action: "auth.login_failed" });
    expect(String(auditRow?.description)).toContain("account temporarily locked");
  });

  it("returns the same refusal for an unknown username, so existence never leaks", async () => {
    fakeDatabase.queueSelectRows([]); // no such user
    fakeDatabase.queueSelectRows(LOCKOUT_SETTINGS);
    fakeDatabase.queueSelectRows(recentFailures(3));

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ghost.user", password: PASSWORD },
    });

    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe("TOO_MANY_REQUESTS");
    expect(response.json().error.message).toMatch(/Too many failed login attempts/);
  });

  it("lets a correct password through below the threshold", async () => {
    const user = await buildTestUser("almost.locked");

    fakeDatabase.queueSelectRows([user]);
    fakeDatabase.queueSelectRows(LOCKOUT_SETTINGS);
    fakeDatabase.queueSelectRows(recentFailures(2)); // below threshold 3

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "almost.locked", password: PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    const loginRow = fakeDatabase.insertedRows.find((row) => row.table === loginAuditLog)?.values as
      | Record<string, unknown>
      | undefined;
    expect(loginRow).toMatchObject({ username: "almost.locked", success: true, userId: user.id });
  });
});
