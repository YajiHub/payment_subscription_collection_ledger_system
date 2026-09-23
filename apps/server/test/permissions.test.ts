// Tests for the permission matrix — the single source of truth for RBAC.
// These are pure and need no server or database.

import { describe, expect, it } from "vitest";

import {
  ROLE_PERMISSIONS,
  USER_ROLES,
  roleHasPermission,
  type Permission,
  type UserRole,
} from "@bcis/shared";

describe("role permission matrix", () => {
  it("covers every role and every permission name with a decision", () => {
    for (const role of USER_ROLES) {
      expect(Array.isArray(ROLE_PERMISSIONS[role])).toBe(true);
    }
  });

  it("grants the Admin every permission in the system", () => {
    const allPermissions = new Set<Permission>(Object.values(ROLE_PERMISSIONS).flat());
    for (const permission of allPermissions) {
      expect(roleHasPermission("admin", permission)).toBe(true);
    }
  });

  it("denies a Cashier the ability to generate invoices", () => {
    expect(roleHasPermission("cashier", "invoices:generate")).toBe(false);
  });

  it("denies a Billing Clerk the ability to post payments or manage users", () => {
    expect(roleHasPermission("billing_clerk", "payments:post")).toBe(false);
    expect(roleHasPermission("billing_clerk", "users:create")).toBe(false);
  });

  it("denies a Cashier the ability to manage subscribers or invoices generation", () => {
    expect(roleHasPermission("cashier", "subscribers:create")).toBe(false);
    expect(roleHasPermission("cashier", "subscribers:update")).toBe(false);
    expect(roleHasPermission("cashier", "invoices:generate")).toBe(false);
  });

  it("denies a Collector the ability to post office payments", () => {
    expect(roleHasPermission("collector", "payments:post")).toBe(false);
    expect(roleHasPermission("collector", "collector_batches:create")).toBe(true);
  });

  it("treats the Manager as read-only", () => {
    const writePermissions: Permission[] = [
      "subscribers:create",
      "subscribers:update",
      "invoices:generate",
      "invoices:void",
      "payments:post",
      "users:create",
      "users:update",
      "collector_batches:create",
      "collector_batches:remit",
    ];

    for (const permission of writePermissions) {
      expect(roleHasPermission("manager", permission)).toBe(false);
    }
    expect(roleHasPermission("manager", "reports:view")).toBe(true);
    expect(roleHasPermission("manager", "reports:export")).toBe(true);
  });

  it("keeps only the Admin able to manage users", () => {
    const nonAdmins: UserRole[] = ["billing_clerk", "cashier", "collector", "manager"];
    for (const role of nonAdmins) {
      expect(roleHasPermission(role, "users:create")).toBe(false);
      expect(roleHasPermission(role, "users:update")).toBe(false);
      expect(roleHasPermission(role, "users:deactivate")).toBe(false);
    }
  });
});
