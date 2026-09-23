// Tests for invoice number generation.
// Pure functions — no database and no server needed.

import { describe, expect, it } from "vitest";

import {
  generateInvoiceNumber,
  invoiceNumberPrefix,
  nextInvoiceSequenceNumber,
} from "../src/modules/billing/invoice-number.service";

describe("invoice numbers", () => {
  it("follows the INV-YYYY-MM-XXXXXX format", () => {
    expect(generateInvoiceNumber(2025, 1, 42)).toBe("INV-2025-01-000042");
    expect(generateInvoiceNumber(2025, 12, 7)).toBe("INV-2025-12-000007");
  });

  it("builds the period prefix the allocation query uses", () => {
    expect(invoiceNumberPrefix(2025, 3)).toBe("INV-2025-03-");
  });

  it("starts at 1 when nothing exists for the period", () => {
    expect(nextInvoiceSequenceNumber([], 2025, 1)).toBe(1);
  });

  it("continues after the highest number already used in the period", () => {
    const existing = [
      "INV-2025-01-000007",
      "INV-2025-01-000042",
      "INV-2025-02-000099", // a different period must not affect this one
      "not-an-invoice-number",
      "INV-2025-01-xxxxxx",
    ];

    expect(nextInvoiceSequenceNumber(existing, 2025, 1)).toBe(43);
  });

  it("produces numbers that sort correctly as text", () => {
    const earlier = generateInvoiceNumber(2025, 1, 42);
    const later = generateInvoiceNumber(2025, 1, 1000);
    expect(earlier < later).toBe(true);
  });
});
