// User accounts and authentication tables.
//
// Phase 1 created the identity table, because every later domain table
// references a user (who created this invoice, who posted this payment).
// Phase 2 adds login_audit_log and revoked_tokens here.

import { relations } from "drizzle-orm";
import { boolean, pgEnum, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

// The five roles defined by the lab specification.
// Adding a role requires updating this enum AND the Phase 2 permission matrix.
export const userRoleEnum = pgEnum("user_role", [
  "admin",
  "billing_clerk",
  "cashier",
  "collector",
  "manager",
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),

  // Display name shown in the UI and printed on receipts
  fullName: varchar("full_name", { length: 100 }).notNull(),

  // Used for login — must be unique across the system
  username: varchar("username", { length: 50 }).notNull().unique(),

  // bcrypt hash — NEVER stored in plaintext
  passwordHash: text("password_hash").notNull(),

  role: userRoleEnum("role").notNull(),

  // Soft-disable an account without deleting it.
  // Deactivated users' names still appear on old receipts and audit logs.
  isActive: boolean("is_active").notNull().default(true),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),

  // Who created this user account — links to users.id (self-referential)
  createdBy: uuid("created_by"),
});

// Tracks every login attempt — successful or failed.
// Used for security monitoring and the audit trail.
export const loginAuditLog = pgTable("login_audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: varchar("username", { length: 50 }).notNull(),
  success: boolean("success").notNull(),

  // IP address of the machine that attempted login.
  // In a LAN environment this identifies which PC made the attempt.
  ipAddress: varchar("ip_address", { length: 45 }),

  attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),

  // Only populated on successful logins.
  userId: uuid("user_id").references(() => users.id),
});

// Tracks JWT tokens that have been explicitly logged out.
// Without this, a stolen token would remain valid until expiry.
export const revokedTokens = pgTable("revoked_tokens", {
  // We store the JWT "jti" (JWT ID) claim, not the full token.
  jti: uuid("jti").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  revokedAt: timestamp("revoked_at", { withTimezone: true }).notNull().defaultNow(),

  // Tokens expire, so old rows can be cleaned up after expiry.
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

// Relations make it easy to query a user together with their audit log.
export const usersRelations = relations(users, ({ many }) => ({
  loginAttempts: many(loginAuditLog),
}));

export const loginAuditLogRelations = relations(loginAuditLog, ({ one }) => ({
  user: one(users, { fields: [loginAuditLog.userId], references: [users.id] }),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type LoginAuditEntry = typeof loginAuditLog.$inferSelect;
export type RevokedToken = typeof revokedTokens.$inferSelect;
