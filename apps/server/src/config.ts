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
  PORT: z.coerce.number().default(3003),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, "JWT secret must be at least 32 characters"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  BCRYPT_ROUNDS: z.coerce.number().default(12),
  // General API rate limit, per client IP. Phase 9 §4.
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  // The stricter limit applied to the login endpoint specifically, per IP.
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  // Per-account failed-login lockout (S5-5). These are the bootstrap defaults;
  // an administrator may override them in `system_settings` without a redeploy.
  // LOGIN_LOCKOUT_THRESHOLD is how many consecutive failures lock one account;
  // LOGIN_LOCKOUT_COOLDOWN_MINUTES is how long the account stays locked.
  LOGIN_LOCKOUT_THRESHOLD: z.coerce.number().int().positive().default(5),
  LOGIN_LOCKOUT_COOLDOWN_MINUTES: z.coerce.number().int().nonnegative().default(15),
  // How long the database-resolved permission matrix may be reused before it is
  // refreshed from `role_permissions` (S1-2, S12-9). A short window keeps RBAC
  // changes responsive while avoiding a query on every request.
  RBAC_PERMISSION_CACHE_TTL_MS: z.coerce.number().int().positive().default(30_000),
  // Where application backups are written. Relative paths resolve against the
  // server's working directory; the directory is git-ignored.
  BACKUP_DIR: z.string().default("backups"),
  // Where GCash proof screenshots are written. Relative paths resolve against the
  // server's working directory; the directory is git-ignored.
  UPLOADS_DIR: z.string().default("uploads"),

  // The bootstrap Administrator that `pnpm db:seed` creates when the username is
  // absent. Seeding is idempotent: an account whose password has already been
  // changed is never reset. Change the password immediately after the first login.
  SEED_ADMIN_USERNAME: z.string().min(1).default("admin"),
  SEED_ADMIN_PASSWORD: z.string().min(8).default("Admin@1234!"),
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

/**
 * The environment a helper script (backup.sh, restore.sh) should inherit, with
 * the given variables layered on top.
 *
 * This lives here so config.ts stays the ONLY module that touches `process.env`:
 * the backup service calls it instead of spreading `process.env` itself.
 */
export function childProcessEnvironment(
  overrides: Record<string, string>
): NodeJS.ProcessEnv {
  return { ...process.env, ...overrides };
}

/** Reported by GET /health so a client can tell which build it is talking to. */
export const SERVICE_VERSION = "0.1.0";