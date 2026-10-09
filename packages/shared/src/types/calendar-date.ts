// A calendar date in the office's local timezone, e.g. "2025-01-24".
//
// The shape check alone is NOT enough. "2026-02-30" matches ^\d{4}-\d{2}-\d{2}$
// but is not a day the calendar contains: a caller who supplies it would either
// crash the report with a RangeError from `toISOString()` or, worse, see it
// silently roll forward to 2 March and be reported under a date they never asked
// for. This schema refuses a date the calendar does not contain, so a caller
// mistake is always a readable 400 before any query runs.
//
// It is one shared schema on purpose: every request that carries a calendar day
// (a report filter, a collection date, an "as of" day) must answer a bad date the
// same way, and three copies of the regex is how one of them drifts.

import { z } from "zod";

/** True when a YYYY-MM-DD string names a day that actually exists. */
export function isRealCalendarDate(value: string): boolean {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }

  // Anchored to UTC midnight so the round trip reads only the fields the input
  // named, and cannot depend on the machine's timezone.
  const asDate = new Date(Date.UTC(year, month - 1, day));
  return (
    asDate.getUTCFullYear() === year &&
    asDate.getUTCMonth() === month - 1 &&
    asDate.getUTCDate() === day
  );
}

/**
 * A calendar day, validated for both shape and existence.
 *
 * A malformed value ("24-01-2025") reports the shape error; a well-formed but
 * impossible value ("2026-02-30") reports that the date does not exist.
 */
export const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "A date is required in YYYY-MM-DD format")
  .refine(isRealCalendarDate, "That calendar date does not exist");
