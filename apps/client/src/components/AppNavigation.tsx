import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";

import { roleHasPermission, type Permission } from "@bcis/shared";
import { logout as requestServerLogout } from "../lib/api-client";
import { useAuthStore } from "../stores/auth.store";

/**
 * Every screen a signed-in user may open, in menu order.
 *
 * Each entry names the permission the server requires for its route, so the
 * menu and the API agree by construction. Hiding a link is a convenience only:
 * the server re-checks the permission on every request.
 */
const NAVIGATION_LINKS: ReadonlyArray<{ label: string; to: string; permission: Permission }> = [
  { label: "Subscribers", to: "/subscribers", permission: "subscribers:read" },
  { label: "Plans", to: "/plans", permission: "plans:read" },
  { label: "Billing", to: "/billing", permission: "invoices:read" },
  { label: "Payments", to: "/payments", permission: "payments:read" },
  { label: "Post Payment", to: "/payments/new", permission: "payments:post" },
  { label: "Collector Batches", to: "/collector-batches", permission: "collector_batches:read" },
  { label: "Dashboard", to: "/dashboard", permission: "reports:view" },
  { label: "Reports Center", to: "/reports", permission: "reports:view" },
  { label: "AR Aging", to: "/receivables/aging", permission: "reports:view" },
  { label: "Overdue Accounts", to: "/receivables/overdue", permission: "reports:view" },
  { label: "User Management", to: "/users", permission: "users:read" },
  { label: "Audit Trail", to: "/audit-logs", permission: "audit:read" },
  { label: "System Settings", to: "/settings", permission: "system:settings" },
];

/**
 * The single navigation menu for signed-in users.
 *
 * It is rendered by both the home page and the management dashboard. That
 * matters: the Administrator and the Manager are redirected to the dashboard
 * straight after login, so if the dashboard did not carry the menu they would
 * have no way to reach User Management, the audit trail, or settings at all.
 */
export function AppNavigation(): ReactNode {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const clearSession = useAuthStore((state) => state.logout);

  async function handleLogout(): Promise<void> {
    try {
      await requestServerLogout();
    } catch {
      // Even if the server is unreachable, clear the local session so the user can leave.
    }
    clearSession();
    navigate("/login", { replace: true });
  }

  const visibleLinks =
    user === null ? [] : NAVIGATION_LINKS.filter((link) => roleHasPermission(user.role, link.permission));

  return (
    <nav className="flex flex-wrap items-center justify-end gap-3 text-sm font-medium">
      {visibleLinks.map((link) => (
        <Link key={link.to} to={link.to} className="text-slate-800 underline">
          {link.label}
        </Link>
      ))}
      <button type="button" onClick={() => void handleLogout()} className="text-red-700 underline">
        Log out
      </button>
    </nav>
  );
}