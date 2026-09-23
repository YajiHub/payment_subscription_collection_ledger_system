// Unit tests for receipt number generation. No database: these are the pure parts
// that guarantee the OR-YYYY-XXXXXX format and the next-in-sequence arithmetic.

import { describe, expect, it } from "vitest";

import {
  generateReceiptNumber,
  nextReceiptSequenceNumber,
  receiptNumberPrefix,
} from "../src/modules/payments/receipt-number.service";

describe("receipt numbers", () => {
  it("builds an Official Receipt number in OR-YYYY-XXXXXX format", () => {
    expect(generateReceiptNumber("OR", 2025, 42)).toBe("OR-2025-000042");
    expect(generateReceiptNumber("OR", 2025, 1)).toBe("OR-2025-000001");
    expect(generateReceiptNumber("OR", 2025, 999999)).toBe("OR-2025-999999");
  });

  it("builds a Reversal Receipt number in RV-YYYY-XXXXXX format", () => {
    expect(generateReceiptNumber("RV", 2025, 7)).toBe("RV-2025-000007");
  });

  it("uses a prefix scoped to the kind and year", () => {
    expect(receiptNumberPrefix("OR", 2025)).toBe("OR-2025-");
    expect(receiptNumberPrefix("RV", 2025)).toBe("RV-2025-");
  });

  it("picks one past the highest existing number", () => {
    expect(
      nextReceiptSequenceNumber(["OR-2025-000001", "OR-2025-000042"], "OR", 2025)
    ).toBe(43);
  });

  it("starts at one when nothing has been issued yet", () => {
    expect(nextReceiptSequenceNumber([], "OR", 2025)).toBe(1);
  });

  it("ignores other years and malformed numbers", () => {
    const existing = ["OR-2024-000900", "OR-2025-000003", "OR-2025-abc", "RV-2025-000050"];

    expect(nextReceiptSequenceNumber(existing, "OR", 2025)).toBe(4);
    expect(nextReceiptSequenceNumber(existing, "RV", 2025)).toBe(51);
  });
});
