// Database-backed permission resolution (S1-2, S12-9).
//
// `authorize()` used to call `roleHasPermission`, a pure lookup in the compiled
// `ROLE_PERMISSIONS` matrix. That matrix cannot change without a redeploy, which
// is exactly what section 4.4 forbids. This module resolves a caller's effective
// permissions from the four RBAC tables instead.
//
// The compiled matrix is NOT a general fallback. It is used only when the
// `rbac_permissions_in_database` setting is the explicit string "false" (the
// documented rollback switch). A missing setting, a garbage value, a settings row
// lost in a restore, or a database that cannot be read all mean the DATABASE is
// the authority — and if the tables cannot be read, every check is REFUSED.
//
// Why a cache:
//   Authorization runs on every request. The resolved matrix is held in memory,
//   refreshed on a short TTL (RBAC_PERMISSION_CACHE_TTL_MS), and invalidated
//   explicitly whenever roles or grants change. A cache that is not loaded is
//   resolved on demand; it is NEVER answered from the compiled matrix.
//
// Fail-closed rules (all enforced here, not in the middleware):
//   • status "denied"            → every check is refused.
//   • status "unloaded"          → resolved on demand; refused if that fails.
//   • database mode, user absent → REFUSED (revoking all of a user's grants must
//                                  not silently re-grant the compiled role set).
//   • database failure           → status "denied" until a refresh succeeds.
//
// Stale-resurrection guard:
//   Every invalidation bumps a monotonic epoch. A refresh captures the epoch when
//   it starts and discards its result if an invalidation happened meanwhile, so an
//   in-flight refresh can never overwrite newer authority with an old snapshot.

import { SYSTEM_SETTING_KEYS, roleHasPermission, type Permission, type UserRole } from "@bcis/shared";
import { eq } from "drizzle-orm";

import { config } from "../../config";
import { db } from "../../db/connection";
import { permissions, rolePermissions, userRoles } from "../../db/schema/rbac";
import { systemSettings } from "../../db/schema/system";
import { getPermissionSourcePreference } from "./permission-source";

/**
 * Where the current answer comes from.
 *
 *   unloaded — not resolved yet; resolved on demand (never the compiled matrix)
 *   database — the RBAC tables are authoritative
 *   compiled — the rollback switch is the explicit string "false"
 *   denied   — resolution failed; every check is refused (fail closed)
 */
export type PermissionCacheStatus = "unloaded" | "database" | "compiled" | "denied";

interface PermissionCache {
  status: PermissionCacheStatus;
  loadedAtMs: number;
  /** Monotonic generation, bumped by every invalidation. */
  epoch: number;
  /** user id → the union of permissions the roles that user holds grant. */
  grantsByUserId: Map<string, ReadonlySet<Permission>>;
}

// A process-wide cache. A server process is the only writer of this state.
const cache: PermissionCache = {
  status: "unloaded",
  loadedAtMs: 0,
  epoch: 0,
  grantsByUserId: new Map(),
};

/** The current source of truth; exposed for tests and diagnostics. */
export function getPermissionCacheStatus(): PermissionCacheStatus {
  return cache.status;
}

/**
 * Drops the cached matrix so the next request re-reads the source. Called after
 * any change to roles, `role_permissions` or `user_roles`.
 *
 * The cache always moves to "unloaded", which DENIES until it is re-resolved
 * (on demand, or by the refresh the caller kicks off), so there is never a window
 * in which the compiled matrix grants more than the tables do.
 */
export function invalidatePermissionCache(): void {
  cache.epoch += 1;
  cache.grantsByUserId.clear();
  cache.status = "unloaded";
  cache.loadedAtMs = 0;
}

/** Installs the compiled matrix. Only reached for the explicit "false" switch. */
function useCompiledMatrix(): void {
  cache.grantsByUserId.clear();
  cache.status = "compiled";
  cache.loadedAtMs = Date.now();
}

/**
 * Rebuilds the cache from the database.
 *
 * Never throws: a database failure moves the cache to "denied", which refuses
 * every check. A refresh that is still within the TTL is skipped unless `force`
 * is set.
 */
export async function refreshPermissionCache(options: { force?: boolean } = {}): Promise<void> {
  const isFresh =
    cache.status !== "unloaded" &&
    Date.now() - cache.loadedAtMs < config.RBAC_PERMISSION_CACHE_TTL_MS;

  if (isFresh && options.force !== true) {
    return;
  }

  // Captured before any await: if an invalidation lands while this refresh is in
  // flight, the epoch will differ and the result is discarded.
  const startedEpoch = cache.epoch;

  // Test-only preference; production never installs "compiled" this way.
  if (getPermissionSourcePreference() === "compiled") {
    if (cache.epoch === startedEpoch) {
      useCompiledMatrix();
    }
    return;
  }

  try {
    const switchRow = await db
      .select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, SYSTEM_SETTING_KEYS.rbacPermissionsInDatabase))
      .limit(1)
      .then((rows) => rows[0]);

    // ONLY the explicit string "false" selects the compiled fallback.
    if (switchRow?.value === "false") {
      if (cache.epoch === startedEpoch) {
        useCompiledMatrix();
      }
      return;
    }

    const grants = await db
      .select({ userId: userRoles.userId, code: permissions.code })
      .from(userRoles)
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, userRoles.roleId))
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId));

    // Discard a snapshot invalidated while it was being read.
    if (cache.epoch !== startedEpoch) {
      return;
    }

    const grantsByUserId = new Map<string, Set<Permission>>();
    for (const grant of grants) {
      const granted = grantsByUserId.get(grant.userId) ?? new Set<Permission>();
      granted.add(grant.code as Permission);
      grantsByUserId.set(grant.userId, granted);
    }

    cache.grantsByUserId = grantsByUserId;
    cache.status = "database";
    cache.loadedAtMs = Date.now();
  } catch (error) {
    console.error(
      "[RBAC] Could not resolve permissions from the database; refusing every request until it recovers",
      error
    );
    // Do not clobber a newer invalidation with a failure from an older read.
    if (cache.epoch !== startedEpoch) {
      return;
    }
    cache.grantsByUserId.clear();
    cache.status = "denied";
    cache.loadedAtMs = Date.now();
  }
}

/**
 * Loads the cache before the server starts serving, so there is no boot window in
 * which authorization is unresolved.
 */
export async function ensurePermissionCacheLoaded(): Promise<void> {
  await refreshPermissionCache({ force: true });
}

/**
 * Whether the caller may perform an operation.
 *
 * Resolves on demand when the cache is not loaded, so an invalidation (or a cold
 * start) never silently answers from the compiled matrix. Asynchronous because
 * that resolve-on-demand reads the database; the steady state is a lookup.
 */
export async function callerHasPermission(
  userId: string,
  legacyRole: UserRole,
  permission: Permission
): Promise<boolean> {
  if (cache.status === "unloaded") {
    await refreshPermissionCache({ force: true });
  }

  if (cache.status === "compiled") {
    return roleHasPermission(legacyRole, permission);
  }

  if (cache.status === "database") {
    // A user with no resolved grants is DENIED. Deleting every `user_roles` row or
    // revoking every permission must not fall back to the compiled role set.
    return cache.grantsByUserId.get(userId)?.has(permission) ?? false;
  }

  // "denied", or still "unloaded" because the on-demand refresh was discarded.
  return false;
}

/**
 * Whether the caller has any resolved grants at all, used only to explain a refusal.
 *
 * A caller with no resolved permissions is not "their role lacks this one" — they
 * have no permissions resolved, which usually means the account is not present in
 * the role tables (or the token predates its role assignment). The message names
 * that real cause instead of blaming a role that was never the authority.
 *
 * Only the database source can answer this. Under the compiled rollback matrix or
 * a failed resolution the role is still the best explanation, so this reports true.
 */
export function callerHasResolvedGrants(userId: string): boolean {
  if (cache.status !== "database") {
    return true;
  }
  return (cache.grantsByUserId.get(userId)?.size ?? 0) > 0;
}

/**
 * Keeps the cache warm on the TTL interval. The initial load is awaited separately
 * (see `ensurePermissionCacheLoaded`) so the first request is never served from an
 * unresolved cache. Returns the timer so a caller can stop it.
 */
export function startPermissionCacheRefresh(): NodeJS.Timeout {
  const timer = setInterval(() => {
    void refreshPermissionCache();
  }, config.RBAC_PERMISSION_CACHE_TTL_MS);

  // Do not keep the process alive just for the refresh timer.
  timer.unref();
  return timer;
}
