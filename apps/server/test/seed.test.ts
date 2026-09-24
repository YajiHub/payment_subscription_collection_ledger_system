// The database seed: it must make a fresh database usable (default settings and
// one Administrator) and must never overwrite something a human has changed.
//
// The database is mocked, so no PostgreSQL is required; the password hashing is
// the real bcrypt helper.

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

import { DEFAULT_SYSTEM_SETTINGS } from "@bcis/shared";
import { config } from "../src/config";
import { users } from "../src/db/schema/users";
import { systemSettings } from "../src/db/schema/system";
import { seedDatabase } from "../src/db/seed";
import { fakeDatabase } from "./support/fake-database";

interface InsertedUserRow {
  fullName: string;
  username: string;
  passwordHash: string;
  role: string;
}

/** The one `users` insert recorded by the fake database, or a failed assertion. */
function singleInsertedUser(): InsertedUserRow {
  const userInserts = fakeDatabase.insertedRows.filter((call) => call.table === users);
  expect(userInserts).toHaveLength(1);

  const firstInsert = userInserts[0];
  expect(firstInsert).toBeDefined();

  if (firstInsert === undefined) {
    throw new Error("Expected a users insert, but none was recorded");
  }

  return firstInsert.values as InsertedUserRow;
}

describe("database seed", () => {
  beforeEach(() => {
    fakeDatabase.reset();
  });

  it("seeds the default business rules", async () => {
    fakeDatabase.queueSelectRows([]);

    await seedDatabase();

    const settingsInsert = fakeDatabase.insertedRows.find(
      (call) => call.table === systemSettings
    );
    expect(settingsInsert).toBeDefined();
    expect(settingsInsert?.values).toHaveLength(DEFAULT_SYSTEM_SETTINGS.length);
  });

  it("creates one Administrator when the username does not exist", async () => {
    fakeDatabase.queueSelectRows([]); // no existing user with that username

    const result = await seedDatabase();

    expect(result.administratorCreated).toBe(true);
    expect(result.administratorUsername).toBe(config.SEED_ADMIN_USERNAME);

    const insertedUser = singleInsertedUser();
    expect(insertedUser.role).toBe("admin");
    expect(insertedUser.username).toBe(config.SEED_ADMIN_USERNAME);
  });

  it("stores only a bcrypt hash, never the plain password", async () => {
    fakeDatabase.queueSelectRows([]);

    await seedDatabase();

    const insertedUser = singleInsertedUser();
    expect(insertedUser.passwordHash).not.toContain(config.SEED_ADMIN_PASSWORD);
    expect(insertedUser.passwordHash.startsWith("$2")).toBe(true);
    await expect(bcrypt.compare(config.SEED_ADMIN_PASSWORD, insertedUser.passwordHash)).resolves.toBe(
      true
    );
  });

  it("does not create or reset an account that already exists", async () => {
    fakeDatabase.queueSelectRows([{ id: "00000000-0000-0000-0000-000000000001" }]);

    const result = await seedDatabase();

    expect(result.administratorCreated).toBe(false);
    const userInserts = fakeDatabase.insertedRows.filter((call) => call.table === users);
    expect(userInserts).toHaveLength(0);
  });
});