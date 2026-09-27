// Vitest setup (runs once per test file, before the file's own imports).
//
// Installs the "compiled" permission source for the whole test run. Production
// never selects the compiled matrix this way — the resolver only falls back to it
// when `system_settings.rbac_permissions_in_database` is the explicit string
// "false". The legacy-role HTTP suites have no database of RBAC tables, so they
// run against the compiled matrix; the suites that exercise the database-resolved
// path (and the real-PostgreSQL suites) switch the source back to "auto"
// themselves.

import { setPermissionSourcePreferenceForTests } from "../../src/shared/rbac/permission-source";

setPermissionSourcePreferenceForTests("compiled");
