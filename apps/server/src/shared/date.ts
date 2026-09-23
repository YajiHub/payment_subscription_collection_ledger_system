// Business dates (activation, suspension, termination) are calendar days in the
// office's local timezone, not UTC instants.
//
// `toISOString()` would shift an early-morning Philippine date back one day, which
// would put a suspension on the wrong side of a billing period. These helpers read
// the local calendar fields instead.

/** Formats a Date as YYYY-MM-DD using the machine's local calendar day. */
export function formatDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
