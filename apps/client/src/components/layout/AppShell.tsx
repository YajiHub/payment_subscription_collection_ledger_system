import type { ReactNode } from "react";

import { ApiStatusBadge } from "../ApiStatusBadge";
import { AppNavigation } from "../AppNavigation";
import { useApiHealth } from "../../hooks/useApiHealth";
import { useApiStatusStore } from "../../stores/api-status.store";
import { useAuthStore } from "../../stores/auth.store";

export interface AppShellProps {
  /** The screen's name, rendered as the page heading. */
  pageTitle: string;
  pageDescription?: string;
  /** Buttons the heading row carries, e.g. "Print / Preview" or a status badge. */
  headerActions?: ReactNode;
  children: ReactNode;
}

/**
 * The frame around every signed-in screen.
 *
 * The navigation menu lives here rather than in each page, so a screen can never
 * be shipped without a way to reach the others, and the API status affordance
 * travels with the frame instead of being repeated 18 times.
 */
export function AppShell({
  pageTitle,
  pageDescription,
  headerActions,
  children,
}: AppShellProps): ReactNode {
  // Keeps the status badge honest: the health probe runs wherever the frame is.
  useApiHealth();

  const user = useAuthStore((state) => state.user);
  const isReachable = useApiStatusStore((state) => state.isReachable);

  return (
    <div className="min-h-screen bg-canvas">
      {/*
       * Print (S7-7): the brand bar, the menu and the API-status badge belong to
       * the application, not to the document being printed, so the whole header
       * is removed on paper. The page heading below it stays.
       */}
      <header className="border-b border-line bg-surface print:hidden">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-8 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-semibold text-content-primary">
              BCIS Billing &amp; Collection
            </span>
            <ApiStatusBadge isReachable={isReachable} />
            {user !== null && (
              <span className="text-xs text-content-secondary">Signed in as {user.fullName}</span>
            )}
          </div>

          <AppNavigation />
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 p-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold text-content-primary">{pageTitle}</h1>
            {pageDescription !== undefined && (
              <p className="text-sm text-content-secondary">{pageDescription}</p>
            )}
          </div>

          {headerActions !== undefined && (
            <div className="flex flex-wrap items-center gap-3 print:hidden">{headerActions}</div>
          )}
        </div>

        {children}
      </main>
    </div>
  );
}
