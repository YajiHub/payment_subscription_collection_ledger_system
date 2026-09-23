// Unit tests for account number generation. Pure functions — no server, no database.
//
// The format matters: a clerk reads these numbers off a printed receipt, and the
// padded sequence keeps them sortable as text.

import { describe, expect, it } from "vitest";

import {
  formatDateSegment,
  generateServiceAccountNumber,
  generateSubscriberAccountNumber,
  nextSequenceNumber,
} from "../src/modules/subscribers/account-number.service";

const JANUARY_24_2025 = new Date("2025-01-24T00:00:00.000Z");

describe("account number generation", () => {
  it("formats a subscriber account number as SUB-YYYYMMDD-XXXXX", () => {
    expect(generateSubscriberAccountNumber(JANUARY_24_2025, 42)).toBe("SUB-20250124-00042");
  });

  it("formats a service account number as SA-YYYYMMDD-XXXXX", () => {
    expect(generateServiceAccountNumber(JANUARY_24_2025, 42)).toBe("SA-20250124-00042");
  });

  it("pads the sequence to five digits so numbers sort as text", () => {
    expect(generateSubscriberAccountNumber(JANUARY_24_2025, 1)).toBe("SUB-20250124-00001");
    expect(generateSubscriberAccountNumber(JANUARY_24_2025, 99999)).toBe("SUB-20250124-99999");
  });

  it("produces a stable YYYYMMDD date segment", () => {
    expect(formatDateSegment(JANUARY_24_2025)).toBe("20250124");
  });
});

describe("next sequence number", () => {
  it("starts at 1 when the day has no account numbers yet", () => {
    expect(nextSequenceNumber([], "SUB-20250124-")).toBe(1);
  });

  it("continues from the highest number already issued today", () => {
    const existing = ["SUB-20250124-00001", "SUB-20250124-00007", "SUB-20250124-00003"];
    expect(nextSequenceNumber(existing, "SUB-20250124-")).toBe(8);
  });

  it("ignores numbers issued on a different day", () => {
    const existing = ["SUB-20250123-00099", "SUB-20250124-00002"];
    expect(nextSequenceNumber(existing, "SUB-20250124-")).toBe(3);
  });

  it("ignores a manually imported account number that does not match the format", () => {
    const existing = ["SUB-20250124-00004", "LEGACY-ACCT", "SUB-20250124-XYZ"];
    expect(nextSequenceNumber(existing, "SUB-20250124-")).toBe(5);
  });
});
