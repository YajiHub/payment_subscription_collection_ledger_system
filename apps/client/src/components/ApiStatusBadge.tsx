import type { ReactNode } from "react";

interface ApiStatusBadgeProps {
  /** True once the API answered its health probe; false while it is unreachable. */
  isReachable: boolean;
}

/** Coloured dot plus label: green when the API answered, red when it did not. */
export function ApiStatusBadge({ isReachable }: ApiStatusBadgeProps): ReactNode {
  const badgeClasses = isReachable
    ? "bg-emerald-50 text-emerald-700 border-emerald-300"
    : "bg-red-50 text-red-700 border-red-300";

  const dotClasses = isReachable ? "bg-emerald-500" : "bg-red-500";

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm font-medium ${badgeClasses}`}
    >
      <span className={`h-2.5 w-2.5 rounded-full ${dotClasses}`} aria-hidden="true" />
      {isReachable ? "API reachable" : "API offline"}
    </span>
  );
}