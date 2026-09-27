import type { ReactNode } from "react";

/**
 * Placeholder block for loading states. Pure geometry — no text, no icons — so a
 * loading view reads as "data is arriving", not as a second empty state.
 */
export function Skeleton({ className = "" }: { className?: string }): ReactNode {
  return <div aria-hidden="true" className={`animate-pulse rounded-md bg-line/80 ${className}`} />;
}

/** A table-shaped loading skeleton: one row of cells per pending record. */
export function TableSkeleton({
  rows = 5,
  columns = 4,
  className = "",
}: {
  rows?: number;
  columns?: number;
  className?: string;
}): ReactNode {
  return (
    <div className={`space-y-3 p-6 ${className}`} aria-hidden="true">
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="flex items-center gap-4">
          {Array.from({ length: columns }).map((_, columnIndex) => (
            <Skeleton
              key={columnIndex}
              className={`h-4 flex-1 ${columnIndex === 0 ? "max-w-[220px]" : ""}`}
            />
          ))}
        </div>
      ))}
    </div>
  );
}