// Tests for `pnpm db:reset-passwords`: the two refusals, the bcrypt-only write,
// and idempotency.
//
// The database is mocked, so no PostgreSQL is required; the password hashing is
// the real bcrypt helper, so the "never a plaintext write" claim is proven against
// the same code path the script runs.

import bcrypt from "bcrypt";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db/connection", async () => {
  const { fakeDatabase } = await import("./support/fake-database");
  return {
    db: fakeDatabase.db,
    pool: {},
    checkDatabaseConnection: async () => ({ isReachable: true, latencyMs: 0, errorMessage: null }),
    closeDatabaseConnection: async () => {},
  };
});

import { config } from "../src/config";
import { users } from "../src/db/schema/users";
import {
  assertPasswordResetAllowed,
  PasswordResetRefusedError,
  resetAllPasswords,
} from "../src/db/reset-passwords";
import { fakeDatabase } from "./support/fake-database";

interface UpdatedUserRow {
  passwordHash: string;
  updatedAt: Date;
}

/** The one `users` update the reset recorded, or a failed assertion. */
function singleUpdatedUser(): UpdatedUserRow {
  const userUpdates = fakeDatabase.updatedRows.filter((call) => call.table === users);
  expect(userUpdates).toHaveLength(1);

  const firstUpdate = userUpdates[0];
  expect(firstUpdate).toBeDefined();

  if (firstUpdate === undefined) {
    throw new Error("Expected a users update, but none was recorded");
  }

  return firstUpdate.values as UpdatedUserRow;
}

describe("password reset refusals", () => {
  it("refuses to run in production and says why", () => {
    expect(() => assertPasswordResetAllowed("production", true)).toThrow(PasswordResetRefusedError);
    expect(() => assertPasswordResetAllowed("production", true)).toThrow(/NODE_ENV=production/);
    // The message must name the reason: a published credential, per account, never a batch.
    expect(() => assertPasswordResetAllowed("production", true)).toThrow(
      /published in the documentation/
    );
  });

  it("refuses to run without the confirmation flag", () => {
    expect(() => assertPasswordResetAllowed("development", false)).toThrow(
      /--confirm/
    );
  });

  it("allows a confirmed run outside production", () => {
    expect(() => assertPasswordResetAllowed("development", true)).not.toThrow();
    expect(() => assertPasswordResetAllowed("test", true)).not.toThrow();
  });
});

describe("resetAllPasswords", () => {
  beforeEach(() => {
    fakeDatabase.reset();
  });

  it("rewrites every account with a bcrypt hash, never the plain password", async () => {
    fakeDatabase.queueSelectRows([{ username: "admin" }, { username: "demo.cashier" }]);

    const result = await resetAllPasswords({ confirmed: true });

    expect(result.changedUsernames).toEqual(["admin", "demo.cashier"]);

    const update = singleUpdatedUser();
    expect(update.passwordHash).not.toContain(config.SEED_DEMO_PASSWORD);
    expect(update.passwordHash.startsWith("$2")).toBe(true);
    await expect(bcrypt.compare(config.SEED_DEMO_PASSWORD, update.passwordHash)).resolves.toBe(true);
  });

  it("updates every row, not a filtered subset", async () => {
    fakeDatabase.queueSelectRows([{ username: "admin" }]);

    await resetAllPasswords({ confirmed: true });

    // The reset issues no `WHERE`: every user is in scope by construction.
    expect(fakeDatabase.whereConditions).toHaveLength(0);
    expect(fakeDatabase.updatedRows.filter((call) => call.table === users)).toHaveLength(1);
  });

  it("is idempotent — a second run changes the same accounts", async () => {
    fakeDatabase.queueSelectRows([{ username: "admin" }]);
    const first = await resetAllPasswords({ confirmed: true });

    fakeDatabase.queueSelectRows([{ username: "admin" }]);
    const second = await resetAllPasswords({ confirmed: true });

    expect(second.changedUsernames).toEqual(first.changedUsernames);
  });

  it("refuses before touching the database when confirmation is missing", async () => {
    await expect(resetAllPasswords({ confirmed: false })).rejects.toBeInstanceOf(
      PasswordResetRefusedError
    );
    expect(fakeDatabase.updatedRows).toHaveLength(0);
  });
});
