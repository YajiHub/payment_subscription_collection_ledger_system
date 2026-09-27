import { defineConfig } from "vitest/config";

// Tests run without PostgreSQL. They set the same environment variables the
// server validates at startup, so `src/config.ts` parses cleanly, and they mock
// the database connection where a query would otherwise be issued.
//
// The one exception is the database-backed integration suite, which connects to
// DATABASE_URL and skips itself when nothing answers. An explicit DATABASE_URL
// wins, so a developer can point it at any server; the default matches the local
// placeholder documented in .env.example and targets a dedicated bcis_test database.
export default defineConfig({
  test: {
    environment: "node",
    // Installs the compiled permission source for the whole run (see the file for
    // why). The database-resolved path opts back into "auto" itself.
    setupFiles: ["./test/support/setup-permission-mode.ts"],
    // The DB-backed suites share one bcis_test database and assert whole-database
    // invariants (e.g. AR aging grand total = sum of all outstanding invoices).
    // Running files in parallel lets one suite mutate balances between another
    // suite's snapshot and its raw-SQL re-sum, so the results are nondeterministic.
    fileParallelism: false,
    include: ["test/**/*.test.ts"],
    env: {
      NODE_ENV: "test",
      DATABASE_URL:
        process.env.DATABASE_URL ??
        "postgresql://bcis_user:change_this@localhost:5432/bcis_test",
      JWT_SECRET: "test-only-jwt-secret-that-is-definitely-long-enough",
      BCRYPT_ROUNDS: "4", // fast hashing in tests; production default is 12
      // The general API rate limit would otherwise trip on a busy test file; the
      // login limit stays at its real default so the hardening test is honest.
      RATE_LIMIT_MAX: "100000",
      LOGIN_RATE_LIMIT_MAX: "10",
    },
  },
});
