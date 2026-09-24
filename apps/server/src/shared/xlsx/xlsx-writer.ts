// A small, dependency-free .xlsx writer.
//
// An .xlsx workbook is a ZIP archive of XML parts. Rather than pull in a
// spreadsheet library for one report, this module writes the six parts an Excel
// reader needs and stores them UNCOMPRESSED, which removes any need for a
// compression dependency. Reports are small, so the larger file size costs nothing.
//
// It writes one worksheet: inline strings and numbers, no styling. That is all the
// AR aging export needs.

/** One row of a worksheet: strings become inline text, numbers become numeric cells. */
export type XlsxRow = readonly (string | number)[];

const encoder = new TextEncoder();

function toBytes(text: string): Uint8Array {
  return encoder.encode(text);
}

// ─── ZIP (stored entries) ────────────────────────────────────────────────────

/** The CRC-32 lookup table, built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** The CRC-32 checksum of a byte array, as the ZIP format requires. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pushUint16(target: number[], value: number): void {
  target.push(value & 0xff, (value >>> 8) & 0xff);
}

function pushUint32(target: number[], value: number): void {
  target.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function pushBytes(target: number[], bytes: Uint8Array): void {
  for (const byte of bytes) {
    target.push(byte);
  }
}

interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

/** Builds a ZIP archive whose entries are stored (compression method 0). */
export function buildStoredZip(entries: readonly ZipEntry[]): Uint8Array {
  const localParts: number[] = [];
  const centralParts: number[] = [];

  for (const entry of entries) {
    const nameBytes = toBytes(entry.name);
    const checksum = crc32(entry.bytes);
    const size = entry.bytes.length;
    const localHeaderOffset = localParts.length;

    pushUint32(localParts, 0x04034b50); // local file header signature
    pushUint16(localParts, 20); // version needed
    pushUint16(localParts, 0x0800); // UTF-8 file names
    pushUint16(localParts, 0); // stored — no compression
    pushUint16(localParts, 0); // modification time
    pushUint16(localParts, 0); // modification date
    pushUint32(localParts, checksum);
    pushUint32(localParts, size); // compressed size
    pushUint32(localParts, size); // uncompressed size
    pushUint16(localParts, nameBytes.length);
    pushUint16(localParts, 0); // extra field length
    pushBytes(localParts, nameBytes);
    pushBytes(localParts, entry.bytes);

    pushUint32(centralParts, 0x02014b50); // central directory header signature
    pushUint16(centralParts, 20); // version made by
    pushUint16(centralParts, 20); // version needed
    pushUint16(centralParts, 0x0800); // UTF-8 file names
    pushUint16(centralParts, 0); // stored
    pushUint16(centralParts, 0); // modification time
    pushUint16(centralParts, 0); // modification date
    pushUint32(centralParts, checksum);
    pushUint32(centralParts, size);
    pushUint32(centralParts, size);
    pushUint16(centralParts, nameBytes.length);
    pushUint16(centralParts, 0); // extra field length
    pushUint16(centralParts, 0); // comment length
    pushUint16(centralParts, 0); // disk number start
    pushUint16(centralParts, 0); // internal attributes
    pushUint32(centralParts, 0); // external attributes
    pushUint32(centralParts, localHeaderOffset);
    pushBytes(centralParts, nameBytes);
  }

  const centralDirectoryOffset = localParts.length;
  const archive = [...localParts, ...centralParts];

  pushUint32(archive, 0x06054b50); // end of central directory signature
  pushUint16(archive, 0); // number of this disk
  pushUint16(archive, 0); // disk with the central directory
  pushUint16(archive, entries.length); // entries on this disk
  pushUint16(archive, entries.length); // total entries
  pushUint32(archive, centralParts.length); // central directory size
  pushUint32(archive, centralDirectoryOffset);
  pushUint16(archive, 0); // comment length

  return Uint8Array.from(archive);
}

// ─── Spreadsheet XML ─────────────────────────────────────────────────────────

/** Escapes the five XML metacharacters so cell text can never break the document. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** The spreadsheet column letters for a zero-based index: 0 → "A", 26 → "AA". */
export function columnLetter(zeroBasedIndex: number): string {
  let index = zeroBasedIndex;
  let letters = "";
  while (index >= 0) {
    letters = String.fromCharCode((index % 26) + 0x41) + letters;
    index = Math.floor(index / 26) - 1;
  }
  return letters;
}

/** One cell's XML: a number cell, or an inline-string cell. */
function cellXml(value: string | number, reference: string): string {
  if (typeof value === "number") {
    return `<c r="${reference}"><v>${value}</v></c>`;
  }
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

/** The worksheet XML for the given rows. */
export function buildSheetXml(rows: readonly XlsxRow[]): string {
  const rowXml = rows
    .map((row, rowIndex) => {
      const rowNumber = rowIndex + 1;
      const cells = row
        .map((value, columnIndex) => cellXml(value, `${columnLetter(columnIndex)}${rowNumber}`))
        .join("");
      return `<row r="${rowNumber}">${cells}</row>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`;
}

/** Sanitizes a sheet name: Excel forbids []:*?/\ and names longer than 31 characters. */
function sanitizeSheetName(sheetName: string): string {
  const cleaned = sheetName.replace(/[[\]:*?/\\]/g, " ").trim();
  return cleaned.length === 0 ? "Sheet1" : cleaned.slice(0, 31);
}

/** Builds a complete single-sheet .xlsx workbook from rows. */
export function buildXlsxWorkbook(sheetName: string, rows: readonly XlsxRow[]): Uint8Array {
  const safeSheetName = sanitizeSheetName(sheetName);

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(safeSheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;

  return buildStoredZip([
    { name: "[Content_Types].xml", bytes: toBytes(contentTypes) },
    { name: "_rels/.rels", bytes: toBytes(rootRels) },
    { name: "xl/workbook.xml", bytes: toBytes(workbook) },
    { name: "xl/_rels/workbook.xml.rels", bytes: toBytes(workbookRels) },
    { name: "xl/worksheets/sheet1.xml", bytes: toBytes(buildSheetXml(rows)) },
  ]);
}