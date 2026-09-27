// S5-2 — the permission catalogue (acceptance: "Permission test asserts each
// exists and is assigned").
//
// The lab specification names some permissions in `domain.verb` form; this
// repository spells them `domain:verb`. This suite pins the equivalence and proves
// the new permissions are catalogued and assigned to the right roles, with least
// privilege: a Technician and a Read-only Viewer gain nothing.

import { describe, expect, it } from "vitest";

import {
  PERMISSION_DESCRIPTIONS,
  ROLE_PERMISSIONS,
  SYSTEM_ROLES,
  SYSTEM_ROLE_PERMISSIONS,
  USER_ROLES,
  type Permission,
} from "@bcis/shared";

const CATALOGUE = Object.keys(PERMISSION_DESCRIPTIONS) as Permission[];

/** The spec-named permissions mapped onto their repository spelling. */
const SPEC_NAMED_EQUIVALENTS: { spec: string; permission: Permission }[] = [
  { spec: "subscriber.view", permission: "subscribers:read" },
  { spec: "billing.generate", permission: "invoices:generate" },
  { spec: "payment.create", permission: "payments:post" },
  { spec: "payment.reverse", permission: "payments:reverse" },
  { spec: "collection.reconcile", permission: "collector_batches:reconcile" },
  { spec: "report.export", permission: "reports:export" },
  { spec: "user.manage", permission: "users:create" },
  { spec: "user.manage", permission: "users:update" },
  { spec: "user.manage", permission: "users:deactivate" },
  { spec: "backup.restore", permission: "backup:restore" },
  { spec: "backup.create", permission: "backup:create" },
];

/** The permissions this work added (no earlier equivalent exists). */
const NEW_PERMISSIONS: Permission[] = [
  "payments:verify_gcash",
  "payments:reject_gcash",
  "payments:allocate_manually",
  "backup:create",
  "backup:restore",
];

describe("S5-2 permission catalogue", () => {
  it("catalogues every spec-named permission under the repository spelling", () => {
    const catalogued = new Set<Permission>(CATALOGUE);

    for (const { spec, permission } of SPEC_NAMED_EQUIVALENTS) {
      expect(catalogued.has(permission), `${spec} → ${permission} is missing`).toBe(true);
    }
  });

  it("adds the GCash verification, manual-allocation and split-backup permissions", () => {
    const catalogued = new Set<Permission>(CATALOGUE);

    for (const permission of NEW_PERMISSIONS) {
      expect(catalogued.has(permission), `${permission} is missing`).toBe(true);
      expect(PERMISSION_DESCRIPTIONS[permission]).toBeTruthy();
    }
  });

  it("assigns every new permission to at least one stored role", () => {
    for (const permission of NEW_PERMISSIONS) {
      const assigned = SYSTEM_ROLES.some((role) => SYSTEM_ROLE_PERMISSIONS[role].includes(permission));
      expect(assigned, `no stored role holds ${permission}`).toBe(true);
    }
  });

  it("assigns every new permission to at least one legacy role as the fallback", () => {
    for (const permission of NEW_PERMISSIONS) {
      const assigned = USER_ROLES.some((role) => ROLE_PERMISSIONS[role].includes(permission));
      expect(assigned, `no legacy role holds ${permission}`).toBe(true);
    }
  });

  it("does not grant the new write permissions to a Technician or a Read-only Viewer", () => {
    for (const role of ["technician", "read_only_viewer"] as const) {
      for (const permission of NEW_PERMISSIONS) {
        expect(
          SYSTEM_ROLE_PERMISSIONS[role].includes(permission),
          `${role} must not hold ${permission}`
        ).toBe(false);
      }
    }
  });

  it("reserves the backup permissions for the owner and the administrator", () => {
    for (const permission of ["backup:create", "backup:restore"] as Permission[]) {
      const holders = SYSTEM_ROLES.filter((role) =>
        SYSTEM_ROLE_PERMISSIONS[role].includes(permission)
      );
      expect(holders.sort()).toEqual(["administrator", "owner"]);
    }
  });

  it("gives the GCash and manual-allocation permissions to the cashier counter role", () => {
    for (const permission of [
      "payments:verify_gcash",
      "payments:reject_gcash",
      "payments:allocate_manually",
    ] as Permission[]) {
      expect(SYSTEM_ROLE_PERMISSIONS.cashier).toContain(permission);
    }
  });
});
