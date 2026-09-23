// Drizzle Kit configuration — the CLI reads this file for `db:generate` and `db:migrate`.
//
// The schema entry point is the barrel file, so every domain schema file under
// apps/server/src/db/schema is picked up automatically once it is re-exported there.

import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./apps/server/src/db/schema/index.ts",
  out: "./apps/server/src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  verbose: true, // prints the SQL being generated — useful during development
  strict: true, // asks for confirmation before destructive statements
});