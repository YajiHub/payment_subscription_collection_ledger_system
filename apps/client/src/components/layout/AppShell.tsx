import { useEffect, type ReactNode } from "react";

import { getRoleLabel } from "@bcis/shared";
import { ApiStatusBadge } from "../ApiStatusBadge";
import { AppNavigation } from "../AppNavigation";
import { DisplayScaleControl } from "./DisplayScaleControl";
import { PreviewActivityNotice } from "./PreviewActivityNotice";
import { useApiHealth } from "../../hooks/useApiHealth";
import { useApiStatusStore } from "../../stores/api-status.store";
import { useAuthStore } from "../../stores/auth.store";
import { useDisplayScaleStore } from "../../stores/display-scale.store";

export interface AppShellProps {
  /** The screen's name, rendered as the page heading. */
  pageTitle: string;
  pageDescription?: string;
  /** Buttons the heading row carries, e.g. "Print / Preview" or a status badge. */
  headerActions?: ReactNode;
  children: ReactNode;
}

/**
 * The unified desktop frame for signed-in screens.
 *
 * Implements an executive enterprise ISP platform layout:
 * - Left Desktop Sidebar: Deep Navy gradient brand column with system ID, Section 4.2 navigation tree, and active user badge.
 * - Top Desktop Header: Context breadcrumbs, interactive Display Scale Controller, and live API status.
 * - Main Viewport: Clean, expansive responsive canvas that gracefully expands on widescreen and fullscreen monitors.
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

  // Global desktop keyboard shortcuts for instant display zoom scaling (Ctrl + / Ctrl - / Ctrl 0)
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.ctrlKey || event.metaKey) {
        if (event.key === "+" || event.key === "=") {
          event.preventDefault();
          useDisplayScaleStore.getState().zoomIn();
        } else if (event.key === "-" || event.key === "_") {
          event.preventDefault();
          useDisplayScaleStore.getState().zoomOut();
        } else if (event.key === "0") {
          event.preventDefault();
          useDisplayScaleStore.getState().resetZoom();
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const initials = user?.fullName
    ? user.fullName
        .split(" ")
        .filter(Boolean)
        .map((n) => n[0])
        .slice(0, 2)
        .join("")
        .toUpperCase()
    : "U";

  return (
    <div className="min-h-screen bg-canvas text-content-primary flex flex-row">
      {/*
       * Print (S7-7): the brand bar, the menu and the API-status badge belong to
       * the application, not to the document being printed, so the whole sidebar
       * is removed on paper. The page heading stays.
       */}
      <aside className="w-64 xl:w-70 shrink-0 bg-gradient-to-b from-[#091b33] via-[#0d223f] to-[#071426] text-surface flex flex-col justify-between border-r border-navy-strong shadow-xl print:hidden h-screen sticky top-0 z-20">
        {/* Tier 1: Brand & System Header */}
        <div className="p-4 border-b border-white/[0.08] flex items-center justify-between gap-2.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-tr from-accent to-blue-500 text-sm font-extrabold tracking-wider text-surface shadow-md shadow-accent/25">
              BC
            </div>
            <div className="leading-tight min-w-0">
              <span className="block text-xs font-bold tracking-wider text-surface uppercase truncate">
                BCIS Billing
              </span>
              <span className="block text-[10px] font-normal text-slate-300 truncate">
                Bukidnon Cable &amp; Internet
              </span>
            </div>
          </div>
        </div>

        {/* Tier 2: Scrollable Navigation Menu */}
        <div className="flex-1 overflow-y-auto px-3 py-3">
          <AppNavigation />
        </div>

        {/* Tier 3: User Identity Badge */}
        {user !== null && (
          <div className="p-3 border-t border-white/[0.08] bg-black/20">
            <div className="flex items-center gap-2.5 rounded-xl p-2.5 bg-white/[0.06] border border-white/[0.1] shadow-inner backdrop-blur-xs">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-tr from-accent to-blue-500 text-xs font-bold text-white shadow-xs">
                {initials}
              </div>
              <div className="min-w-0 flex-1 leading-tight">
                <p className="truncate text-xs font-semibold text-slate-100">{user.fullName}</p>
                <span className="inline-block mt-0.5 rounded border border-slate-600/80 bg-slate-800/90 px-1.5 py-0.5 text-[9px] font-bold tracking-wider text-slate-300 uppercase">
                  {getRoleLabel(user.role)}
                </span>
              </div>
            </div>
          </div>
        )}
      </aside>

      {/* Main Content Viewport */}
      <div className="flex-1 min-w-0 flex flex-col h-screen overflow-y-auto print:h-auto print:overflow-visible">
        {/* Top Desktop Utility Header Bar */}
        <header className="sticky top-0 z-10 border-b border-line/80 bg-surface/90 backdrop-blur-md px-6 lg:px-8 py-3 flex items-center justify-between gap-4 print:hidden shadow-2xs">
          <div className="flex items-center gap-2 text-xs text-content-secondary min-w-0">
            <span className="font-semibold text-content-primary">BCIS Enterprise</span>
            <span className="text-content-secondary/60">·</span>
            <span className="text-content-secondary font-medium truncate">Billing &amp; Collection Ledger</span>
          </div>

          <div className="flex items-center gap-3">
            <DisplayScaleControl />
            <ApiStatusBadge isReachable={isReachable} />
          </div>
        </header>

        {/* Expansive Content Container */}
        <main className="flex-1 max-w-[1760px] w-full mx-auto space-y-6 px-6 lg:px-8 xl:px-10 py-6 lg:py-8 print:p-0 print:max-w-none">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line/80 pb-5">
            <div className="space-y-1">
              <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-content-primary">{pageTitle}</h1>
              {pageDescription !== undefined && (
                <p className="text-sm sm:text-base text-content-secondary max-w-4xl">{pageDescription}</p>
              )}
            </div>

            {headerActions !== undefined && (
              <div className="flex flex-wrap items-center gap-3 print:hidden">{headerActions}</div>
            )}
          </div>

          {children}
        </main>
      </div>

      {/* Explains why the main window is unresponsive while a receipt or report
          preview is open in its own modal window. */}
      <PreviewActivityNotice />
    </div>
  );
}
