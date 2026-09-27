// Which source the permission resolver reads from (S1-2, S12-9).
//
// Production NEVER selects the compiled matrix here. The resolver only falls back
// to `ROLE_PERMISSIONS` when the database's `rbac_permissions_in_database` switch
// holds the explicit string "false". This module exists so the legacy-role HTTP
// suites can run without a database at all: the test setup installs "compiled" for
// the whole run. The setter refuses to run outside NODE_ENV=test.

import { config } from "../../config";

export type PermissionSourcePreference = "auto" | "compiled";

let preference: PermissionSourcePreference = "auto";

/** "auto" reads the database (the production behaviour); "compiled" is test-only. */
export function getPermissionSourcePreference(): PermissionSourcePreference {
  return preference;
}

/** Test-only override. Throws when called from anything but the test process. */
export function setPermissionSourcePreferenceForTests(value: PermissionSourcePreference): void {
  if (config.NODE_ENV !== "test") {
    throw new Error("setPermissionSourcePreferenceForTests may only be called in tests");
  }
  preference = value;
}
