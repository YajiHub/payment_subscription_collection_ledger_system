// Resets the PostgreSQL database to a clean slate, applies all migrations,
// and seeds a fresh demo dataset.
//
// Usage:
//   pnpm db:reset --confirm

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { closeDatabaseConnection, pool } from "./connection";

async function resetDatabase(): Promise<void> {
  console.log("Resetting database: dropping and recreating public schema, applying migrations, and seeding fresh demo dataset...");

  console.log("Dropping and recreating schema public & drizzle...");
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await pool.query("CREATE SCHEMA public");
  await pool.query("GRANT ALL ON SCHEMA public TO CURRENT_USER");
  await pool.query("GRANT ALL ON SCHEMA public TO public");
  await closeDatabaseConnection();

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

  console.log("Applying all migrations...");
  execSync("pnpm db:migrate", { cwd: repoRoot, stdio: "inherit" });

  console.log("Seeding fresh demo dataset...");
  execSync("pnpm db:seed:demo -- --confirm", { cwd: repoRoot, stdio: "inherit" });

  console.log("\nDatabase reset and fresh seeding complete!");
}

void resetDatabase().catch((error: unknown) => {
  console.error("Reset failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
