import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";

import { roleHasPermission } from "@bcis/shared";
import { ApiStatusBadge } from "../components/ApiStatusBadge";
import { useApiHealth } from "../hooks/useApiHealth";
import { logout as requestServerLogout } from "../lib/api-client";
import { API_BASE_URL } from "../lib/constants";
import { useApiStatusStore } from "../stores/api-status.store";
import { useAuthStore } from "../stores/auth.store";

/**
 * Authenticated dashboard.
 * Shows who is signed in, links to Admin-only screens when permitted,
 * and (from Phase 1) proves the client reaches the API and the database.
 */
export function HomePage(): ReactNode {
  useApiHealth();
  const navigate = useNavigate();

  const user = useAuthStore((state) => state.user);
  const clearSession = useAuthStore((state) => state.logout);

  const isReachable = useApiStatusStore((state) => state.isReachable);
  const serviceVersion = useApiStatusStore((state) => state.serviceVersion);
  const databaseLatencyMs = useApiStatusStore((state) => state.databaseLatencyMs);
  const databaseErrorMessage = useApiStatusStore((state) => state.databaseErrorMessage);
  const lastCheckedAt = useApiStatusStore((state) => state.lastCheckedAt);

  const canManageUsers = user !== null && roleHasPermission(user.role, "users:read");
  const canViewSubscribers = user !== null && roleHasPermission(user.role, "subscribers:read");
  const canViewPlans = user !== null && roleHasPermission(user.role, "plans:read");

  async function handleLogout(): Promise<void> {
    try {
      await requestServerLogout();
    } catch {
      // Even if the server is unreachable, clear the local session so the user can leave.
    }
    clearSession();
    navigate("/login", { replace: true });
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 p-8">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">
            BCIS Subscription Billing and Collection System
          </h1>
          <p className="text-sm text-slate-600">
            Signed in as {user?.fullName ?? "unknown user"} ({user?.role ?? "no role"}).
          </p>
        </div>
        <nav className="flex items-center gap-3 text-sm font-medium">
          {canViewSubscribers && (
            <Link to="/subscribers" className="text-slate-800 underline">
              Subscribers
            </Link>
          )}
          {canViewPlans && (
            <Link to="/plans" className="text-slate-800 underline">
              Plans
            </Link>
          )}
          {canManageUsers && (
            <Link to="/users" className="text-slate-800 underline">
              User Management
            </Link>
          )}
          <button
            type="button"
            onClick={() => void handleLogout()}
            className="text-red-700 underline"
          >
            Log out
          </button>
        </nav>
      </header>

      <section className="space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-medium">System status</h2>
          <ApiStatusBadge isReachable={isReachable} />
        </div>

        <dl className="grid gap-2 text-sm">
          <div className="flex justify-between border-t border-slate-100 pt-2">
            <dt className="text-slate-600">API base URL</dt>
            <dd className="font-mono">{API_BASE_URL}</dd>
          </div>
          <div className="flex justify-between border-t border-slate-100 pt-2">
            <dt className="text-slate-600">API version</dt>
            <dd className="font-mono">{serviceVersion ?? "unknown"}</dd>
          </div>
          <div className="flex justify-between border-t border-slate-100 pt-2">
            <dt className="text-slate-600">Database</dt>
            <dd className="font-mono">
              {databaseLatencyMs !== null
                ? `reachable (${databaseLatencyMs} ms)`
                : (databaseErrorMessage ?? "not checked")}
            </dd>
          </div>
          <div className="flex justify-between border-t border-slate-100 pt-2">
            <dt className="text-slate-600">Last checked</dt>
            <dd className="font-mono">{lastCheckedAt?.toLocaleTimeString() ?? "—"}</dd>
          </div>
        </dl>
      </section>

      <p className="text-xs text-slate-500">
        All data access goes through the Fastify API. The renderer never opens a database connection
        of its own.
      </p>
    </main>
  );
}
