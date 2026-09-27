import type { ReactNode } from "react";
import { Button } from "./Button";

export interface EmptyStateProps {
  title: string;
  description?: string;
  /** An optional icon, already sized by the caller (usually `h-6 w-6`). */
  icon?: ReactNode;
  /** The recovery the operator can take, e.g. "Clear filters". */
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
}

/**
 * The "no rows" state.
 *
 * It always names what is missing and, when a way out exists, offers it — an
 * empty table is never allowed to stand in for a real answer.
 */
export function EmptyState({
  title,
  description,
  icon,
  actionLabel,
  onAction,
  className = "",
}: EmptyStateProps): ReactNode {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 px-6 py-12 text-center ${className}`}
    >
      {icon !== undefined && <div className="text-content-secondary">{icon}</div>}

      <div className="space-y-1">
        <h2 className="text-base font-medium text-content-primary">{title}</h2>
        {description !== undefined && (
          <p className="mx-auto max-w-md text-sm text-content-secondary">{description}</p>
        )}
      </div>

      {actionLabel !== undefined && (
        <Button variant="outline" size="sm" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
