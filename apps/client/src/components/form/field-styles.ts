// The one place a form field's look is written down.
//
// Every class here is an existing design token from `styles.css` (S7-1), so a
// field on the Add Subscriber screen cannot drift away from the same field on the
// Post Payment screen. The label and control sizes match the shared `Button`,
// which is `h-9 rounded-lg` at its standard size.

/** The control height, border and focus ring every text and select field shares. */
export const CONTROL_CLASS =
  "h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/** A textarea is the same control with a caller-chosen number of rows. */
export const TEXTAREA_CLASS =
  "w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/** The border an invalid control wears while its message sits underneath it. */
export const INVALID_CONTROL_CLASS = "border-danger-line";

/** A control with no value to show yet — an empty select, a spent date box. */
export const DISABLED_CONTROL_CLASS = "disabled:bg-canvas disabled:text-content-secondary";

export const LABEL_CLASS = "block text-xs font-medium text-content-secondary";
export const HINT_CLASS = "block text-xs text-content-secondary";
export const ERROR_CLASS = "block text-xs text-danger-strong";

/**
 * Builds the `aria-describedby` value for a control from the ids that are
 * actually on screen, in reading order. A control with neither a hint nor an
 * error describes nothing, so the attribute stays off rather than pointing at an
 * element that does not exist.
 */
export function describedBy(...ids: (string | undefined)[]): string | undefined {
  const present = ids.filter((id): id is string => id !== undefined);
  return present.length === 0 ? undefined : present.join(" ");
}
