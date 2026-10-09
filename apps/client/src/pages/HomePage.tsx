import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";

import { roleHasPermission } from "@bcis/shared";
import { ApiStatusBadge } from "../components/ApiStatusBadge";
import { AppShell } from "../components/layout/AppShell";
import { API_BASE_URL } from "../lib/constants";
import { useApiStatusStore } from "../stores/api-status.store";
import { useAuthStore } from "../stores/auth.store";

/**
 * Authenticated welcome page for operational roles without management dashboard access.
 * Shows who is signed in, provides full navigation via AppShell, and proves
 * the client reaches the API and the database.
 */
export function HomePage(): ReactNode {
  const user = useAuthStore((state) => state.user);

  const isReachable = useApiStatusStore((state) => state.isReachable);
  const serviceVersion = useApiStatusStore((state) => state.serviceVersion);
  const databaseLatencyMs = useApiStatusStore((state) => state.databaseLatencyMs);
  const databaseErrorMessage = useApiStatusStore((state) => state.databaseErrorMessage);
  const lastCheckedAt = useApiStatusStore((state) => state.lastCheckedAt);

  // The Management Dashboard is the first screen after login for roles with
  // management report permissions (Owner, Administrator, Manager, Auditor, Viewer).
  if (user !== null && roleHasPermission(user.role, "reports:management_view")) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <AppShell
      pageTitle="BCIS Subscription Billing and Collection System"
      pageDescription={`Signed in as ${user?.fullName ?? "unknown user"} (${user?.role ?? "no role"}).`}
    >
      <div className="w-full max-w-5xl space-y-6">
        <section className="space-y-4 rounded-lg border border-line bg-surface p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-medium">System status</h2>
            <ApiStatusBadge isReachable={isReachable} />
          </div>

          <dl className="grid gap-2 text-sm">
            <div className="flex justify-between border-t border-line pt-2">
              <dt className="text-content-secondary">API base URL</dt>
              <dd className="font-mono">{API_BASE_URL}</dd>
            </div>
            <div className="flex justify-between border-t border-line pt-2">
              <dt className="text-content-secondary">API version</dt>
              <dd className="font-mono">{serviceVersion ?? "unknown"}</dd>
            </div>
            <div className="flex justify-between border-t border-line pt-2">
              <dt className="text-content-secondary">Database</dt>
              <dd className="font-mono">
                {databaseLatencyMs !== null
                  ? `reachable (${databaseLatencyMs} ms)`
                  : (databaseErrorMessage ?? "not checked")}
              </dd>
            </div>
            <div className="flex justify-between border-t border-line pt-2">
              <dt className="text-content-secondary">Last checked</dt>
              <dd className="font-mono">{lastCheckedAt?.toLocaleTimeString() ?? "—"}</dd>
            </div>
          </dl>
        </section>

        <p className="text-xs text-content-secondary">
          All data access goes through the Fastify API. The renderer never opens a database connection
          of its own.
        </p>
      </div>
    </AppShell>
  );
}
