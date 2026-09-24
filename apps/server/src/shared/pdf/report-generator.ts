// Turns a report table into a PDF document.
//
// Why not Puppeteer (the other option Phase 8 offers): rendering HTML to PDF needs
// a bundled Chromium, which is a ~200 MB dependency that must be launched for every
// export and cannot run in a database-free unit test. This module draws the table
// itself with pdf-lib and takes no browser, so an export is fast, deterministic, and
// covered by tests. The Phase 7 spreadsheet export made the same trade-off for XLSX.
//
// Money is drawn from the integer centavos in the table (see shared/reports/money-format.ts),
// so the printed total is the same integer the database holds.
//
// The standard PDF fonts cover WinAnsi only, so `sanitizePdfText` replaces the few
// characters that would otherwise throw and leave a report unrenderable.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

import type { ReportColumn, ReportTable } from "../reports/report-table";
import { formatReportCount, formatReportMoney } from "../reports/money-format";

export const PDF_CONTENT_TYPE = "application/pdf";

/** A point is 1/72 inch; these are the A4 dimensions in points. */
const A4_PORTRAIT = { width: 595.28, height: 841.89 };
const A4_LANDSCAPE = { width: 841.89, height: 595.28 };

const MARGIN = 36;
const TITLE_SIZE = 14;
const BODY_SIZE = 8;
const ROW_HEIGHT = 14;
const HEADER_HEIGHT = 18;

/**
 * The characters that must never reach a standard PDF font.
 *
 * Anything outside latin-1 would make pdf-lib throw, so it is mapped to a plain
 * ASCII equivalent (or dropped) before a single character is measured.
 */
const PDF_TEXT_REPLACEMENTS: readonly (readonly [RegExp, string])[] = [
  [/[₱]/g, "PHP "],
  [/[\u2018\u2019\u201b]/g, "'"],
  [/[\u201c\u201d]/g, '"'],
  [/[\u2013\u2014]/g, "-"],
  [/[\u2022]/g, "*"],
  [/[\u2026]/g, "..."],
  [/[\u00a0]/g, " "],
];

/** Replaces characters the PDF standard fonts cannot encode, then drops the rest. */
export function sanitizePdfText(text: string): string {
  let sanitized = text;
  for (const [pattern, replacement] of PDF_TEXT_REPLACEMENTS) {
    sanitized = sanitized.replace(pattern, replacement);
  }

  // Latin-1 is what WinAnsi can encode; anything with a higher code point has no
  // glyph in the standard fonts. The `u` flag here makes the range match whole code
  // points, so a multi-byte character is replaced once rather than per byte.
  return sanitized.replace(/[\u{100}-\u{10ffff}]/gu, "?");
}

/** How a column's value is drawn: text as-is, money in pesos, a count with separators. */
function formatCell(value: string | number, column: ReportColumn | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (column?.format === "money") {
    return formatReportMoney(value);
  }
  return formatReportCount(value);
}

/** Shortens text to a width, ending in "…" when it had to be cut. */
function fitText(font: PDFFont, text: string, maxWidth: number, size: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) {
    return text;
  }

  let shortened = text;
  while (shortened.length > 1 && font.widthOfTextAtSize(`${shortened}...`, size) > maxWidth) {
    shortened = shortened.slice(0, -1);
  }
  return `${shortened}...`;
}

/** Each column's share of the printable width: the first (name) column twice as wide. */
function columnWidths(table: ReportTable, printableWidth: number): number[] {
  const weights = table.columns.map((_column, index) => (index === 0 ? 2 : 1));
  const totalWeight = weights.reduce((runningTotal, weight) => runningTotal + weight, 0);

  return weights.map((weight) => (weight / totalWeight) * printableWidth);
}

interface DrawContext {
  page: PDFPage;
  regularFont: PDFFont;
  boldFont: PDFFont;
  widths: number[];
  left: number;
  columns: readonly ReportColumn[];
}

/** One row of cells, right-aligning numbers and truncating anything too wide. */
function drawRow(
  context: DrawContext,
  values: readonly (string | number)[],
  y: number,
  isBold: boolean
): void {
  const font = isBold ? context.boldFont : context.regularFont;
  let x = context.left;

  values.forEach((value, columnIndex) => {
    const width = context.widths[columnIndex] ?? 0;
    const column = context.columns[columnIndex];
    const isNumeric = typeof value === "number";
    const text = fitText(font, sanitizePdfText(formatCell(value, column)), width - 6, BODY_SIZE);

    const textWidth = font.widthOfTextAtSize(text, BODY_SIZE);
    const drawX = isNumeric ? x + width - 6 - textWidth : x;

    context.page.drawText(text, { x: drawX, y, size: BODY_SIZE, font });
    x += width;
  });
}

/** The table's header row, with a light rule under it. */
function drawHeaderRow(context: DrawContext, y: number): void {
  drawRow(
    context,
    context.columns.map((column) => column.header),
    y,
    true
  );

  context.page.drawLine({
    start: { x: context.left, y: y - 4 },
    end: { x: context.left + context.widths.reduce((a, b) => a + b, 0), y: y - 4 },
    thickness: 0.5,
    color: rgb(0.4, 0.4, 0.4),
  });
}

/** Draws the title and subtitle at the top of the first page. */
function drawDocumentHeading(
  page: PDFPage,
  boldFont: PDFFont,
  regularFont: PDFFont,
  table: ReportTable
): number {
  page.drawText(sanitizePdfText(table.title), {
    x: MARGIN,
    y: page.getHeight() - MARGIN - TITLE_SIZE,
    size: TITLE_SIZE,
    font: boldFont,
  });

  if (table.subtitle === null) {
    return page.getHeight() - MARGIN - TITLE_SIZE * 2.2;
  }

  page.drawText(sanitizePdfText(table.subtitle), {
    x: MARGIN,
    y: page.getHeight() - MARGIN - TITLE_SIZE * 1.6,
    size: BODY_SIZE + 1,
    font: regularFont,
  });
  return page.getHeight() - MARGIN - TITLE_SIZE * 2.6;
}

/**
 * Builds the PDF bytes for a report table.
 *
 * Rows are laid out top to bottom; when the page runs out, a new page starts and
 * the column headers are repeated, so a long aging report stays readable on paper.
 * A page is always left with room for at least one row and the totals lines; when
 * there is not enough, the totals start on a fresh page.
 */
export async function generateReportPdf(table: ReportTable): Promise<Buffer> {
  const pdfDocument = await PDFDocument.create();
  const regularFont = await pdfDocument.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDocument.embedFont(StandardFonts.HelveticaBold);

  const orientationSize = table.orientation === "landscape" ? A4_LANDSCAPE : A4_PORTRAIT;
  const printableWidth = orientationSize.width - MARGIN * 2;
  const widths = columnWidths(table, printableWidth);

  pdfDocument.setTitle(sanitizePdfText(table.title));

  const pages: PDFPage[] = [];
  const bottomLimit = MARGIN + ROW_HEIGHT;

  // The current page and the y position of the next row. A page break re-draws the
  // column headers so every page of a long report identifies its own columns.
  let page = pdfDocument.addPage([orientationSize.width, orientationSize.height]);
  pages.push(page);
  let y = drawDocumentHeading(page, boldFont, regularFont, table);

  let context: DrawContext = {
    page,
    regularFont,
    boldFont,
    widths,
    left: MARGIN,
    columns: table.columns,
  };
  drawHeaderRow(context, y);
  y -= HEADER_HEIGHT;

  function startNewPage(): void {
    page = pdfDocument.addPage([orientationSize.width, orientationSize.height]);
    pages.push(page);
    context = { page, regularFont, boldFont, widths, left: MARGIN, columns: table.columns };
    y = orientationSize.height - MARGIN - ROW_HEIGHT;
    drawHeaderRow(context, y);
    y -= HEADER_HEIGHT;
  }

  for (const row of table.rows) {
    if (y < bottomLimit) {
      startNewPage();
    }
    drawRow(context, row, y, false);
    y -= ROW_HEIGHT;
  }

  // The totals lines are moved to a fresh page as a block when they would not all
  // fit, so a variance and its label can never end up on different sheets.
  if (table.totalsRows.length > 0 && y - table.totalsRows.length * ROW_HEIGHT < MARGIN) {
    startNewPage();
  }

  for (const totalsRow of table.totalsRows) {
    drawRow(context, totalsRow, y, true);
    y -= ROW_HEIGHT;
  }

  // The page numbers can only be stamped once the total page count is known.
  pages.forEach((currentPage, index) => {
    currentPage.drawText(`Page ${index + 1} of ${pages.length}`, {
      x: currentPage.getWidth() / 2 - 24,
      y: MARGIN / 2,
      size: BODY_SIZE,
      font: regularFont,
    });
  });

  const bytes = await pdfDocument.save();
  return Buffer.from(bytes);
}
