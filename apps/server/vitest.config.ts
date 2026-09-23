import { defineConfig } from "vitest/config";

// Tests run without PostgreSQL. They set the same environment variables the
// server validates at startup, so `src/config.ts` parses cleanly, and they mock
// the database connection where a query would otherwise be issued.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://bcis_user:test@localhost:5432/bcis_test",
      JWT_SECRET: "test-only-jwt-secret-that-is-definitely-long-enough",
      BCRYPT_ROUNDS: "4", // fast hashing in tests; production default is 12
    },
  },
});
