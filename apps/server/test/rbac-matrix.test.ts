// Phase 9 RBAC sweep: every route's declared permission is checked against the
// canonical matrix, and every protected route is attacked without a token and
// with a wrong role.
//
// Two things are proven here that a per-route test never could:
//
//   1. The permission a route DECLARES is the permission the canonical matrix
//      says it should have — read straight off the route table, not retyped.
//   2. No protected route was forgotten: the sweep walks the real Fastify route
//      table, so a new route with no `authorize` fails the "unauthenticated → 401"
//      check instead of silently shipping.

import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
  SYSTEM_ROLES,
  SYSTEM_ROLE_PERMISSIONS,
  USER_ROLES,
  roleHasPermission,
  type Permission,
  type SystemRole,
  type UserRole,
} from "@bcis/shared";
import { buildServer, ROUTE_REGISTRARS } from "../src/index.ts";
import { authenticate } from "../src/shared/middleware/authenticate";
import { authorize, type AuthorizeHandler } from "../src/shared/middleware/authorize";
import { validationPlugin } from "../src/shared/plugins/validation.plugin";
import {
  getPermissionCacheStatus,
  invalidatePermissionCache,
  refreshPermissionCache,
} from "../src/shared/rbac/permission-resolver";
import { setPermissionSourcePreferenceForTests } from "../src/shared/rbac/permission-source";
import { fakeDatabase } from "./support/fake-database";
import { authorizationHeader, signTestToken } from "./support/tokens";

interface CapturedRoute {
  method: string;
  url: string;
  requiresAuthentication: boolean;
  permission: Permission | null;
}

/** The permission each route must enforce, taken from the design of the system. */
const EXPECTED_PERMISSIONS: { method: string; url: string; permission: Permission | null }[] = [
  // Health — public operational probes.
  { method: "GET", url: "/health", permission: null },
  { method: "GET", url: "/health/db", permission: null },
  // Auth — login is public; logout and me need only a valid token.
  { method: "POST", url: "/api/auth/login", permission: null },
  { method: "POST", url: "/api/auth/logout", permission: null },
  { method: "GET", url: "/api/auth/me", permission: null },
  // Users.
  { method: "GET", url: "/api/users", permission: "users:read" },
  { method: "GET", url: "/api/users/:id", permission: "users:read" },
  { method: "POST", url: "/api/users", permission: "users:create" },
  { method: "PUT", url: "/api/users/:id", permission: "users:update" },
  { method: "PUT", url: "/api/users/:id/password", permission: "users:update" },
  { method: "PUT", url: "/api/users/:id/deactivate", permission: "users:deactivate" },
  // Plans.
  { method: "GET", url: "/api/plans", permission: "plans:read" },
  { method: "GET", url: "/api/plans/:id", permission: "plans:read" },
  { method: "POST", url: "/api/plans", permission: "plans:create" },
  { method: "PUT", url: "/api/plans/:id", permission: "plans:update" },
  { method: "PUT", url: "/api/plans/:id/retire", permission: "plans:update" },
  // Subscribers.
  { method: "GET", url: "/api/subscribers", permission: "subscribers:read" },
  { method: "GET", url: "/api/subscribers/search", permission: "subscribers:read" },
  { method: "GET", url: "/api/subscribers/:id", permission: "subscribers:read" },
  { method: "GET", url: "/api/subscribers/:id/statement", permission: "subscribers:read" },
  { method: "POST", url: "/api/subscribers", permission: "subscribers:create" },
  { method: "PUT", url: "/api/subscribers/:id", permission: "subscribers:update" },
  // Service accounts.
  { method: "GET", url: "/api/service-accounts/:id", permission: "subscribers:read" },
  { method: "POST", url: "/api/subscribers/:id/service-accounts", permission: "subscribers:create" },
  { method: "PUT", url: "/api/service-accounts/:id/suspend", permission: "subscribers:suspend" },
  { method: "PUT", url: "/api/service-accounts/:id/reconnect", permission: "subscribers:reconnect" },
  { method: "PUT", url: "/api/service-accounts/:id/terminate", permission: "subscribers:suspend" },
  { method: "PUT", url: "/api/service-accounts/:id/plan", permission: "subscribers:update" },
  { method: "PUT", url: "/api/service-accounts/:id/collector", permission: "subscribers:update" },
  // Billing.
  { method: "GET", url: "/api/billing/run-preview", permission: "invoices:read" },
  { method: "GET", url: "/api/billing/runs", permission: "invoices:read" },
  { method: "POST", url: "/api/billing/run", permission: "invoices:generate" },
  { method: "POST", url: "/api/billing/post-all-draft", permission: "invoices:generate" },
  { method: "POST", url: "/api/billing/apply-late-fees", permission: "invoices:generate" },
  // Invoices.
  { method: "GET", url: "/api/invoices", permission: "invoices:read" },
  { method: "GET", url: "/api/invoices/:id", permission: "invoices:read" },
  { method: "POST", url: "/api/invoices/reconnection-fee", permission: "invoices:generate" },
  { method: "POST", url: "/api/invoices/installation-fee", permission: "invoices:generate" },
  { method: "POST", url: "/api/invoices/:id/post", permission: "invoices:generate" },
  { method: "POST", url: "/api/invoices/:id/void", permission: "invoices:void" },
  // A discount writes down an existing invoice, so it takes the narrow invoice
  // mutation permission rather than the generation one (which a Cashier holds).
  { method: "POST", url: "/api/invoices/:id/discount", permission: "invoices:void" },
  // Payments.
  { method: "GET", url: "/api/payments/receipt/:receiptNumber", permission: "payments:read" },
  { method: "POST", url: "/api/payments/gcash/upload-screenshot", permission: "payments:post" },
  { method: "GET", url: "/api/payments/gcash/screenshot/:paymentId", permission: "payments:read" },
  { method: "POST", url: "/api/payments", permission: "payments:post" },
  { method: "GET", url: "/api/payments", permission: "payments:read" },
  { method: "GET", url: "/api/payments/:id", permission: "payments:read" },
  { method: "POST", url: "/api/payments/:id/reverse", permission: "payments:reverse" },
  { method: "GET", url: "/api/service-accounts/:serviceAccountId/payments", permission: "payments:read" },
  { method: "GET", url: "/api/service-accounts/:serviceAccountId/payment-summary", permission: "payments:read" },
  // Ledger.
  { method: "GET", url: "/api/ledger/verify/:serviceAccountId", permission: "ledger:verify" },
  { method: "POST", url: "/api/ledger/manual-entry", permission: "ledger:adjust" },
  { method: "GET", url: "/api/service-accounts/:id/ledger", permission: "ledger:read" },
  { method: "GET", url: "/api/service-accounts/:id/balance", permission: "ledger:read" },
  { method: "GET", url: "/api/service-accounts/:id/statement", permission: "ledger:read" },
  // Collector batches.
  // S5-8: this list endpoint is a READ, so it is guarded by the read permission
  // rather than the write permission it used to demand.
  { method: "GET", url: "/api/collector-batches/collectors", permission: "collector_batches:read" },
  { method: "GET", url: "/api/collector-batches", permission: "collector_batches:read" },
  { method: "POST", url: "/api/collector-batches", permission: "collector_batches:create" },
  { method: "GET", url: "/api/collector-batches/:id", permission: "collector_batches:read" },
  { method: "POST", url: "/api/collector-batches/:id/assignments", permission: "collector_batches:create" },
  { method: "PUT", url: "/api/collector-batches/:id/assignments/:serviceAccountId/void", permission: "collector_batches:reconcile" },
  { method: "PUT", url: "/api/collector-batches/:id/assignments/:serviceAccountId", permission: "collector_batches:remit" },
  { method: "POST", url: "/api/collector-batches/:id/submit", permission: "collector_batches:remit" },
  { method: "POST", url: "/api/collector-batches/:id/reconcile", permission: "collector_batches:reconcile" },
  { method: "POST", url: "/api/collector-batches/:id/cancel", permission: "collector_batches:create" },
  // Receivables.
  { method: "GET", url: "/api/receivables/ar-aging/export", permission: "reports:export" },
  { method: "GET", url: "/api/receivables/ar-aging", permission: "reports:view" },
  { method: "GET", url: "/api/receivables/overdue", permission: "reports:view" },
  { method: "GET", url: "/api/receivables/overdue-summary", permission: "reports:view" },
  { method: "POST", url: "/api/receivables/overdue/suspend", permission: "subscribers:suspend" },
  // Dashboard.
  { method: "GET", url: "/api/dashboard/kpis", permission: "reports:management_view" },
  // Reports.
  { method: "GET", url: "/api/reports/daily-collection", permission: "reports:view" },
  { method: "GET", url: "/api/reports/monthly-billing", permission: "reports:management_view" },
  { method: "GET", url: "/api/reports/ar-aging", permission: "reports:management_view" },
  { method: "GET", url: "/api/reports/collector-remittance", permission: "reports:view" },
  { method: "GET", url: "/api/reports/outstanding-by-collector", permission: "reports:management_view" },
  { method: "POST", url: "/api/reports/export-pdf", permission: "reports:export" },
  { method: "POST", url: "/api/reports/export-xlsx", permission: "reports:export" },
  // Phase 9 — audit trail and system settings.
  { method: "GET", url: "/api/audit-logs", permission: "audit:read" },
  { method: "GET", url: "/api/system/settings", permission: null },
  { method: "PUT", url: "/api/system/settings", permission: "system:settings" },
  { method: "GET", url: "/api/system/health/extended", permission: "system:settings" },
  // Backups (S5-3) — create/verify under backup:create, restore under backup:restore.
  { method: "GET", url: "/api/backups", permission: "backup:create" },
  { method: "POST", url: "/api/backups", permission: "backup:create" },
  { method: "POST", url: "/api/backups/:id/verify", permission: "backup:create" },
  { method: "POST", url: "/api/backups/:id/restore", permission: "backup:restore" },
];

/** Registers every route module on a bare instance so `onRoute` can observe them. */
async function captureRoutes(): Promise<CapturedRoute[]> {
  const captured: CapturedRoute[] = [];
  const app = Fastify();

  // The routes that declare a Zod schema need the Zod compilers, exactly as the
  // real server installs them, or Fastify tries to read the schema as JSON Schema.
  validationPlugin(app);

  app.addHook("onRoute", (route) => {
    const asArray = <T>(value: T | T[] | undefined): T[] =>
      value === undefined ? [] : Array.isArray(value) ? value : [value];

    // Authentication may be declared as an `onRequest` hook or a `preHandler`;
    // both run before the handler, but only `onRequest` runs before validation.
    const preHandlers = [
      ...asArray(route.onRequest),
      ...asArray(route.preHandler),
    ];

    const authorizeHandler = preHandlers.find(
      (handler): handler is AuthorizeHandler =>
        typeof handler === "function" && "permission" in handler
    );

    const methods = Array.isArray(route.method) ? route.method : [route.method];

    for (const method of methods) {
      // Fastify auto-registers a HEAD route for each GET; it is not a route the
      // team wrote, and a HEAD response has no body to inspect.
      if (method === "HEAD") {
        continue;
      }

      captured.push({
        method,
        url: route.url,
        requiresAuthentication: preHandlers.includes(authenticate),
        permission: authorizeHandler?.permission ?? null,
      });
    }
  });

  // The module list is derived from ROUTE_REGISTRARS (index.ts) rather than
  // re-listed here, so a newly added module is swept automatically and cannot
  // silently escape the authorization matrix.
  for (const registerRoutes of ROUTE_REGISTRARS) {
    await app.register(registerRoutes);
  }
  await app.ready();

  return captured;
}

/** Replaces `:param` segments with a value so the request reaches the middleware. */
function resolveRouteUrl(url: string): string {
  return url.replace(/:[^/]+/g, randomUUID());
}

/** A route that is intentionally reachable with authentication and no permission. */
const AUTH_ONLY_ROUTES = new Set([
  "POST /api/auth/login",
  "POST /api/auth/logout",
  "GET /api/auth/me",
  "GET /api/system/settings",
]);

/** A role that the canonical matrix says does NOT hold the permission. */
function findRoleWithoutPermission(permission: Permission): UserRole | null {
  for (const role of USER_ROLES) {
    if (!roleHasPermission(role, permission)) {
      return role;
    }
  }
  return null;
}

describe("RBAC matrix sweep", () => {
  let capturedRoutes: CapturedRoute[];
  let server: FastifyInstance;

  beforeAll(async () => {
    capturedRoutes = await captureRoutes();
    server = buildServer();
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    fakeDatabase.reset();
  });

  // Note: this intentionally does NOT assert the route table equals
  // EXPECTED_PERMISSIONS exactly. Another work package (WP6) adds report routes to
  // the same table, and an exact-equality check would fail on their work rather
  // than on a real authorization defect. Two stronger checks below replace it:
  // every module's permissioned routes are swept dynamically by the exhaustive
  // matrix, and every /api route without a permission fails the guard test — so a
  // new route cannot ship unguarded.
  it("enforces the permission the canonical matrix assigns to each route", () => {
    for (const expectedRoute of EXPECTED_PERMISSIONS) {
      const route = capturedRoutes.find(
        (candidate) =>
          candidate.method === expectedRoute.method && candidate.url === expectedRoute.url
      );

      expect(route, `${expectedRoute.method} ${expectedRoute.url} was not registered`).toBeDefined();
      expect(route?.permission, `${expectedRoute.method} ${expectedRoute.url}`).toBe(
        expectedRoute.permission
      );
    }
  });

  it("protects every /api route with authentication except login", () => {
    const protectedRoutes = capturedRoutes.filter(
      (route) => route.url.startsWith("/api") && route.url !== "/api/auth/login"
    );

    for (const route of protectedRoutes) {
      expect(route.requiresAuthentication, `${route.method} ${route.url}`).toBe(true);
    }
  });

  it("rejects an unauthenticated request to every protected route with 401", async () => {
    const protectedRoutes = capturedRoutes.filter((route) => route.requiresAuthentication);

    for (const route of protectedRoutes) {
      const response = await server.inject({
        method: route.method as "GET" | "POST" | "PUT" | "DELETE",
        url: resolveRouteUrl(route.url),
      });

      expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
      expect(response.json().error.code, `${route.method} ${route.url}`).toBe("UNAUTHORIZED");
    }
  });

  it("rejects a permitted-but-wrong-role request to every permissioned route with 403", async () => {
    const permissionedRoutes = capturedRoutes.filter((route) => route.permission !== null);

    for (const route of permissionedRoutes) {
      const permission = route.permission as Permission;
      // Prefer a real role the matrix denies; fall back to an unknown role when
      // every role is allowed the permission (a read that is open to all staff).
      const wrongRole = findRoleWithoutPermission(permission) ?? ("ghost_role" as UserRole);
      const { token } = signTestToken({ role: wrongRole });

      fakeDatabase.queueSelectRows([]); // authenticate: token revocation lookup

      const response = await server.inject({
        method: route.method as "GET" | "POST" | "PUT" | "DELETE",
        url: resolveRouteUrl(route.url),
        headers: authorizationHeader(token),
      });

      expect(response.statusCode, `${route.method} ${route.url} as ${wrongRole}`).toBe(403);
      expect(response.json().error.code, `${route.method} ${route.url}`).toBe("FORBIDDEN");
    }
  });

  // S5-7 — the exhaustive matrix. For EVERY permissioned route and EVERY role it
  // asserts the outcome the canonical matrix demands: an allowed role must not be
  // refused with 403, and a denied role must be refused with 403. It is driven by
  // the real route table, so a new route is swept automatically.
  it("allows and denies every role on every permissioned route exactly as the matrix says", async () => {
    const permissionedRoutes = capturedRoutes.filter((route) => route.permission !== null);

    for (const route of permissionedRoutes) {
      const permission = route.permission as Permission;

      for (const role of USER_ROLES) {
        const isAllowed = roleHasPermission(role, permission);
        const { token } = signTestToken({ role });
        fakeDatabase.queueSelectRows([]); // authenticate: token revocation lookup

        const response = await server.inject({
          method: route.method as "GET" | "POST" | "PUT" | "DELETE",
          url: resolveRouteUrl(route.url),
          headers: authorizationHeader(token),
        });

        const label = `${route.method} ${route.url} as ${role} for ${permission}`;
        if (isAllowed) {
          // The handler may fail for other reasons with the mocked database; what
          // must never happen is an authorization refusal.
          expect(response.statusCode, `${label} should be allowed`).not.toBe(403);
        } else {
          expect(response.statusCode, `${label} should be denied`).toBe(403);
          expect(response.json().error.code, label).toBe("FORBIDDEN");
        }
      }
    }
  });

  // Item 12: the same sweep over the SEVEN stored roles of section 3.1, driven by
  // the DATABASE-RESOLVED path. Each stored role is seeded as a user's grants in the
  // fake database, so the oracle is SYSTEM_ROLE_PERMISSIONS and the resolver really
  // reads the tables rather than the compiled matrix.
  it("allows and denies the seven stored roles via the database-resolved path", async () => {
    setPermissionSourcePreferenceForTests("auto");
    invalidatePermissionCache();

    const userIdByRole = Object.fromEntries(
      SYSTEM_ROLES.map((role) => [role, randomUUID()])
    ) as Record<SystemRole, string>;

    const grantRows = SYSTEM_ROLES.flatMap((role) =>
      SYSTEM_ROLE_PERMISSIONS[role].map((code) => ({ userId: userIdByRole[role], code }))
    );
    fakeDatabase.queueSelectRows([{ value: "true" }]);
    fakeDatabase.queueSelectRows(grantRows);
    await refreshPermissionCache({ force: true });
    expect(getPermissionCacheStatus()).toBe("database");

    try {
      const permissionedRoutes = capturedRoutes.filter((route) => route.permission !== null);

      for (const route of permissionedRoutes) {
        const permission = route.permission as Permission;

        for (const role of SYSTEM_ROLES) {
          const isAllowed = SYSTEM_ROLE_PERMISSIONS[role].includes(permission);
          // The legacy role in the token is irrelevant in database mode; the grants
          // come from the user id.
          const { token } = signTestToken({ sub: userIdByRole[role], role: "manager" });
          fakeDatabase.queueSelectRows([]); // authenticate: token revocation lookup

          const response = await server.inject({
            method: route.method as "GET" | "POST" | "PUT" | "DELETE",
            url: resolveRouteUrl(route.url),
            headers: authorizationHeader(token),
          });

          const label = `${route.method} ${route.url} as stored role ${role} for ${permission}`;
          if (isAllowed) {
            expect(response.statusCode, `${label} should be allowed`).not.toBe(403);
          } else {
            expect(response.statusCode, `${label} should be denied`).toBe(403);
            expect(response.json().error.code, label).toBe("FORBIDDEN");
          }
        }
      }
    } finally {
      // Restore the compiled source the rest of the file runs on.
      setPermissionSourcePreferenceForTests("compiled");
      await refreshPermissionCache({ force: true });
    }
  });

  // S5-7 — a new route cannot escape the matrix: every /api route must carry a
  // permission, unless it is one of the handful that is deliberately
  // authentication-only. Adding an unguarded route fails here.
  it("gives every protected /api route a permission guard", () => {
    const unguarded = capturedRoutes
      .filter((route) => route.url.startsWith("/api"))
      .filter((route) => route.permission === null)
      .filter((route) => !AUTH_ONLY_ROUTES.has(`${route.method} ${route.url}`))
      .map((route) => `${route.method} ${route.url}`);

    expect(unguarded).toEqual([]);
  });

  it("answers 401 rather than 403 when no token is presented to a permissioned route", async () => {
    const permissionedRoutes = capturedRoutes.filter((route) => route.permission !== null);

    for (const route of permissionedRoutes) {
      const response = await server.inject({
        method: route.method as "GET" | "POST" | "PUT" | "DELETE",
        url: resolveRouteUrl(route.url),
      });

      expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
    }
  });

  it("attaches the permission to the authorize middleware so the sweep reads the real value", () => {
    expect(authorize("users:read").permission).toBe("users:read");
    expect(authorize("payments:reverse").permission).toBe("payments:reverse");
  });
});
