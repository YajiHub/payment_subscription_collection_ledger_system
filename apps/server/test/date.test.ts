// Unit tests for the local-calendar business date helper.
// Pure — no server, no database.

import { describe, expect, it } from "vitest";

import { formatDateOnly } from "../src/shared/date";

describe("formatDateOnly", () => {
  it("formats a date as YYYY-MM-DD", () => {
    // Constructed from local calendar fields on purpose: the helper must read the
    // local day, so the assertion must be built the same way.
    expect(formatDateOnly(new Date(2025, 0, 24, 13, 30))).toBe("2025-01-24");
  });

  it("pads single-digit months and days", () => {
    expect(formatDateOnly(new Date(2025, 8, 5, 9, 0))).toBe("2025-09-05");
  });

  it("uses the local day even when UTC has rolled over", () => {
    // 23:30 local on the 24th is the 25th in UTC for a UTC+8 office.
    // The business date must stay the 24th so a suspension lands in the right period.
    const lateEvening = new Date(2025, 0, 24, 23, 30);
    expect(formatDateOnly(lateEvening)).toBe("2025-01-24");
  });
});
