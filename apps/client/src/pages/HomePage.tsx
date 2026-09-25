import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";

import { ApiStatusBadge } from "../components/ApiStatusBadge";
import { AppNavigation } from "../components/AppNavigation";
import { useApiHealth } from "../hooks/useApiHealth";
import { API_BASE_URL } from "../lib/constants";
import { useApiStatusStore } from "../stores/api-status.store";
import { useAuthStore } from "../stores/auth.store";

/**
 * Authenticated dashboard.
 * Shows who is signed in, the full navigation menu, and (from Phase 1) proves
 * the client reaches the API and the database.
 */
export function HomePage(): ReactNode {
  useApiHealth();

  const user = useAuthStore((state) => state.user);

  const isReachable = useApiStatusStore((state) => state.isReachable);
  const serviceVersion = useApiStatusStore((state) => state.serviceVersion);
  const databaseLatencyMs = useApiStatusStore((state) => state.databaseLatencyMs);
  const databaseErrorMessage = useApiStatusStore((state) => state.databaseErrorMessage);
  const lastCheckedAt = useApiStatusStore((state) => state.lastCheckedAt);

  // Phase 8 §8: the Management Dashboard is the first screen after login for the
  // Administrator and the Manager. Everyone else stays on this page.
  if (user !== null && (user.role === "admin" || user.role === "manager")) {
    return <Navigate to="/dashboard" replace />;
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
        <AppNavigation />
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
