import type { ReactNode } from "react";

import { getApiBaseUrl } from "../lib/api-client";

interface ApiStatusBadgeProps {
  /** True once the API answered its health probe; false while it is unreachable. */
  isReachable: boolean;
}

/** Coloured dot plus label: green when the API answered, red when it did not. */
export function ApiStatusBadge({ isReachable }: ApiStatusBadgeProps): ReactNode {
  const badgeClasses = isReachable
    ? "bg-emerald-500/10 text-emerald-700 border-emerald-500/30"
    : "bg-rose-500/10 text-rose-700 border-rose-500/30";

  const dotClasses = isReachable ? "bg-emerald-500" : "bg-rose-500";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold shadow-2xs transition-colors ${badgeClasses}`}
      title={`API server: ${getApiBaseUrl()}`}
    >
      <span className="relative flex h-2 w-2">
        {isReachable && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${dotClasses}`} aria-hidden="true" />
      </span>
      {isReachable ? "System Online" : "System Offline"}
    </span>
  );
}