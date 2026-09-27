import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";

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
      { label: "Billing Runs", to: "/billing", permissions: ["invoices:read"] },
      { label: "Invoices", to: "/invoices", permissions: ["invoices:read"] },
      { label: "Subscription Plans", to: "/plans", permissions: ["plans:read"] },
    ],
  },
  {
    label: "Payments",
    links: [
      { label: "Post Payment", to: "/payments/new", permissions: ["payments:post"] },
      { label: "Payment Ledger", to: "/payments", permissions: ["payments:read"] },
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

/** The heading of a section whose own screen is the link. */
const LANDING_LINK_CLASS = "block font-semibold text-navy underline underline-offset-4";

/** Every other link in the menu. */
const LINK_CLASS =
  "text-content-primary underline underline-offset-4 transition-colors hover:text-navy";

/**
 * The single navigation menu for signed-in users, grouped into the top-level
 * sections of section 4.2 and filtered by role.
 *
 * It is rendered by the app shell, the home page and the management dashboard.
 * That matters: the Administrator and the Manager are redirected to the dashboard
 * straight after login, so if the dashboard did not carry the menu they would have
 * no way to reach User Management, the audit trail, or settings at all.
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

  /**
   * S5-4: lock deliberately, before walking away from the counter.
   *
   * There is no navigation here on purpose: the lock gate replaces the screen, and
   * the route the operator left is the one they come back to once the password is
   * verified again.
   */
  function handleLock(): void {
    lockWorkstation();
  }

  function mayUse(permissions: readonly Permission[]): boolean {
    return (
      user !== null && permissions.some((permission) => roleHasPermission(user.role, permission))
    );
  }

  // A section disappears when neither its own screen nor any of its links is
  // allowed, so a role never sees a heading it cannot act on.
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
      className="flex flex-wrap items-start justify-end gap-x-6 gap-y-3 print:hidden"
    >
      {visibleSections.map((section) => (
        <div key={section.label} className="space-y-1.5">
          {section.landing === undefined ? (
            <p className="text-xs font-semibold tracking-wide text-content-secondary uppercase">
              {section.label}
            </p>
          ) : (
            <Link to={section.landing.to} className={LANDING_LINK_CLASS}>
              {section.label}
            </Link>
          )}

          {section.links.length > 0 && (
            <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm font-medium">
              {section.links.map((link) => (
                <li key={link.to}>
                  <Link to={link.to} className={LINK_CLASS}>
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}

      <button
        type="button"
        onClick={handleLock}
        className="text-sm font-medium text-navy underline underline-offset-4"
      >
        Lock
      </button>

      <button
        type="button"
        onClick={() => void handleLogout()}
        className="text-sm font-medium text-danger-strong underline underline-offset-4"
      >
        Log out
      </button>
    </nav>
  );
}
