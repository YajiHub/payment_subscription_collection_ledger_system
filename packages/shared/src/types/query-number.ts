// Numbers read from a query string.
//
// Every value in a query string arrives as text, so a query-parameter number has
// always been coerced. `z.coerce.number()` alone turns an absent or non-numeric
// string into NaN, and Zod then reports the unreadable "Expected number, received
// nan" without naming the field. `queryNumber` coerces valid text the same way but
// reports which field failed and whether it was missing or not a number, so a 400
// tells the caller what to fix.
//
// POST body schemas deliberately use a plain, non-coercing `z.number()`: a body is
// already typed JSON, so its "Required" message is correct and must not change.

import { z } from "zod";

/**
 * A number read from a query string.
 *
 * `fieldLabel` names the parameter in the error message ("year is required" /
 * "year must be a number"). `build` narrows the number (e.g. `.int().min(1)`) and
 * defaults to an integer. Attach `.optional()` or `.default(...)` as usual.
 */
export function queryNumber(
  fieldLabel: string,
  build: (schema: z.ZodNumber) => z.ZodNumber = (schema) => schema.int()
) {
  const numberSchema = build(
    z.number({
      required_error: `${fieldLabel} is required`,
      invalid_type_error: `${fieldLabel} must be a number`,
    })
  );

  return z.preprocess((value) => {
    // An omitted or empty parameter is "missing", not "not a number".
    if (value === undefined || value === null || value === "") {
      return undefined;
    }
    const parsed = typeof value === "number" ? value : Number(value);
    // NaN and Infinity both mean "this text is not a number".
    return Number.isFinite(parsed) ? parsed : NaN;
  }, numberSchema);
}
