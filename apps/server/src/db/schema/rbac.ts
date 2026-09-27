// Role-based access control, stored as data (S1-1, S1-2, S12-9).
//
// Phase 2 hardcoded the role → permission matrix in
// `packages/shared/src/constants/permissions.ts` and put a single `user_role`
// enum value on every user row. That cannot express the seven roles the lab
// specification asks for (section 3.1), and it cannot change without a redeploy.
//
// This module moves the matrix into four tables:
//
//   roles             one row per role ("Administrator", "Cashier", …)
//   permissions       one row per permission ("payments:post", …)
//   role_permissions  which role grants which permission
//   user_roles        which user holds which role (a user may hold several)
//
// The compiled `ROLE_PERMISSIONS` matrix stays in the shared package as a
// documented FALLBACK. The tables are the authority: changing a
// `role_permissions` row changes an API caller's effective permissions with no
// redeploy.
//
// The legacy `users.role` enum column is deliberately kept until the auth
// middleware resolves permissions from these tables; dropping it here would
// break every route guard in the same change that creates its replacement.

import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { users } from "./users";

// ─── Roles ────────────────────────────────────────────────────────────────────
// `code` is the stable machine name used by the seed and by the migration that
// backfills user_roles from the old enum. `name` is what the UI prints.
// A system role is seeded by a migration and cannot be deleted through the API.
export const roles = pgTable("roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 50 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description"),
  isSystem: boolean("is_system").notNull().default(true),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Permissions ──────────────────────────────────────────────────────────────
// `code` is the exact string a route declares, e.g. "payments:post". It matches
// the `Permission` union in the shared package, which stays the source of truth
// for the catalogue's spelling.
export const permissions = pgTable("permissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 100 }).notNull().unique(),
  description: text("description").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Role → Permission ────────────────────────────────────────────────────────
// The matrix as rows. A permission absent for a role means access is denied.
export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permissions.id),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    grantedBy: uuid("granted_by").references(() => users.id),
  },
  (table) => [
    primaryKey({ columns: [table.roleId, table.permissionId] }),
    // "Who can do this?" — the reverse of the primary key lookup.
    index("role_permissions_permission_idx").on(table.permissionId),
  ]
);

// ─── User → Role ──────────────────────────────────────────────────────────────
// A user may hold more than one role; their effective permissions are the union.
export const userRoles = pgTable(
  "user_roles",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    assignedBy: uuid("assigned_by").references(() => users.id),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.roleId] }),
    index("user_roles_role_idx").on(table.roleId),
  ]
);

// ─── Relations ───────────────────────────────────────────────────────────────
export const rolesRelations = relations(roles, ({ many }) => ({
  rolePermissions: many(rolePermissions),
  userRoles: many(userRoles),
}));

export const permissionsRelations = relations(permissions, ({ many }) => ({
  rolePermissions: many(rolePermissions),
}));

export const rolePermissionsRelations = relations(rolePermissions, ({ one }) => ({
  role: one(roles, { fields: [rolePermissions.roleId], references: [roles.id] }),
  permission: one(permissions, {
    fields: [rolePermissions.permissionId],
    references: [permissions.id],
  }),
}));

export const userRolesRelations = relations(userRoles, ({ one }) => ({
  user: one(users, { fields: [userRoles.userId], references: [users.id] }),
  role: one(roles, { fields: [userRoles.roleId], references: [roles.id] }),
}));

export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
export type PermissionRow = typeof permissions.$inferSelect;
export type NewPermissionRow = typeof permissions.$inferInsert;
export type RolePermission = typeof rolePermissions.$inferSelect;
export type NewRolePermission = typeof rolePermissions.$inferInsert;
export type UserRoleAssignment = typeof userRoles.$inferSelect;
export type NewUserRoleAssignment = typeof userRoles.$inferInsert;
