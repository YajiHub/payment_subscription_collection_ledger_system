import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "./Button";

export interface ErrorBannerProps {
  message: string;
  onRetry?: () => void;
  className?: string;
}

/**
 * Inline failure state for a data region. Names the problem and offers recovery,
 * so an API failure never degrades into a blank or dead page.
 */
export function ErrorBanner({ message, onRetry, className = "" }: ErrorBannerProps): ReactNode {
  return (
    <div
      role="alert"
      className={`flex items-center justify-between gap-3 rounded-xl border border-danger-line bg-danger-soft px-4 py-3 ${className}`}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <AlertTriangle className="h-4 w-4 shrink-0 text-danger" />
        <p className="truncate text-sm text-danger-strong">{message}</p>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}