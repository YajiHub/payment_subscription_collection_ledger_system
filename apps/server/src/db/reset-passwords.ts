// Sets EVERY account's password to the shared development credential.
//
// Why this exists: the passwords a database was seeded with and the passwords the
// documentation advertised have disagreed before, and a database whose demo login
// is unknown could only be fixed by dropping and rebuilding it. This script brings
// every account back to the documented value without touching any other data.
//
// It is a DEVELOPMENT credential and nothing else. See the two refusals below and
// docs/known-limitations.md.
//
// Usage:
//   pnpm db:reset-passwords -- --confirm
//
// Run with:  pnpm db:reset-passwords -- --confirm   (from the repository root)

import { fileURLToPath } from "node:url";
import path from "node:path";

import { asc } from "drizzle-orm";

import { config, DATABASE_TARGET } from "../config";
import { closeDatabaseConnection, db } from "./connection";
import { users } from "./schema/users";
import { hashPassword } from "../shared/password";

/** Raised when the reset refuses to run, so the CLI can explain and exit non-zero. */
export class PasswordResetRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasswordResetRefusedError";
  }
}

/**
 * Guards the reset. Pure on purpose: a test can prove the production refusal by
 * passing `"production"` here instead of re-importing config with a different
 * NODE_ENV.
 *
 * The production stop is the important one. The value this writes is published in
 * the documentation, so running it against a real office database would hand every
 * account — including the Administrator — to anyone who has read the guide. That
 * is a security failure, not a convenience, so it is refused loudly rather than
 * merely warned about.
 */
export function assertPasswordResetAllowed(nodeEnv: string, confirmed: boolean): void {
  if (nodeEnv === "production") {
    throw new PasswordResetRefusedError(
      "Refused: NODE_ENV=production.\n" +
        "This command sets EVERY account's password to the shared development credential.\n" +
        "That credential is published in the documentation, so running it against a real\n" +
        "office database would give anyone who has read the guide a working login — including\n" +
        "the Administrator. Production passwords are set per account through the application\n" +
        "(Users -> Change password), never in a batch.\n" +
        "If this really is a development database, set NODE_ENV=development and run it again."
    );
  }

  if (!confirmed) {
    throw new PasswordResetRefusedError(
      "Refused: this replaces EVERY account's password with the shared development credential.\n" +
        "Run it again with the confirmation flag:  pnpm db:reset-passwords -- --confirm"
    );
  }
}

export interface PasswordResetResult {
  /** Every username whose password was rewritten, so the blast radius is visible. */
  changedUsernames: string[];
}

/**
 * Sets every account's password to the shared development credential.
 *
 * Idempotent: running it twice leaves the same accounts with the same password.
 * Only a bcrypt hash — at the application's configured cost — is ever written, and
 * neither the password nor the hash is logged.
 */
export async function resetAllPasswords(options: {
  confirmed: boolean;
}): Promise<PasswordResetResult> {
  assertPasswordResetAllowed(config.NODE_ENV, options.confirmed);

  const accounts = await db
    .select({ username: users.username })
    .from(users)
    .orderBy(asc(users.username));

  // One hash, reused. Every account shares one published password anyway, so a
  // separate salt per row would only add N slow bcrypt passes without changing
  // what the hashes prove.
  const passwordHash = await hashPassword(config.SEED_DEMO_PASSWORD);

  // A single statement: "every user's password" means every row, not a filter.
  await db.update(users).set({ passwordHash, updatedAt: new Date() });

  return { changedUsernames: accounts.map((account) => account.username) };
}

const isEntryPoint =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isEntryPoint) {
  void (async () => {
    const confirmed = process.argv.includes("--confirm");
    const result = await resetAllPasswords({ confirmed });

    console.log("");
    console.log(`Password reset complete in database "${DATABASE_TARGET.name}" on ${DATABASE_TARGET.host}.`);
    console.log(`Accounts changed: ${result.changedUsernames.length}`);
    for (const username of result.changedUsernames) {
      console.log(`  ${username}`);
    }
    console.log("");
    console.log(
      "Each of them can now sign in with the shared development credential. " +
        "docs/known-limitations.md records why it must be changed before any real deployment."
    );
  })()
    .catch((error: unknown) => {
      if (error instanceof PasswordResetRefusedError) {
        // The refusal message is the whole point; print it verbatim and stop.
        console.error(error.message);
      } else {
        console.error("Password reset failed:", error instanceof Error ? error.message : error);
      }
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeDatabaseConnection();
    });
}
