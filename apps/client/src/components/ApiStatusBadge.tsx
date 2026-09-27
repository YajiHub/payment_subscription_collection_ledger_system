import type { ReactNode } from "react";

import { getApiBaseUrl } from "../lib/api-client";

interface ApiStatusBadgeProps {
  /** True once the API answered its health probe; false while it is unreachable. */
  isReachable: boolean;
}

/** Coloured dot plus label: green when the API answered, red when it did not. */
export function ApiStatusBadge({ isReachable }: ApiStatusBadgeProps): ReactNode {
  const badgeClasses = isReachable
    ? "bg-success-soft text-success-strong border-success-line"
    : "bg-danger-soft text-danger-strong border-danger-line";

  const dotClasses = isReachable ? "bg-success" : "bg-danger";

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm font-medium ${badgeClasses}`}
      // Which server this copy is pointed at — the first thing to check when a
      // client PC cannot reach the API.
      title={`API server: ${getApiBaseUrl()}`}
    >
      <span className={`h-2.5 w-2.5 rounded-full ${dotClasses}`} aria-hidden="true" />
      {isReachable ? "API reachable" : "API offline"}
    </span>
  );
}