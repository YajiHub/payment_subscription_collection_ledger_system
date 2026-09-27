import type { ReactNode } from "react";
import { ShieldAlert } from "lucide-react";
import { AppShell } from "../components/layout/AppShell";
import { EmptyState } from "../components/ui/EmptyState";

/** Shown when an authenticated user reaches a page their role may not use. */
export function UnauthorizedPage(): ReactNode {
  return (
    <AppShell pageTitle="Access denied">
      <EmptyState
        icon={<ShieldAlert className="h-6 w-6" />}
        title="Your role cannot view this page"
        description="The server denied this route for your role. Use the sidebar to open a screen you are permitted to use."
      />
    </AppShell>
  );
}