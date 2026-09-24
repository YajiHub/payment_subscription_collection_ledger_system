// Everything the server needs to know about its environment.
// This is the ONLY file in the server that reads process.env.
//
// Change a variable here → it propagates everywhere automatically.
// If a required variable is missing or malformed, the server crashes immediately
// with a clear message. That is intentional: silent misconfiguration is worse
// than a loud crash.

import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3001),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, "JWT secret must be at least 32 characters"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  BCRYPT_ROUNDS: z.coerce.number().default(12),
  // General API rate limit, per client IP. Phase 9 §4.
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  // The stricter limit applied to the login endpoint specifically, per IP.
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  // Where GCash proof screenshots are written. Relative paths resolve against the
  // server's working directory; the directory is git-ignored.
  UPLOADS_DIR: z.string().default("uploads"),
});

const parsedEnvironment = environmentSchema.safeParse(process.env);

if (!parsedEnvironment.success) {
  const problems = parsedEnvironment.error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");

  throw new Error(
    `Invalid environment configuration. Check your .env file against .env.example:\n${problems}`
  );
}

export const config = parsedEnvironment.data;

/** Reported by GET /health so a client can tell which build it is talking to. */
export const SERVICE_VERSION = "0.1.0";