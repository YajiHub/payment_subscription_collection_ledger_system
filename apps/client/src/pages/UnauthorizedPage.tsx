import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/** Shown when an authenticated user reaches a page their role may not use. */
export function UnauthorizedPage(): ReactNode {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-100 p-8 text-center">
      <h1 className="text-2xl font-semibold">Access denied</h1>
      <p className="text-sm text-slate-600">
        Your role does not have permission to view this page.
      </p>
      <Link to="/" className="text-sm font-medium text-slate-800 underline">
        Return to the dashboard
      </Link>
    </main>
  );
}
