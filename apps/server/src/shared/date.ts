// Business dates (activation, suspension, termination) are calendar days in the
// office's local timezone, not UTC instants.
//
// `toISOString()` would shift an early-morning Philippine date back one day, which
// would put a suspension on the wrong side of a billing period. These helpers read
// the local calendar fields instead.
//
// Reports add two rules on top of that:
//   • A whole-day count (an aging bucket) is exact only when both ends sit at the
//     same time of day, so the day is anchored to UTC midnight with
//     `utcMidnightOfDay`. The AR aging service has always worked this way.
//   • A date range is expressed as inclusive start / exclusive end DAY STRINGS and
//     compared as text against the DATE columns, which removes any chance of an
//     off-by-one from a timezone conversion.

/** Formats a Date as YYYY-MM-DD using the machine's local calendar day. */
export function formatDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * The UTC instant of a calendar day's midnight, e.g. "2025-01-24" →
 * 2025-01-24T00:00:00Z.
 *
 * Used wherever a difference in WHOLE DAYS is what matters: an invoice due on the
 * 1st and a report run on the 31st is 30 days overdue no matter what hour of the
 * day the report was run. Both ends of the subtraction are anchored this way.
 */
export function utcMidnightOfDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** The calendar day `days` after `day`: ("2025-01-31", 1) → "2025-02-01". */
export function addDaysToDay(day: string, days: number): string {
  const shifted = new Date(utcMidnightOfDay(day).getTime() + days * MILLISECONDS_PER_DAY);
  return shifted.toISOString().slice(0, 10);
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Formats a Date as HH:MM:SS using the machine's local calendar fields.
 *
 * A report is read in the office, so a printed time is the office's wall-clock
 * time. `toISOString()` would print the same instant in UTC and show a payment
 * posted at 10:35 local as 02:35 — the wrong time on the wrong side of a
 * midnight boundary (D5).
 */
export function formatTimeOfDay(instant: Date): string {
  const hours = String(instant.getHours()).padStart(2, "0");
  const minutes = String(instant.getMinutes()).padStart(2, "0");
  const seconds = String(instant.getSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

/**
 * Formats a Date as "YYYY-MM-DD HH:MM:SS" in the office's local time.
 *
 * The local twin of `toISOString().slice(0, 19).replace("T", " ")`, used by the
 * audit reports whose rows carry a full instant rather than a business day.
 */
export function formatOfficeDateTime(instant: Date): string {
  return `${formatDateOnly(instant)} ${formatTimeOfDay(instant)}`;
}

/**
 * The local instant at the start of a calendar day: 00:00:00.000 local.
 *
 * Used for a period filter over an instant column (the ledger's `entry_date`),
 * so the range follows the office day rather than the UTC day (D6).
 */
export function startOfLocalDay(day: string): Date {
  return new Date(`${day}T00:00:00.000`);
}

/** The local instant at the last millisecond of a calendar day. */
export function endOfLocalDay(day: string): Date {
  return new Date(`${day}T23:59:59.999`);
}

/** A month, expressed so a SQL range can never be off by a day. */
export interface MonthWindow {
  year: number;
  month: number;
  /** The first day of the month, inclusive. */
  monthStart: string;
  /** The first day of the following month, exclusive. */
  nextMonthStart: string;
}

/**
 * The month containing a calendar day.
 *
 * The range is [monthStart, nextMonthStart) on purpose: an inclusive end day is
 * the classic place for an off-by-one, and an exclusive end cannot be one.
 */
export function monthWindowOfDay(day: string): MonthWindow {
  const year = Number.parseInt(day.slice(0, 4), 10);
  const month = Number.parseInt(day.slice(5, 7), 10);

  const isDecember = month === 12;
  const nextMonthYear = isDecember ? year + 1 : year;
  const nextMonth = isDecember ? 1 : month + 1;

  return {
    year,
    month,
    monthStart: `${year}-${String(month).padStart(2, "0")}-01`,
    nextMonthStart: `${nextMonthYear}-${String(nextMonth).padStart(2, "0")}-01`,
  };
}

/** True when a calendar day falls inside a month window (end exclusive). */
export function isDayInMonthWindow(day: string, window: MonthWindow): boolean {
  return day >= window.monthStart && day < window.nextMonthStart;
}
