// The one place in the codebase that holds the database connection.
// Import `db` from here whenever you need to run a query.

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { config } from "../config";
import * as schema from "./schema";

/** A parameter that is a bcrypt hash: every bcrypt variant starts with `$2`. */
const BCRYPT_HASH_PREFIX = "$2";

/**
 * Drizzle's SQL logger with bcrypt hashes removed before the line is written.
 *
 * The SQL log is useful in development, but a statement that sets a password
 * carries the bcrypt hash as a parameter. A hash is credential material, so it is
 * redacted here — once, for every writer (the seeds, `db:reset-passwords`, account
 * creation, a password change), rather than each writer remembering to turn the
 * log off. The plain password is never a parameter: only `hashPassword` output is.
 */
const redactingSqlLogger = {
  logQuery(query: string, params: unknown[]): void {
    const redactedParams = params.map((param) =>
      typeof param === "string" && param.startsWith(BCRYPT_HASH_PREFIX)
        ? "[bcrypt hash redacted]"
        : param
    );
    console.log(`Query: ${query} -- params: ${JSON.stringify(redactedParams)}`);
  },
};

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10, // supports 3 concurrent clients with room to spare
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000,
});

export const db = drizzle(pool, {
  schema,
  // Logs SQL in development (with hashes redacted), silent in production.
  logger: config.NODE_ENV === "development" ? redactingSqlLogger : false,
});

/**
 * The connection handle, or a handle inside a transaction.
 *
 * Both expose the same query builder, so a service function can accept either
 * one. Passing `db` runs the statements as they are; passing the `tx` from
 * `db.transaction(...)` binds them to that transaction so they commit or roll
 * back together.
 */
export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface DatabaseHealthResult {
  isReachable: boolean;
  latencyMs: number;
  errorMessage: string | null;
}

/**
 * Runs a trivial query to prove the database really answers.
 * Never throws: an unreachable database is reported, not swallowed, so the
 * health endpoint can return an honest answer instead of crashing the server.
 */
export async function checkDatabaseConnection(): Promise<DatabaseHealthResult> {
  const startedAt = performance.now();

  try {
    await pool.query("SELECT 1");
    return {
      isReachable: true,
      latencyMs: Math.round(performance.now() - startedAt),
      errorMessage: null,
    };
  } catch (error) {
    return {
      isReachable: false,
      latencyMs: Math.round(performance.now() - startedAt),
      errorMessage: error instanceof Error ? error.message : "Unknown database error",
    };
  }
}

/** Closes the connection pool during graceful shutdown. */
export async function closeDatabaseConnection(): Promise<void> {
  await pool.end();
}
