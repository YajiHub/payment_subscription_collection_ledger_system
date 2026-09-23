// Billing defaults shared by the client and the server.
//
// Every amount here is an integer number of centavos (see types/money.ts).

/**
 * The late fee charged once per overdue invoice.
 *
 * Phase 9 makes this configurable through system settings; until then the billing
 * job and the late-fee job both read this value so the shown default and the
 * charged default can never disagree.
 *
 * PHP 50.00 = 5000 centavos.
 */
export const DEFAULT_LATE_FEE_CENTAVOS = 5000;

/** The day of the following month on which a monthly invoice falls due. */
export const MONTHLY_INVOICE_DUE_DAY = 15;

/**
 * Month names indexed by the 1–12 month number.
 * Index 0 is an empty string so `MONTH_NAMES[1]` reads as "January".
 */
export const MONTH_NAMES = [
  "",
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** Turns a 1–12 month number into its English name, e.g. `getMonthName(1) === "January"`. */
export function getMonthName(month: number): string {
  return MONTH_NAMES[month] ?? "";
}

/** A human label for a billing period, e.g. `"January 2025"`. */
export function getMonthYearLabel(month: number, year: number): string {
  const monthName = getMonthName(month);
  return monthName === "" ? String(year) : `${monthName} ${year}`;
}
