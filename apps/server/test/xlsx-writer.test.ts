// Tests for the dependency-free xlsx writer.
//
// An .xlsx file is a ZIP of XML parts. We assert the ZIP signature, that the
// expected parts are present, that the report's text and numbers made it into the
// worksheet, and that the CRC-32 matches the format's published test vector.

import { describe, expect, it } from "vitest";

import { buildXlsxWorkbook, crc32, moneyCell } from "../src/shared/xlsx/xlsx-writer";
import { buildArAgingRows } from "../src/modules/receivables/ar-aging-export.service";
import type { ArAgingReport } from "../src/modules/receivables/ar-aging.service";

/** The bytes decoded as latin1, so the stored (uncompressed) parts read as text. */
function asLatin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1");
}

describe("crc32", () => {
  it("matches the standard check value for '123456789'", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("buildXlsxWorkbook", () => {
  const workbook = buildXlsxWorkbook("Sheet1", [
    ["Subscriber", "Total (centavos)"],
    ["Santos, Maria", 175000],
  ]);
  const decoded = asLatin1(workbook);

  it("starts with the ZIP local-file-header signature", () => {
    expect(workbook[0]).toBe(0x50); // P
    expect(workbook[1]).toBe(0x4b); // K
    expect(workbook[2]).toBe(0x03);
    expect(workbook[3]).toBe(0x04);
  });

  it("contains every part an Excel reader needs", () => {
    expect(decoded).toContain("[Content_Types].xml");
    expect(decoded).toContain("xl/workbook.xml");
    expect(decoded).toContain("xl/worksheets/sheet1.xml");
    expect(decoded).toContain(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
    );
  });

  it("writes string cells inline and numbers as numeric cells", () => {
    expect(decoded).toContain('<t xml:space="preserve">Santos, Maria</t>');
    expect(decoded).toContain('<c r="B2"><v>175000</v></c>');
  });

  it("ships the styles part and its content-type so Excel reads the number format", () => {
    expect(decoded).toContain("xl/styles.xml");
    expect(decoded).toContain(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"
    );
    expect(decoded).toContain(
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"
    );
  });

  it("writes a money cell as formatted pesos with the money style applied", () => {
    const moneyWorkbook = buildXlsxWorkbook("Sheet1", [["Amount"], [moneyCell(123456)]]);
    const moneyDecoded = asLatin1(moneyWorkbook);

    // Style index 1 is the `"PHP" #,##0.00` number format.
    expect(moneyDecoded).toContain('<c r="A2" s="1"><v>1234.56</v></c>');
    expect(moneyDecoded).toContain('formatCode="&quot;PHP&quot; #,##0.00"');
    expect(moneyDecoded).not.toContain("123456");
  });
});

describe("buildArAgingRows", () => {
  it("summarises every account and ends with the totals row", () => {
    const report: ArAgingReport = {
      asOfDate: "2025-02-15",
      entries: [
        {
          subscriberId: "subscriber-1",
          subscriberName: "Santos, Maria",
          serviceAccountId: "account-1",
          serviceAccountNumber: "SA-20250101-00001",
          planName: "Fiber 25Mbps",
          currentCentavos: 0,
          bucket_1_30_centavos: 50000,
          bucket_31_60_centavos: 0,
          bucket_61_90_centavos: 0,
          over_90_centavos: 0,
          totalOutstandingCentavos: 50000,
        },
      ],
      totals: {
        current: 0,
        bucket_1_30: 50000,
        bucket_31_60: 0,
        bucket_61_90: 0,
        over_90: 0,
        grandTotal: 50000,
      },
    };

    const rows = buildArAgingRows(report);
    const lastRow = rows[rows.length - 1];

    expect(rows[0]?.[0]).toContain("as of 2025-02-15");
    expect(lastRow?.[0]).toBe("TOTAL");
    // S6-4: money leaves the report as integer centavos wrapped for formatting, so
    // the spreadsheet shows pesos and the arithmetic above stayed integral.
    expect(lastRow?.[lastRow.length - 1]).toEqual({ centavos: 50000 });
  });
});
