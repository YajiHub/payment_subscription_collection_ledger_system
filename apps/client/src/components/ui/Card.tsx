import type { ReactNode } from "react";

export interface CardProps {
  className?: string;
  children: ReactNode;
}

export interface CardSectionProps {
  className?: string;
  children: ReactNode;
}

/**
 * Body padding. Tailwind emits `p-4` before `p-6`, so a caller cannot override
 * the default through `className` class order; the padding is therefore its own
 * prop. `md` matches the default card body, `sm` is the dense KPI-strip size,
 * and `none` leaves all padding to the caller's own classes.
 */
export type CardPadding = "none" | "sm" | "md";

const CARD_PADDING_CLASSES: Record<CardPadding, string> = {
  none: "",
  sm: "p-4",
  md: "p-6",
};

export interface CardContentProps {
  className?: string;
  padding?: CardPadding;
  children: ReactNode;
}

/**
 * The surface every panel sits on.
 *
 * `overflow-hidden` is deliberate: it clips table headers and images to the
 * rounded corners instead of letting them square the card off.
 */
export function Card({ className = "", children }: CardProps): ReactNode {
  return (
    <div
      className={`overflow-hidden rounded-xl border border-line bg-surface shadow-sm ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * The heading strip of a card: a title, usually with a description beside it.
 *
 * The column direction is a default the caller can override with `flex-row`:
 * Tailwind emits `flex-col` before `flex-row`, so `flex-row items-center` on a
 * header puts its title and trailing badge on one line.
 */
export function CardHeader({ className = "", children }: CardSectionProps): ReactNode {
  return (
    <div
      className={`flex flex-col justify-between gap-2 border-b border-line px-6 py-4 ${className}`}
    >
      {children}
    </div>
  );
}

export function CardTitle({ className = "", children }: CardSectionProps): ReactNode {
  return <h2 className={`text-base font-medium text-content-primary ${className}`}>{children}</h2>;
}

export function CardDescription({ className = "", children }: CardSectionProps): ReactNode {
  return <p className={`text-sm text-content-secondary ${className}`}>{children}</p>;
}

/**
 * The body of a card. `padding` selects the body padding explicitly; a dense
 * six-across KPI strip asks for `padding="sm"` (p-4) instead of the default p-6.
 */
export function CardContent({
  className = "",
  padding = "md",
  children,
}: CardContentProps): ReactNode {
  return (
    <div className={`${CARD_PADDING_CLASSES[padding]} ${className}`.trim()}>{children}</div>
  );
}
