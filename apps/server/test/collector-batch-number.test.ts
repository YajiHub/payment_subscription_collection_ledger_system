// Pure tests for collector batch number generation.
//
// Batch numbers must be human-readable, stable for a given field date, and unique
// per date. The generation is a pure function so it is tested without a database.

import { describe, expect, it } from "vitest";

import {
  collectorBatchNumberPrefix,
  generateCollectorBatchNumber,
  nextCollectorBatchSequenceNumber,
} from "@bcis/shared";

describe("collector batch numbers", () => {
  it("embeds the field date and pads the sequence to four digits", () => {
    expect(generateCollectorBatchNumber("2025-01-24", 7)).toBe("CB-20250124-0007");
    expect(generateCollectorBatchNumber("2025-11-02", 1234)).toBe("CB-20251102-1234");
  });

  it("shares one prefix per collection date", () => {
    expect(collectorBatchNumberPrefix("2025-01-24")).toBe("CB-20250124-");
  });

  it("continues from the highest number already used on that date", () => {
    expect(
      nextCollectorBatchSequenceNumber(
        ["CB-20250124-0001", "CB-20250124-0003", "CB-20250124-0010"],
        "2025-01-24"
      )
    ).toBe(11);
  });

  it("ignores numbers for other dates and malformed tails", () => {
    expect(
      nextCollectorBatchSequenceNumber(
        ["CB-20250123-0099", "CB-20250124-0002", "CB-20250124-abc", "junk"],
        "2025-01-24"
      )
    ).toBe(3);
  });

  it("starts at one when the date has no batches yet", () => {
    expect(nextCollectorBatchSequenceNumber([], "2025-01-24")).toBe(1);
  });
});