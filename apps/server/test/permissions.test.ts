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

  it("lets a Billing Clerk manage plans, as Phase 3's Plan Management page requires", () => {
    expect(roleHasPermission("billing_clerk", "plans:read")).toBe(true);
    expect(roleHasPermission("billing_clerk", "plans:create")).toBe(true);
    expect(roleHasPermission("billing_clerk", "plans:update")).toBe(true);
  });

  it("denies a Cashier the ability to manage subscribers or invoices generation", () => {
    expect(roleHasPermission("cashier", "subscribers:create")).toBe(false);
    expect(roleHasPermission("cashier", "subscribers:update")).toBe(false);
    expect(roleHasPermission("cashier", "invoices:generate")).toBe(false);
  });

  it("denies a Collector the ability to post office payments", () => {
    expect(roleHasPermission("collector", "payments:post")).toBe(false);
  });

  it("denies a Collector creating collector batches, since office staff assign the work", () => {
    // Phase 7 §6: POST /api/collector-batches is for Admin and Billing Clerk.
    // A collector works the batches assigned to them and remits the cash, but
    // creating batches would let field staff invent their own assignments.
    expect(roleHasPermission("collector", "collector_batches:create")).toBe(false);
    expect(roleHasPermission("billing_clerk", "collector_batches:create")).toBe(true);
    expect(roleHasPermission("collector", "collector_batches:read")).toBe(true);
    expect(roleHasPermission("collector", "collector_batches:remit")).toBe(true);
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

  it("lets a Billing Clerk create collector batches, as Phase 7 requires", () => {
    expect(roleHasPermission("billing_clerk", "collector_batches:create")).toBe(true);
    expect(roleHasPermission("billing_clerk", "collector_batches:remit")).toBe(false);
  });

  it("lets a Cashier read and reconcile batches but never create or remit them", () => {
    expect(roleHasPermission("cashier", "collector_batches:read")).toBe(true);
    expect(roleHasPermission("cashier", "collector_batches:reconcile")).toBe(true);
    expect(roleHasPermission("cashier", "collector_batches:create")).toBe(false);
    expect(roleHasPermission("cashier", "collector_batches:remit")).toBe(false);
  });

  it("denies a Collector reconciliation of their own collection work", () => {
    expect(roleHasPermission("collector", "collector_batches:read")).toBe(true);
    expect(roleHasPermission("collector", "collector_batches:remit")).toBe(true);
    expect(roleHasPermission("collector", "collector_batches:reconcile")).toBe(false);
  });

  it("lets a Manager read batches but change none of them", () => {
    expect(roleHasPermission("manager", "collector_batches:read")).toBe(true);
    expect(roleHasPermission("manager", "collector_batches:reconcile")).toBe(false);
    expect(roleHasPermission("manager", "collector_batches:remit")).toBe(false);
  });

  it("grants every role reports:view but only Admin and Manager reports:export", () => {
    for (const role of USER_ROLES) {
      expect(roleHasPermission(role, "reports:view")).toBe(true);
    }

    expect(roleHasPermission("manager", "reports:export")).toBe(true);
    expect(roleHasPermission("admin", "reports:export")).toBe(true);
    expect(roleHasPermission("cashier", "reports:export")).toBe(false);
    expect(roleHasPermission("billing_clerk", "reports:export")).toBe(false);
    expect(roleHasPermission("collector", "reports:export")).toBe(false);
  });

  it("reserves reports:management_view for the Admin, Billing Clerk, and Manager", () => {
    // Phase 8 §9: a Cashier may view the daily collection report but not the
    // management reports (monthly billing, AR aging, outstanding by collector).
    expect(roleHasPermission("admin", "reports:management_view")).toBe(true);
    expect(roleHasPermission("billing_clerk", "reports:management_view")).toBe(true);
    expect(roleHasPermission("manager", "reports:management_view")).toBe(true);

    expect(roleHasPermission("cashier", "reports:management_view")).toBe(false);
    expect(roleHasPermission("collector", "reports:management_view")).toBe(false);
  });

  it("denies a role the matrix does not know rather than crashing on the lookup", () => {
    // A token minted by an older build can carry a role this matrix has no entry
    // for; the safe answer is a denial, not an exception while reading the matrix.
    expect(roleHasPermission("auditor" as UserRole, "reports:view")).toBe(false);
  });
});