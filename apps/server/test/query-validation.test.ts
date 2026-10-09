// Query-string numbers must produce an actionable 400.
//
// Every query value arrives as text, so the schemas coerce it. `z.coerce.number()`
// alone coerced an absent or non-numeric string to NaN and Zod then reported the
// unreadable "Expected number, received nan" — naming no field, and not saying the
// value was missing. These tests pin the replacement messages and prove the POST
// body schemas (which are NOT coerced) keep their own "Required" wording.

import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  billingPeriodQuerySchema,
  listInvoicesQuerySchema,
  runBillingSchema,
} from "@bcis/shared";

import { parseOrThrow } from "../src/shared/validate";

/** The message the server would surface for `data`: the first Zod issue, via parseOrThrow. */
function validationMessage(schema: z.ZodTypeAny, data: unknown): string {
  try {
    parseOrThrow(schema, data);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the input to be rejected");
}

describe("query-string number validation", () => {
  it("names the missing field when a required query number is absent", () => {
    expect(validationMessage(billingPeriodQuerySchema, {})).toBe("year is required");
    expect(validationMessage(billingPeriodQuerySchema, { year: "2026" })).toBe(
      "month is required"
    );
    // An empty parameter is missing, not a silent zero.
    expect(validationMessage(billingPeriodQuerySchema, { year: "", month: "11" })).toBe(
      "year is required"
    );
  });

  it("names the field when a query number is not a number", () => {
    expect(validationMessage(billingPeriodQuerySchema, { year: "abc", month: "11" })).toBe(
      "year must be a number"
    );
    expect(validationMessage(billingPeriodQuerySchema, { year: "2026", month: "abc" })).toBe(
      "month must be a number"
    );
    expect(validationMessage(billingPeriodQuerySchema, { year: "Infinity", month: "11" })).toBe(
      "year must be a number"
    );
    expect(validationMessage(listInvoicesQuerySchema, { year: "abc" })).toBe(
      "year must be a number"
    );
  });

  it("still coerces valid text and keeps optional filters and defaults", () => {
    expect(parseOrThrow(billingPeriodQuerySchema, { year: "2026", month: "11" })).toEqual({
      year: 2026,
      month: 11,
    });
    expect(parseOrThrow(listInvoicesQuerySchema, { year: "2026", month: "11" })).toMatchObject({
      year: 2026,
      month: 11,
    });
    // Omitted optional filters stay absent; page defaults survive the change.
    expect(parseOrThrow(listInvoicesQuerySchema, {})).toMatchObject({ page: 1, pageSize: 50 });
  });

  it("leaves POST body numbers uncoerced, so a missing body field still says Required", () => {
    // runBillingSchema is the POST body schema (billingPeriodSchema); it must NOT be
    // changed to the query coercion — its "Required" is the correct body message.
    expect(validationMessage(runBillingSchema, {})).toBe("Required");
    expect(validationMessage(runBillingSchema, { year: "abc" })).toBe(
      "Expected number, received string"
    );
  });
});
