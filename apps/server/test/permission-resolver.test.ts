// S1-2 / S12-9 — database-backed permission resolution, fail-closed.
//
// Proves the reviewed behaviours:
//   • a user absent from the resolved grants is DENIED (no compiled fallback);
//   • only the explicit string "false" selects the compiled matrix — a missing,
//     garbage or unexpected switch value means the database is the authority;
//   • a database failure FAILS CLOSED;
//   • a cache that is not loaded is resolved on demand (never silently compiled);
//   • a refresh in flight cannot resurrect a snapshot that was invalidated.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db/connection", async () => {
  const { fakeDatabase } = await import("./support/fake-database");
  return {
    db: fakeDatabase.db,
    pool: {},
    checkDatabaseConnection: async () => ({ isReachable: true, latencyMs: 0, errorMessage: null }),
    closeDatabaseConnection: async () => {},
  };
});

import {
  callerHasPermission,
  getPermissionCacheStatus,
  invalidatePermissionCache,
  refreshPermissionCache,
} from "../src/shared/rbac/permission-resolver";
import { setPermissionSourcePreferenceForTests } from "../src/shared/rbac/permission-source";
import { fakeDatabase } from "./support/fake-database";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_USER_ID = "22222222-2222-2222-2222-222222222222";

describe("database-backed permission resolution", () => {
  beforeEach(() => {
    fakeDatabase.reset();
    invalidatePermissionCache();
    // The global test setup installs "compiled"; this suite exercises the real
    // resolver behaviour, which reads the database.
    setPermissionSourcePreferenceForTests("auto");
  });

  it("resolves from the tables and honours a grant the compiled matrix lacks", async () => {
    fakeDatabase.queueSelectRows([{ value: "true" }]);
    fakeDatabase.queueSelectRows([
      { userId: USER_ID, code: "reports:export" },
      { userId: USER_ID, code: "users:deactivate" },
    ]);

    await refreshPermissionCache({ force: true });

    expect(getPermissionCacheStatus()).toBe("database");
    expect(await callerHasPermission(USER_ID, "manager", "reports:export")).toBe(true);
    // A legacy manager has no users:deactivate in the compiled matrix.
    expect(await callerHasPermission(USER_ID, "manager", "users:deactivate")).toBe(true);
  });

  // Item 1: revoking every grant must DENY, not fall back to the compiled role set.
  it("DENIES a user with no resolved grants instead of using the compiled matrix", async () => {
    fakeDatabase.queueSelectRows([{ value: "true" }]);
    fakeDatabase.queueSelectRows([{ userId: OTHER_USER_ID, code: "subscribers:read" }]);

    await refreshPermissionCache({ force: true });

    // A legacy admin is granted users:read by the compiled matrix; the tables have
    // no row for this user, so the answer must be denial.
    expect(await callerHasPermission(USER_ID, "admin", "users:read")).toBe(false);
    expect(await callerHasPermission(USER_ID, "admin", "payments:post")).toBe(false);
  });

  it("falls back to the compiled matrix only for the explicit 'false' switch", async () => {
    fakeDatabase.queueSelectRows([{ value: "false" }]);

    await refreshPermissionCache({ force: true });

    expect(getPermissionCacheStatus()).toBe("compiled");
    expect(await callerHasPermission(USER_ID, "admin", "users:create")).toBe(true);
    expect(await callerHasPermission(USER_ID, "manager", "users:create")).toBe(false);
  });

  it("treats a MISSING switch row as database authority (not compiled)", async () => {
    fakeDatabase.queueSelectRows([]); // no setting row
    fakeDatabase.queueSelectRows([]); // no grants

    await refreshPermissionCache({ force: true });

    expect(getPermissionCacheStatus()).toBe("database");
    expect(await callerHasPermission(USER_ID, "admin", "users:read")).toBe(false);
  });

  it("treats a GARBAGE switch value as database authority (not compiled)", async () => {
    fakeDatabase.queueSelectRows([{ value: "banana" }]);
    fakeDatabase.queueSelectRows([]); // no grants

    await refreshPermissionCache({ force: true });

    expect(getPermissionCacheStatus()).toBe("database");
    expect(await callerHasPermission(USER_ID, "admin", "users:read")).toBe(false);
  });

  it("FAILS CLOSED when the database is unavailable during a refresh", async () => {
    fakeDatabase.failNextSelect(new Error("connection refused"));

    await refreshPermissionCache({ force: true });

    expect(getPermissionCacheStatus()).toBe("denied");
    expect(await callerHasPermission(USER_ID, "admin", "users:read")).toBe(false);
  });

  // Item 3 / 6: an unresolved cache must never be answered from the compiled matrix.
  it("resolves on demand when the cache is not loaded", async () => {
    invalidatePermissionCache();
    expect(getPermissionCacheStatus()).toBe("unloaded");

    fakeDatabase.queueSelectRows([{ value: "false" }]);

    expect(await callerHasPermission(USER_ID, "admin", "users:read")).toBe(true);
  });

  it("denies when the on-demand resolution cannot read the database", async () => {
    invalidatePermissionCache();
    fakeDatabase.failNextSelect(new Error("connection refused"));

    expect(await callerHasPermission(USER_ID, "admin", "users:read")).toBe(false);
    expect(getPermissionCacheStatus()).toBe("denied");
  });

  // Item 5: an invalidate that lands while a refresh is in flight must win.
  it("discards an in-flight refresh that an invalidation superseded", async () => {
    fakeDatabase.queueSelectRows([{ value: "true" }]);
    fakeDatabase.queueSelectRows([{ userId: USER_ID, code: "users:read" }]);

    const inFlight = refreshPermissionCache({ force: true });
    // The invalidation lands before the refresh finishes reading.
    invalidatePermissionCache();

    await inFlight;

    expect(getPermissionCacheStatus()).toBe("unloaded");
    // The stale snapshot must not have been installed: resolving on demand now
    // (no queued rows) yields database authority with no grants → denial.
    expect(await callerHasPermission(USER_ID, "admin", "users:read")).toBe(false);
  });

  it("re-resolves after the real invalidation path", async () => {
    fakeDatabase.queueSelectRows([{ value: "true" }]);
    fakeDatabase.queueSelectRows([{ userId: USER_ID, code: "reports:view" }]);
    await refreshPermissionCache({ force: true });
    expect(await callerHasPermission(USER_ID, "manager", "reports:view")).toBe(true);

    invalidatePermissionCache();
    expect(getPermissionCacheStatus()).toBe("unloaded");

    fakeDatabase.queueSelectRows([{ value: "true" }]);
    fakeDatabase.queueSelectRows([{ userId: USER_ID, code: "payments:verify_gcash" }]);
    await refreshPermissionCache({ force: true });

    expect(await callerHasPermission(USER_ID, "manager", "payments:verify_gcash")).toBe(true);
    expect(await callerHasPermission(USER_ID, "manager", "reports:view")).toBe(false);
  });
});
