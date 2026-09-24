// Unit tests for the local-calendar business date helper.
// Pure — no server, no database.

import { describe, expect, it } from "vitest";

import {
  addDaysToDay,
  formatDateOnly,
  isDayInMonthWindow,
  monthWindowOfDay,
  utcMidnightOfDay,
} from "../src/shared/date";

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

describe("utcMidnightOfDay", () => {
  it("anchors a calendar day so a whole-day difference is exact", () => {
    // 30 days apart, whatever time of day the report is run.
    const differenceInDays =
      (utcMidnightOfDay("2025-01-31").getTime() - utcMidnightOfDay("2025-01-01").getTime()) /
      (24 * 60 * 60 * 1000);

    expect(differenceInDays).toBe(30);
  });
});

describe("addDaysToDay", () => {
  it("moves a day string across a month and a year boundary", () => {
    expect(addDaysToDay("2025-01-31", 1)).toBe("2025-02-01");
    expect(addDaysToDay("2025-12-31", 1)).toBe("2026-01-01");
    expect(addDaysToDay("2025-01-01", -1)).toBe("2024-12-31");
  });

  it("handles a leap year", () => {
    expect(addDaysToDay("2024-02-28", 1)).toBe("2024-02-29");
  });
});

describe("monthWindowOfDay", () => {
  it("returns the inclusive start and the exclusive end of the month", () => {
    expect(monthWindowOfDay("2025-01-24")).toEqual({
      year: 2025,
      month: 1,
      monthStart: "2025-01-01",
      nextMonthStart: "2025-02-01",
    });
  });

  it("rolls December over into the next year", () => {
    expect(monthWindowOfDay("2025-12-31")).toEqual({
      year: 2025,
      month: 12,
      monthStart: "2025-12-01",
      nextMonthStart: "2026-01-01",
    });
  });

  it("includes the first and last day of the month and excludes the next month's first", () => {
    const january = monthWindowOfDay("2025-01-24");

    expect(isDayInMonthWindow("2025-01-01", january)).toBe(true);
    expect(isDayInMonthWindow("2025-01-31", january)).toBe(true);
    expect(isDayInMonthWindow("2025-02-01", january)).toBe(false);
    expect(isDayInMonthWindow("2024-12-31", january)).toBe(false);
  });
});
