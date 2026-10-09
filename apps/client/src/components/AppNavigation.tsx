import type { ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { roleHasPermission, type Permission } from "@bcis/shared";
import { logout as requestServerLogout } from "../lib/api-client";
import { lockWorkstation } from "../lib/session-lock";
import { useAuthStore } from "../stores/auth.store";

/**
 * One screen inside a section.
 *
 * `permissions` is the set the screen accepts — an entry with two names is reached
 * by either job, the way the backup screen is reached by whoever may produce an
 * archive or by whoever may restore one.
 */
interface NavigationLink {
  label: string;
  to: string;
  permissions: readonly Permission[];
}

/**
 * A top-level section of the menu (section 4.2).
 *
 * `landing` is the section's own screen: when a section has one, its heading is
 * itself the link (so "Subscribers" is a destination, not a dead label). A
 * section without one groups its screens under a plain heading.
 */
interface NavigationSection {
  label: string;
  landing?: { to: string; permissions: readonly Permission[] };
  links: NavigationLink[];
}

/**
 * The menu, in the order section 4.2 requires: Dashboard first, then Subscribers,
 * Billing, Payments, Collections, Receivables, Services, Reports and
 * Administration.
 *
 * Each entry names the permission the server requires for its route, so the menu
 * and the API agree by construction. Hiding a link is a convenience only: the
 * server re-checks the permission on every request.
 *
 * Two screens cannot be linked from here because they need an account id in the
 * route: the account ledger (`/service-accounts/:id/ledger`) and the statement of
 * account. They are reached from a service account's row on the Service Accounts
 * screen and the subscriber directory, which is why that screen links to both.
 */
const NAVIGATION_SECTIONS: ReadonlyArray<NavigationSection> = [
  {
    label: "Dashboard",
    landing: { to: "/dashboard", permissions: ["reports:management_view"] },
    links: [],
  },
  {
    label: "Subscribers",
    landing: { to: "/subscribers", permissions: ["subscribers:read"] },
    links: [
      {
        label: "Add Subscriber",
        to: "/subscribers/new",
        permissions: ["subscribers:create"],
      },
    ],
  },
  {
    label: "Billing",
    landing: undefined,
    links: [
      { label: "Billing Runs", to: "/billing", permissions: ["invoices:generate"] },
      { label: "Invoices", to: "/invoices", permissions: ["invoices:read"] },
      { label: "Subscription Plans", to: "/plans", permissions: ["plans:read"] },
    ],
  },
  {
    label: "Payments",
    links: [
      { label: "Post Payment", to: "/payments/new", permissions: ["payments:post"] },
      { label: "Payment Ledger", to: "/payments", permissions: ["payments:read"] },
      // S7-6: the verifier's worklist. It opens for whoever may confirm a claim;
      // the reject control inside is offered only to the reject permission.
      {
        label: "GCash Verification",
        to: "/payments/gcash",
        permissions: ["payments:verify_gcash"],
      },
    ],
  },
  {
    label: "Collections",
    links: [
      {
        label: "Collector Batches",
        to: "/collector-batches",
        permissions: ["collector_batches:read"],
      },
    ],
  },
  {
    label: "Receivables",
    links: [
      {
        label: "AR Aging Analysis",
        to: "/receivables/aging",
        permissions: ["reports:view"],
      },
      {
        label: "Overdue Accounts",
        to: "/receivables/overdue",
        permissions: ["reports:view"],
      },
    ],
  },
  {
    label: "Services",
    links: [
      // S4-9: the Services section has its own screens rather than aliasing the
      // subscriber directory and the overdue list. The Service Accounts screen
      // lists every account and links to its ledger; the suspension screen keeps
      // the threshold preview and the run apart.
      {
        label: "Service Accounts",
        to: "/services/accounts",
        permissions: ["subscribers:read"],
      },
      {
        label: "Suspension & Reconnection",
        to: "/services/suspension",
        permissions: ["subscribers:read"],
      },
    ],
  },
  {
    label: "Reports",
    links: [{ label: "Reports Center", to: "/reports", permissions: ["reports:view"] }],
  },
  {
    label: "Administration",
    links: [
      { label: "User Management", to: "/users", permissions: ["users:read"] },
      { label: "Audit Trail", to: "/audit-logs", permissions: ["audit:read"] },
      { label: "System Settings", to: "/settings", permissions: ["system:settings"] },
      // S5-3: the backup and restore screen. Either permission opens it; each
      // control inside is offered only to the permission that may use it.
      {
        label: "Backup & Restore",
        to: "/administration/backups",
        permissions: ["backup:create", "backup:restore"],
      },
    ],
  },
];

export function isRouteActive(targetPath: string, currentPath: string): boolean {
  // Normalize paths by stripping query parameters, hash fragments, and trailing slashes
  const currentClean = currentPath.split("?")[0]?.split("#")[0] ?? "";
  const targetClean = targetPath.split("?")[0]?.split("#")[0] ?? "";
  const normCurrent = currentClean.replace(/\/+$/, "") || "/";
  const normTarget = targetClean.replace(/\/+$/, "") || "/";

  // Exact match is always active
  if (normCurrent === normTarget) return true;

  // Specific sibling overrides to prevent parent/sibling collision:
  if (normTarget === "/payments") {
    // "/payments/new" (Post Payment) and "/payments/gcash" (GCash Verification) have their own tabs
    if (
      normCurrent === "/payments/new" ||
      normCurrent.startsWith("/payments/new/") ||
      normCurrent === "/payments/gcash" ||
      normCurrent.startsWith("/payments/gcash/")
    ) {
      return false;
    }
    return normCurrent === "/payments" || normCurrent.startsWith("/payments/");
  }

  if (normTarget === "/subscribers") {
    // "/subscribers/new" (Add Subscriber) has its own tab
    if (
      normCurrent === "/subscribers/new" ||
      normCurrent.startsWith("/subscribers/new/")
    ) {
      return false;
    }
    return normCurrent === "/subscribers" || normCurrent.startsWith("/subscribers/");
  }

  if (normTarget === "/dashboard") {
    return normCurrent === "/dashboard";
  }

  if (normTarget === "/services/accounts") {
    // Account ledger and statement of account live at /service-accounts/:id/...
    return (
      normCurrent === "/services/accounts" ||
      normCurrent.startsWith("/services/accounts/") ||
      normCurrent.startsWith("/service-accounts/")
    );
  }

  // General sub-route match (e.g. /invoices/:id for /invoices, /collector-batches/:id for /collector-batches)
  return normTarget !== "/" && normCurrent.startsWith(`${normTarget}/`);
}

function getLandingClass(isActive: boolean): string {
  return `flex items-center px-3.5 py-2 rounded-xl text-xs sm:text-sm font-semibold tracking-wide transition-all duration-150 ${
    isActive
      ? "bg-gradient-to-r from-accent to-blue-600 text-white shadow-sm shadow-accent/40 ring-1 ring-accent-strong/40"
      : "text-slate-200 hover:bg-white/[0.08] hover:text-white"
  }`;
}

function getLinkClass(isActive: boolean): string {
  return `flex items-center px-3.5 py-1.5 sm:py-2 rounded-xl text-xs sm:text-sm font-medium transition-all duration-150 ${
    isActive
      ? "bg-accent text-white font-semibold shadow-xs ring-1 ring-accent-strong/40"
      : "text-slate-300 hover:bg-white/[0.08] hover:text-white"
  }`;
}

/**
 * The single navigation menu for signed-in users, grouped into the top-level
 * sections of section 4.2 and filtered by role.
 *
 * Rendered by AppShell inside the executive desktop sidebar.
 */
export function AppNavigation(): ReactNode {
  const navigate = useNavigate();
  const location = useLocation();
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

  /**
   * S5-4: lock deliberately, before walking away from the counter.
   */
  function handleLock(): void {
    lockWorkstation();
  }

  function mayUse(permissions: readonly Permission[]): boolean {
    return (
      user !== null && permissions.some((permission) => roleHasPermission(user.role, permission))
    );
  }

  const visibleSections = NAVIGATION_SECTIONS.map((section) => ({
    ...section,
    landing:
      section.landing !== undefined && mayUse(section.landing.permissions)
        ? section.landing
        : undefined,
    links: section.links.filter((link) => mayUse(link.permissions)),
  })).filter((section) => section.landing !== undefined || section.links.length > 0);

  return (
    <nav
      aria-label="Main navigation"
      className="flex flex-col gap-1.5 print:hidden select-none"
    >
      {visibleSections.map((section) => (
        <div
          key={section.label}
          className="flex flex-col gap-0.5"
        >
          {section.landing === undefined ? (
            <p className="px-3.5 pt-3 pb-1 text-[11px] font-bold tracking-wider text-slate-400/90 uppercase">
              {section.label}
            </p>
          ) : (
            <Link
              to={section.landing.to}
              aria-current={isRouteActive(section.landing.to, location.pathname) ? "page" : undefined}
              className={getLandingClass(isRouteActive(section.landing.to, location.pathname))}
            >
              {section.label}
            </Link>
          )}

          {section.links.length > 0 && (
            <ul
              className={`m-0 p-0 list-none space-y-0.5 ${
                section.landing !== undefined ? "mt-1 ml-2.5 pl-2.5 border-l border-slate-700/60" : ""
              }`}
            >
              {section.links.map((link) => {
                const isActive = isRouteActive(link.to, location.pathname);
                return (
                  <li key={link.to}>
                    <Link
                      to={link.to}
                      aria-current={isActive ? "page" : undefined}
                      className={getLinkClass(isActive)}
                    >
                      {link.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ))}

      <hr className="my-2 border-slate-700/60" />

      {user !== null && (
        <button
          type="button"
          onClick={handleLock}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-slate-700/80 bg-slate-800/80 px-3 py-2.5 text-xs sm:text-sm font-semibold text-slate-200 hover:bg-slate-700 hover:text-white transition-all shadow-xs active:scale-[0.98]"
        >
          Lock
        </button>
      )}

      <button
        type="button"
        onClick={() => void handleLogout()}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-red-500/30 bg-red-950/30 px-3 py-2.5 text-xs sm:text-sm font-semibold text-red-300 hover:bg-red-900/40 hover:text-red-100 transition-all shadow-xs active:scale-[0.98]"
      >
        Log out
      </button>
    </nav>
  );
}
