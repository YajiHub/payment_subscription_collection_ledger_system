// User accounts and authentication tables.
//
// Phase 1 creates the identity table only, because every later domain table
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

export const usersRelations = relations(users, () => ({}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;