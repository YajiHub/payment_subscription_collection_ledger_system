import type { ReactNode } from "react";

/**
 * The tone of a badge. Every tone is a background *and* a text colour, so the
 * status stays readable for a colour-blind operator and in a black-and-white
 * print of the screen (spec S0-3: never colour alone).
 */
export type BadgeVariant = "neutral" | "info" | "warning" | "success" | "danger";

export type BadgeSize = "sm" | "md";

export interface BadgeProps {
  variant?: BadgeVariant;
  size?: BadgeSize;
  /** Adds a leading dot. Decorative only — the label carries the meaning. */
  dot?: boolean;
  className?: string;
  children: ReactNode;
}

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  neutral: "border-line bg-canvas text-content-primary",
  info: "border-accent-line bg-accent-soft text-accent-strong",
  warning: "border-warning-line bg-warning-soft text-warning-strong",
  success: "border-success-line bg-success-soft text-success-strong",
  danger: "border-danger-line bg-danger-soft text-danger-strong",
};

const DOT_CLASSES: Record<BadgeVariant, string> = {
  neutral: "bg-content-secondary",
  info: "bg-accent",
  warning: "bg-warning",
  success: "bg-success",
  danger: "bg-danger",
};

const SIZE_CLASSES: Record<BadgeSize, string> = {
  sm: "gap-1.5 px-2 py-0.5 text-xs",
  md: "gap-2 px-2.5 py-1 text-sm",
};

/** A status pill. The text is always rendered; the colour only supports it. */
export function Badge({
  variant = "neutral",
  size = "sm",
  dot = false,
  className = "",
  children,
}: BadgeProps): ReactNode {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full border font-medium ${SIZE_CLASSES[size]} ${VARIANT_CLASSES[variant]} ${className}`}
    >
      {dot && (
        <span className={`h-1.5 w-1.5 rounded-full ${DOT_CLASSES[variant]}`} aria-hidden="true" />
      )}
      {children}
    </span>
  );
}
