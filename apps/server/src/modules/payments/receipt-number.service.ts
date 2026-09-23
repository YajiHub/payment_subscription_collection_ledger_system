// Human-readable, permanent receipt numbers.
//
//   OR-2025-000042   Official Receipt for a posted payment
//   RV-2025-000042   Reversal Receipt for a reversal
//
// A receipt number is never reused and never edited: a reversed payment keeps its
// OR number forever, and the reversal gets its own RV number. Both appear in the
// audit trail.
//
// Allocation is atomic. Before computing MAX+1 the transaction takes a Postgres
// advisory lock keyed by the prefix and year, so two concurrent posts cannot read
// the same maximum and hand out one number twice. The unique constraint on the
// receipt number is the second line of defence.

import { like, sql } from "drizzle-orm";

import { REVERSAL_RECEIPT_PREFIX, RECEIPT_NUMBER_PREFIX } from "@bcis/shared";
import type { DbExecutor } from "../../db/connection";
import { paymentReversals, payments } from "../../db/schema/payments";

/** Builds a receipt number from its parts: ("OR", 2025, 42) → "OR-2025-000042". */
export function generateReceiptNumber(prefix: string, year: number, sequenceNumber: number): string {
  return `${prefix}-${year}-${String(sequenceNumber).padStart(6, "0")}`;
}

/** The prefix shared by every receipt number of a given kind and year. */
export function receiptNumberPrefix(prefix: string, year: number): string {
  return `${prefix}-${year}-`;
}

/**
 * Picks the next sequence number from the receipt numbers that already exist.
 *
 * Anything that does not match the expected prefix — or whose tail is not a
 * number — is ignored, so an imported or malformed number can never break
 * generation for the rest of the year.
 */
export function nextReceiptSequenceNumber(
  existingReceiptNumbers: readonly string[],
  prefix: string,
  year: number
): number {
  const expectedPrefix = receiptNumberPrefix(prefix, year);
  let highestSequence = 0;

  for (const receiptNumber of existingReceiptNumbers) {
    if (!receiptNumber.startsWith(expectedPrefix)) {
      continue;
    }

    const parsedSequence = Number.parseInt(receiptNumber.slice(expectedPrefix.length), 10);

    if (Number.isInteger(parsedSequence) && parsedSequence > highestSequence) {
      highestSequence = parsedSequence;
    }
  }

  return highestSequence + 1;
}

/**
 * Takes a transaction-scoped advisory lock for a (prefix, year) pair.
 *
 * The lock is released automatically when the transaction ends, and it only
 * blocks other receipt allocations for the same prefix and year.
 */
async function lockReceiptSequence(
  executor: DbExecutor,
  prefix: string,
  year: number
): Promise<void> {
  await executor.execute(sql`select pg_advisory_xact_lock(hashtext(${`${prefix}-${year}`}))`);
}

/** The next Official Receipt number, allocated atomically inside the caller's transaction. */
export async function getNextReceiptNumber(
  executor: DbExecutor,
  year: number = new Date().getFullYear()
): Promise<string> {
  await lockReceiptSequence(executor, RECEIPT_NUMBER_PREFIX, year);

  const prefix = receiptNumberPrefix(RECEIPT_NUMBER_PREFIX, year);
  const existing = await executor
    .select({ receiptNumber: payments.receiptNumber })
    .from(payments)
    .where(like(payments.receiptNumber, `${prefix}%`));

  const sequenceNumber = nextReceiptSequenceNumber(
    existing.map((row) => row.receiptNumber),
    RECEIPT_NUMBER_PREFIX,
    year
  );

  return generateReceiptNumber(RECEIPT_NUMBER_PREFIX, year, sequenceNumber);
}

/** The next Reversal Receipt number, allocated atomically inside the caller's transaction. */
export async function getNextReversalReceiptNumber(
  executor: DbExecutor,
  year: number = new Date().getFullYear()
): Promise<string> {
  await lockReceiptSequence(executor, REVERSAL_RECEIPT_PREFIX, year);

  const prefix = receiptNumberPrefix(REVERSAL_RECEIPT_PREFIX, year);
  const existing = await executor
    .select({ receiptNumber: paymentReversals.reversalReceiptNumber })
    .from(paymentReversals)
    .where(like(paymentReversals.reversalReceiptNumber, `${prefix}%`));

  const sequenceNumber = nextReceiptSequenceNumber(
    existing.map((row) => row.receiptNumber),
    REVERSAL_RECEIPT_PREFIX,
    year
  );

  return generateReceiptNumber(REVERSAL_RECEIPT_PREFIX, year, sequenceNumber);
}
