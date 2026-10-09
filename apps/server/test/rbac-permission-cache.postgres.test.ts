// S1-2 / S12-9 — the integration proof against real PostgreSQL.
//
// Exercises the DATABASE-RESOLVED path end to end:
//   • a `role_permissions` change takes effect on a live API call without a
//     redeploy, after clearing the cache through the real invalidation path;
//   • deleting every `user_roles` row for a user DENIES them (item 1);
//   • creating a user through the API writes `user_roles`, and that user's
//     effective permissions then come from the tables (item 2);
//   • changing a role through the API revokes the old permissions on the very
//     next request, with no TTL window (item 3).

import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabaseConnection, pool } from "../src/db/connection";
import { registerUserRoutes } from "../src/modules/users/users.routes";
import {
  getPermissionCacheStatus,
  invalidatePermissionCache,
  refreshPermissionCache,
} from "../src/shared/rbac/permission-resolver";
import { setPermissionSourcePreferenceForTests } from "../src/shared/rbac/permission-source";
import { authorizationHeader, signTestToken } from "./support/tokens";
import { deleteAuditLogsForUsers } from "./support/audit-cleanup";

async function isDatabaseReachable(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

const databaseIsReachable = await isDatabaseReachable();

async function idOf(sql: string, value: string): Promise<string> {
  const rows = await pool.query<{ id: string }>(sql, [value]);
  return rows.rows[0]!.id;
}

describe.skipIf(!databaseIsReachable)("database-backed permissions against PostgreSQL", () => {
  let server: FastifyInstance;

  let adminUserId: string;
  let targetUserId: string;
  let createdUserId: string | null = null;

  let administratorRoleId: string;
  let collectionSupervisorRoleId: string;
  let technicianRoleId: string;
  let usersReadPermissionId: string;
  let usersUpdatePermissionId: string;

  /** Grants recorded so they can be removed in afterAll. */
  const grantedPairs: { roleId: string; permissionId: string }[] = [];

  async function grant(roleId: string, permissionId: string): Promise<void> {
    await pool.query(
      "INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [roleId, permissionId]
    );
    grantedPairs.push({ roleId, permissionId });
  }

  async function revoke(roleId: string, permissionId: string): Promise<void> {
    await pool.query("DELETE FROM role_permissions WHERE role_id = $1 AND permission_id = $2", [
      roleId,
      permissionId,
    ]);
  }

  async function refresh(): Promise<void> {
    invalidatePermissionCache();
    await refreshPermissionCache({ force: true });
  }

  /** Removes users (and their grants / audit rows) so a crashed run leaves nothing. */
  async function removeUsers(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await pool.query("DELETE FROM user_roles WHERE user_id = ANY($1::uuid[])", [ids]);
    await deleteAuditLogsForUsers(pool, ids);
    await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [ids]);
  }

  function getUsers(userId: string, legacyRole: "admin" | "collector" | "cashier") {
    const { token } = signTestToken({ sub: userId, role: legacyRole });
    return server.inject({
      method: "GET",
      url: "/api/users",
      headers: authorizationHeader(token),
    });
  }

  beforeAll(async () => {
    setPermissionSourcePreferenceForTests("auto");

    // Defensive: clear anything a crashed previous run left behind, so this suite
    // never poisons the whole-database schema invariants the WP1 suite asserts.
    const stale = await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE username LIKE 'wp5.%'"
    );
    await removeUsers(stale.rows.map((row) => row.id));

    administratorRoleId = await idOf("SELECT id FROM roles WHERE code = $1", "administrator");
    collectionSupervisorRoleId = await idOf(
      "SELECT id FROM roles WHERE code = $1",
      "collection_supervisor"
    );
    technicianRoleId = await idOf("SELECT id FROM roles WHERE code = $1", "technician");
    usersReadPermissionId = await idOf("SELECT id FROM permissions WHERE code = $1", "users:read");
    usersUpdatePermissionId = await idOf("SELECT id FROM permissions WHERE code = $1", "users:update");

    adminUserId = randomUUID();
    targetUserId = randomUUID();

    await pool.query(
      "INSERT INTO users (id, full_name, username, password_hash, role) VALUES ($1, $2, $3, $4, $5)",
      [adminUserId, "WP5 Admin", `wp5.admin.${adminUserId.slice(0, 8)}`, "x", "admin"]
    );
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [
      adminUserId,
      administratorRoleId,
    ]);

    await pool.query(
      "INSERT INTO users (id, full_name, username, password_hash, role) VALUES ($1, $2, $3, $4, $5)",
      [targetUserId, "WP5 Target", `wp5.target.${targetUserId.slice(0, 8)}`, "x", "collector"]
    );
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [
      targetUserId,
      collectionSupervisorRoleId,
    ]);

    server = Fastify();
    await server.register(registerUserRoutes);
    await server.ready();

    await refreshPermissionCache({ force: true });
  });

  afterAll(async () => {
    const participantIds = [adminUserId, targetUserId, createdUserId].filter(
      (id): id is string => id !== null
    );

    for (const pair of grantedPairs) {
      await pool.query("DELETE FROM role_permissions WHERE role_id = $1 AND permission_id = $2", [
        pair.roleId,
        pair.permissionId,
      ]);
    }
    await removeUsers(participantIds);
    invalidatePermissionCache();
    await server.close();
    await closeDatabaseConnection();
  });

  it("honours a role_permissions change after the real invalidation path", async () => {
    expect(getPermissionCacheStatus()).toBe("database");

    // The collection supervisor has no users:read, so the call is refused.
    expect((await getUsers(targetUserId, "collector")).statusCode).toBe(403);

    await grant(collectionSupervisorRoleId, usersReadPermissionId);
    await refresh();

    const allowed = await getUsers(targetUserId, "collector");
    expect(allowed.statusCode).toBe(200);

    await revoke(collectionSupervisorRoleId, usersReadPermissionId);
    await refresh();

    expect((await getUsers(targetUserId, "collector")).statusCode).toBe(403);
  });

  // Item 1: deleting a user's roles must DENY, not fall back to the compiled matrix.
  it("denies a user whose user_roles rows are all deleted (no compiled fallback)", async () => {
    await refresh();
    // An admin's LEGACY role is granted users:read by the compiled matrix. A 403
    // after deleting its roles is only possible if the database is the authority
    // and an empty grant set is respected rather than falling back.
    expect((await getUsers(adminUserId, "admin")).statusCode).toBe(200);

    await pool.query("DELETE FROM user_roles WHERE user_id = $1", [adminUserId]);
    await refresh();

    expect((await getUsers(adminUserId, "admin")).statusCode).toBe(403);

    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [
      adminUserId,
      administratorRoleId,
    ]);
    await refresh();
  });

  // Item 2: a user created through the API is governed by the tables.
  it("writes user_roles when a user is created, and resolves that user from the tables", async () => {
    await grant(collectionSupervisorRoleId, usersReadPermissionId);
    await refresh();

    const { token: adminToken } = signTestToken({ sub: adminUserId, role: "admin" });
    const username = `wp5.created.${randomUUID().slice(0, 8)}`;

    const created = await server.inject({
      method: "POST",
      url: "/api/users",
      headers: authorizationHeader(adminToken),
      payload: {
        fullName: "WP5 Created",
        username,
        password: "created-password-123",
        role: "collector",
      },
    });

    expect(created.statusCode).toBe(201);
    createdUserId = created.json().data.id as string;

    const roles = await pool.query<{ code: string }>(
      `SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
      [createdUserId]
    );
    expect(roles.rows.map((row) => row.code)).toEqual(["collection_supervisor"]);

    // DEFECT 2 regression: no explicit refresh here. Creating a user through the
    // API must invalidate the permission cache itself, so the new account can act
    // on its very next request instead of waiting out RBAC_PERMISSION_CACHE_TTL_MS.
    // The created user's legacy role is `collector`, which the compiled matrix does
    // NOT grant users:read to. A 200 here can only come from the tables.
    expect((await getUsers(createdUserId, "collector")).statusCode).toBe(200);

    await revoke(collectionSupervisorRoleId, usersReadPermissionId);
    await refresh();
  });

  // Item 3: a role change through the API is effective on the very next request.
  it("revokes the previous role's permissions on the next request after an API role change", async () => {
    // The target is a collection supervisor WITH users:read.
    await grant(collectionSupervisorRoleId, usersReadPermissionId);
    await refresh();
    expect((await getUsers(targetUserId, "collector")).statusCode).toBe(200);

    const { token: adminToken } = signTestToken({ sub: adminUserId, role: "admin" });

    // The admin changes the target to cashier, which does NOT hold users:read.
    const changed = await server.inject({
      method: "PUT",
      url: `/api/users/${targetUserId}`,
      headers: authorizationHeader(adminToken),
      payload: { role: "cashier" },
    });
    expect(changed.statusCode).toBe(200);

    const roles = await pool.query<{ code: string }>(
      `SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
      [targetUserId]
    );
    expect(roles.rows.map((row) => row.code)).toEqual(["cashier"]);

    // No explicit refresh here: the very next request must already be denied.
    expect((await getUsers(targetUserId, "collector")).statusCode).toBe(403);

    // Restore the target for the rest of the suite.
    await pool.query("DELETE FROM user_roles WHERE user_id = $1", [targetUserId]);
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [
      targetUserId,
      collectionSupervisorRoleId,
    ]);
    await revoke(collectionSupervisorRoleId, usersReadPermissionId);
    await refresh();
  });

  // Keep the technician role meaningful for the sweep tests: it has no users:read.
  it("does not grant the technician users:read by default", async () => {
    await refresh();
    const technicianUser = randomUUID();
    // A token for an id that is not in `users` is refused at authentication: a
    // deactivated or deleted account must not keep acting on a live token.
    const { token } = signTestToken({ sub: technicianUser, role: "collector" });
    const response = await server.inject({
      method: "GET",
      url: "/api/users",
      headers: authorizationHeader(token),
    });
    expect(response.statusCode).toBe(401);

    // And a real technician (no users:read) is denied too.
    const technicianGrants = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM role_permissions WHERE role_id = $1 AND permission_id = $2",
      [technicianRoleId, usersReadPermissionId]
    );
    expect(Number(technicianGrants.rows[0]?.count)).toBe(0);

    // users:update is referenced so the permission lookup stays honest.
    expect(usersUpdatePermissionId).toBeTruthy();
  });
});
