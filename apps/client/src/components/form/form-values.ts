// Small value helpers shared by every form.
//
// They exist because a browser input has no way to say "absent": an empty text
// box and a blank optional field both arrive as `""`. The shared Zod schemas
// describe what the API accepts, and an optional text field there is *absent*,
// not empty (`z.string().email().optional()` rejects `""`). These helpers make
// the empty box look absent to the schema and keep the key out of the request
// body, which is exactly what every one of these screens sent before.

/**
 * Reads an empty text input as `undefined`.
 *
 * Used as React Hook Form's `setValueAs` so an optional field that the clerk left
 * blank is validated (and sent) as missing rather than as an invalid empty value.
 */
export function blankToUndefined(value: string): string | undefined {
  return value === "" ? undefined : value;
}

/** Drops a value that is empty after the schema has trimmed it. */
export function normalizeOptionalText(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}
