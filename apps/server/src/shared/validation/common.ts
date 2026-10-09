// Reusable server-side validators that more than one schema needs.
//
// These are the patterns the specification calls out explicitly (Phase 9 §3).
// They live on the server because a value that reaches a handler must be shaped
// correctly even if a client sends it directly and skips the UI.

import { z } from "zod";

import { calendarDateSchema } from "@bcis/shared";

/**
 * A monetary amount in integer centavos that must be greater than zero.
 * Guards against the float and zero-value mistakes the spec calls out.
 */
export const positiveAmountCentavos = z
  .number()
  .int("Amount must be a whole number (centavos)")
  .positive("Amount must be greater than zero");

/** A monetary amount in integer centavos that may be zero (a fee that is waived). */
export const nonNegativeAmountCentavos = z
  .number()
  .int("Amount must be a whole number (centavos)")
  .nonnegative("Amount cannot be negative");

/** A Philippine mobile number in local or +63 format: 09XXXXXXXXX or +639XXXXXXXXX. */
export const philippinePhone = z
  .string()
  .regex(/^(09|\+639)\d{9}$/, "Must be a valid Philippine mobile number (09XXXXXXXXX)");

/** A GCash reference number: exactly 13 digits. */
export const gcashReferenceNumber = z
  .string()
  .regex(/^\d{13}$/, "GCash reference number must be 13 digits");

/**
 * A calendar date in YYYY-MM-DD form.
 *
 * Shape AND existence: an impossible day such as "2026-02-30" is refused, so it
 * can never reach a `new Date(...)` that would shift it to another day (D1).
 */
export const isoDateString = calendarDateSchema;
