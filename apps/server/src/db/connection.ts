// The one place in the codebase that holds the database connection.
// Import `db` from here whenever you need to run a query.

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { config } from "../config";
import * as schema from "./schema";

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10, // supports 3 concurrent clients with room to spare
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000,
});

export const db = drizzle(pool, {
  schema,
  logger: config.NODE_ENV === "development", // logs SQL in dev, silent in production
});

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