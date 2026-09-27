import type { MouseEventHandler, ReactNode } from "react";
import { Loader2 } from "lucide-react";

/** The visual weight of a button. `primary` is the default action on a screen. */
export type ButtonVariant = "primary" | "secondary" | "outline" | "danger" | "link";

/** `md` is the standard control height (h-9), `sm` fits inside table rows. */
export type ButtonSize = "sm" | "md";

export interface ButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  type?: "submit" | "button" | "reset";
  disabled?: boolean;
  /** Shows a spinner and blocks clicks while the button's action is in flight. */
  isLoading?: boolean;
  leftIcon?: ReactNode;
  /** Tooltip text, used to explain why a button is disabled. */
  title?: string;
  className?: string;
  children: ReactNode;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-navy text-surface hover:bg-navy-strong",
  secondary: "bg-canvas text-content-primary hover:bg-line",
  outline: "border border-line-strong bg-surface text-content-primary hover:bg-canvas",
  danger: "bg-danger text-surface hover:bg-danger-strong",
  link: "text-content-primary underline underline-offset-4 hover:text-navy",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 px-3 text-xs",
  md: "h-9 gap-2 px-4 text-sm",
};

/**
 * The single button primitive.
 *
 * The type defaults to `button`, not the HTML default of `submit`: a stray
 * button inside a form must not submit it by accident.
 */
export function Button({
  variant = "primary",
  size = "md",
  onClick,
  type = "button",
  disabled = false,
  isLoading = false,
  leftIcon,
  title,
  className = "",
  children,
}: ButtonProps): ReactNode {
  const isDisabled = disabled || isLoading;

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={isDisabled}
      title={title}
      aria-busy={isLoading || undefined}
      className={`inline-flex items-center justify-center whitespace-nowrap rounded-lg font-medium transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${SIZE_CLASSES[size]} ${VARIANT_CLASSES[variant]} ${className}`}
    >
      {isLoading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : leftIcon}
      {children}
    </button>
  );
}
