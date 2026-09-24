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

import { USER_ROLES, roleHasPermission, type Permission, type UserRole } from "@bcis/shared";
import { buildServer } from "../src/index.ts";
import { authenticate } from "../src/shared/middleware/authenticate";
import { authorize, type AuthorizeHandler } from "../src/shared/middleware/authorize";
import { validationPlugin } from "../src/shared/plugins/validation.plugin";
import { registerAuditRoutes } from "../src/modules/audit/audit.routes";
import { registerAuthRoutes } from "../src/modules/auth/auth.routes";
import { registerBillingRoutes } from "../src/modules/billing/billing.routes";
import { registerInvoiceRoutes } from "../src/modules/billing/invoices.routes";
import { registerCollectorBatchRoutes } from "../src/modules/collections/collector-batches.routes";
import { registerDashboardRoutes } from "../src/modules/dashboard/dashboard.routes";
import { registerHealthRoutes } from "../src/modules/health/health.routes";
import { registerLedgerRoutes } from "../src/modules/ledger/ledger.routes";
import { registerPaymentRoutes } from "../src/modules/payments/payments.routes";
import { registerPlanRoutes } from "../src/modules/plans/plans.routes";
import { registerReceivablesRoutes } from "../src/modules/receivables/receivables.routes";
import { registerReportRoutes } from "../src/modules/reports/reports.routes";
import { registerServiceAccountRoutes } from "../src/modules/service-accounts/service-accounts.routes";
import { registerSubscriberRoutes } from "../src/modules/subscribers/subscribers.routes";
import { registerSystemRoutes } from "../src/modules/system/system.routes";
import { registerUserRoutes } from "../src/modules/users/users.routes";
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
  { method: "POST", url: "/api/invoices/:id/post", permission: "invoices:generate" },
  { method: "POST", url: "/api/invoices/:id/void", permission: "invoices:void" },
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
  { method: "GET", url: "/api/collector-batches/collectors", permission: "collector_batches:create" },
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

  await app.register(registerHealthRoutes);
  await app.register(registerAuthRoutes);
  await app.register(registerUserRoutes);
  await app.register(registerPlanRoutes);
  await app.register(registerSubscriberRoutes);
  await app.register(registerServiceAccountRoutes);
  await app.register(registerBillingRoutes);
  await app.register(registerInvoiceRoutes);
  await app.register(registerPaymentRoutes);
  await app.register(registerLedgerRoutes);
  await app.register(registerCollectorBatchRoutes);
  await app.register(registerReceivablesRoutes);
  await app.register(registerDashboardRoutes);
  await app.register(registerReportRoutes);
  await app.register(registerAuditRoutes);
  await app.register(registerSystemRoutes);
  await app.ready();

  return captured;
}

/** Replaces `:param` segments with a value so the request reaches the middleware. */
function resolveRouteUrl(url: string): string {
  return url.replace(/:[^/]+/g, randomUUID());
}

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

  it("captures exactly the routes the canonical map expects, with no extras", () => {
    const actual = capturedRoutes
      .map((route) => `${route.method} ${route.url}:${route.permission ?? "auth-only"}`)
      .sort();
    const expected = EXPECTED_PERMISSIONS.map(
      (route) => `${route.method} ${route.url}:${route.permission ?? "auth-only"}`
    ).sort();

    expect(actual).toEqual(expected);
  });

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
