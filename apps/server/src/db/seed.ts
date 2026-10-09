// Seeds a fresh database with everything the system needs before first use:
//   • the default business rules (system_settings), and
//   • one Administrator account, so somebody can log in at all.
//
// Safe to run more than once. The settings insert uses ON CONFLICT DO NOTHING and
// the Administrator is created only when the username is absent, so an account
// whose password was changed after the first seed is never reset.
//
// Run with:  pnpm db:seed     (from the repository root)

import { fileURLToPath } from "node:url";
import path from "node:path";

import { eq } from "drizzle-orm";

import { config } from "../config";
import { closeDatabaseConnection, db } from "./connection";
import { roles, userRoles } from "./schema/rbac";
import { users } from "./schema/users";
import { ensureSystemSettingsSeeded } from "../modules/system/system-settings.service";
import { hashPassword } from "../shared/password";

export interface SeedResult {
  /** True when this run created the Administrator; false when it already existed. */
  administratorCreated: boolean;
  administratorUsername: string;
}

/**
 * Brings a fresh database up to a usable state.
 *
 * Idempotent by design: it never overwrites a stored value and never replaces an
 * existing user, because either could undo an administrator's deliberate change.
 */
export async function seedDatabase(): Promise<SeedResult> {
  await ensureSystemSettingsSeeded();

  const existingAdministrator = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, config.SEED_ADMIN_USERNAME))
    .limit(1)
    .then((rows) => rows[0]);

  let adminUserId = existingAdministrator?.id;
  let administratorCreated = false;

  if (adminUserId === undefined) {
    // The plain password never leaves this function: only the bcrypt hash is stored.
    const passwordHash = await hashPassword(config.SEED_ADMIN_PASSWORD);

    const [created] = await db
      .insert(users)
      .values({
        fullName: "System Administrator",
        username: config.SEED_ADMIN_USERNAME,
        passwordHash,
        role: "admin",
      })
      .returning({ id: users.id });

    adminUserId = created?.id;
    administratorCreated = true;
  }

  // Ensure the administrator holds the authoritative 'administrator' role in user_roles
  if (adminUserId !== undefined) {
    const adminRoleRow = await db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.code, "administrator"))
      .limit(1)
      .then((rows) => rows[0]);

    if (adminRoleRow !== undefined) {
      await db
        .insert(userRoles)
        .values({
          userId: adminUserId,
          roleId: adminRoleRow.id,
          assignedBy: null,
        })
        .onConflictDoNothing();
    }
  }

  return {
    administratorCreated,
    administratorUsername: config.SEED_ADMIN_USERNAME,
  };
}

const isEntryPoint =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isEntryPoint) {
  void seedDatabase()
    .then((result) => {
      if (result.administratorCreated) {
        console.log(
          `Created administrator "${result.administratorUsername}". ` +
            "Change its password immediately after the first login."
        );
      } else {
        console.log(
          `Administrator "${result.administratorUsername}" already exists — left unchanged.`
        );
      }
      console.log("Default system settings are in place.");
    })
    .catch((error: unknown) => {
      console.error("Seeding failed:", error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeDatabaseConnection();
    });
}
