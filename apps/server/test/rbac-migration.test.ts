// WP1 §1 — the role/permission data the RBAC migration seeds (S1-1, S5-1, S5-2).
//
// These assertions need no database: they pin the invariants that make the
// migration safe to apply to a populated system, above all that no existing user
// can lose a permission when the five legacy `users.role` values are mapped onto
// the seven stored roles.
//
// The migration seeds rows from these same constants, so a change that would
// break a user's access fails here rather than in production.

import { describe, expect, it } from "vitest";

import {
  LEGACY_ROLE_TO_SYSTEM_ROLE,
  PERMISSION_DESCRIPTIONS,
  ROLE_PERMISSIONS,
  SYSTEM_ROLE_DESCRIPTIONS,
  SYSTEM_ROLE_LABELS,
  SYSTEM_ROLES,
  SYSTEM_ROLE_PERMISSIONS,
  USER_ROLES,
  type Permission,
} from "@bcis/shared";

const CATALOGUE = Object.keys(PERMISSION_DESCRIPTIONS) as Permission[];

describe("RBAC data migration constants", () => {
  it("defines exactly the seven roles of section 3.1", () => {
    expect(SYSTEM_ROLES).toEqual([
      "owner",
      "administrator",
      "cashier",
      "collection_supervisor",
      "accounting_auditor",
      "technician",
      "read_only_viewer",
    ]);

    for (const role of SYSTEM_ROLES) {
      expect(SYSTEM_ROLE_LABELS[role]).toBeTruthy();
      expect(SYSTEM_ROLE_DESCRIPTIONS[role]).toBeTruthy();
    }
  });

  it("catalogues every permission a legacy role can hold", () => {
    for (const granted of Object.values(ROLE_PERMISSIONS).flat()) {
      expect(PERMISSION_DESCRIPTIONS[granted]).toBeTruthy();
    }
  });

  it("seeds every catalogued permission onto at least one stored role", () => {
    for (const permission of CATALOGUE) {
      const reachable = SYSTEM_ROLES.some((role) =>
        SYSTEM_ROLE_PERMISSIONS[role].includes(permission)
      );
      expect(reachable, `no stored role grants ${permission}`).toBe(true);
    }
  });

  it("maps every legacy role onto a stored role", () => {
    expect(Object.keys(LEGACY_ROLE_TO_SYSTEM_ROLE).sort()).toEqual([...USER_ROLES].sort());

    for (const storedRole of Object.values(LEGACY_ROLE_TO_SYSTEM_ROLE)) {
      expect(SYSTEM_ROLES).toContain(storedRole);
    }
  });

  it("never lets a migrated user lose a permission", () => {
    // This is the migration's core promise: the stored role a legacy role maps
    // onto holds AT LEAST everything the legacy role could do. Where one stored
    // role covers two legacy roles (Cashier), it is seeded with their union.
    for (const legacyRole of USER_ROLES) {
      const storedRole = LEGACY_ROLE_TO_SYSTEM_ROLE[legacyRole];
      const storedPermissions = new Set<Permission>(SYSTEM_ROLE_PERMISSIONS[storedRole]);

      for (const permission of ROLE_PERMISSIONS[legacyRole]) {
        expect(
          storedPermissions.has(permission),
          `${legacyRole} → ${storedRole} would lose ${permission}`
        ).toBe(true);
      }
    }
  });

  it("keeps the compiled fallback matrix complete", () => {
    // ROLE_PERMISSIONS stays as the fallback until the auth middleware reads the
    // tables, so it must keep covering every legacy role and only real permissions.
    const catalogue = new Set<Permission>(CATALOGUE);

    for (const role of USER_ROLES) {
      expect(ROLE_PERMISSIONS[role].length).toBeGreaterThan(0);
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(catalogue.has(permission)).toBe(true);
      }
    }
  });

  it("gives the owner and the administrator the whole catalogue", () => {
    expect([...SYSTEM_ROLE_PERMISSIONS.owner].sort()).toEqual([...CATALOGUE].sort());
    expect([...SYSTEM_ROLE_PERMISSIONS.administrator].sort()).toEqual([...CATALOGUE].sort());
  });
});
