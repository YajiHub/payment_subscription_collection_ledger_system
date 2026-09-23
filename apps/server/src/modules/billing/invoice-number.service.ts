// Human-readable, sortable invoice numbers.
//
//   INV-YYYY-MM-XXXXXX   →   INV-2025-01-000042
//
// The billing period is embedded in the number so a printed document says at a
// glance which month it covers, and the padded six-digit sequence keeps numbers
// the same length so they sort correctly as text.

import { like } from "drizzle-orm";

import type { DbExecutor } from "../../db/connection";
import { invoices } from "../../db/schema/billing";

/** Builds an invoice number from its parts. */
export function generateInvoiceNumber(year: number, month: number, sequenceNumber: number): string {
  const monthSegment = String(month).padStart(2, "0");
  const sequenceSegment = String(sequenceNumber).padStart(6, "0");
  return `INV-${year}-${monthSegment}-${sequenceSegment}`;
}

/** The prefix shared by every invoice number in a given billing period. */
export function invoiceNumberPrefix(year: number, month: number): string {
  return `INV-${year}-${String(month).padStart(2, "0")}-`;
}

/**
 * Picks the next sequence number for a billing period.
 *
 * Existing numbers for the same period are inspected and the highest one wins.
 * Anything that does not match the expected prefix — or whose tail is not a
 * number — is ignored, so an imported or malformed invoice number can never break
 * generation for the rest of the period.
 */
export function nextInvoiceSequenceNumber(
  existingInvoiceNumbers: readonly string[],
  year: number,
  month: number
): number {
  const prefix = invoiceNumberPrefix(year, month);
  let highestSequence = 0;

  for (const invoiceNumber of existingInvoiceNumbers) {
    if (!invoiceNumber.startsWith(prefix)) {
      continue;
    }

    const sequencePart = invoiceNumber.slice(prefix.length);
    const parsedSequence = Number.parseInt(sequencePart, 10);

    if (Number.isInteger(parsedSequence) && parsedSequence > highestSequence) {
      highestSequence = parsedSequence;
    }
  }

  return highestSequence + 1;
}

/**
 * Allocates the next invoice number for a billing period by reading the numbers
 * that already exist. Called inside the same transaction that inserts the invoice,
 * so a number can never be handed out twice.
 */
export async function allocateNextInvoiceNumber(
  executor: DbExecutor,
  year: number,
  month: number
): Promise<string> {
  const prefix = invoiceNumberPrefix(year, month);

  const existingNumbers = await executor
    .select({ invoiceNumber: invoices.invoiceNumber })
    .from(invoices)
    .where(like(invoices.invoiceNumber, `${prefix}%`));

  const sequenceNumber = nextInvoiceSequenceNumber(
    existingNumbers.map((row) => row.invoiceNumber),
    year,
    month
  );

  return generateInvoiceNumber(year, month, sequenceNumber);
}
