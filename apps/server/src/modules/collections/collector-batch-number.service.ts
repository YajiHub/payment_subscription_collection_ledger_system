// Human-readable, unique collector batch numbers.
//
//   CB-20250124-0007
//
// The collection date is embedded so a printed batch slip says at a glance which
// field day it belongs to, and the padded four-digit sequence keeps the numbers
// the same length so they sort correctly as text.
//
// Allocation is atomic and BATCH numbers are unique system-wide: the unique
// constraint on collector_batches.batch_number is the last line of defence, but a
// duplicate must surface as a clean 409 rather than a raw database error — so the
// service checks before inserting and translates the constraint violation if two
// requests still race.

import { like, sql } from "drizzle-orm";

import {
  collectorBatchNumberPrefix,
  generateCollectorBatchNumber,
  nextCollectorBatchSequenceNumber,
} from "@bcis/shared";

import type { DbExecutor } from "../../db/connection";
import { collectorBatches } from "../../db/schema/collections";

/**
 * Takes a transaction-scoped advisory lock for a collection date.
 *
 * The lock is released automatically when the transaction ends and only blocks
 * other batch-number allocations for the SAME collection date, so two clerks
 * creating batches for the same day cannot read the same maximum and hand out one
 * number twice.
 */
export async function lockCollectorBatchNumber(
  executor: DbExecutor,
  collectionDate: string
): Promise<void> {
  await executor.execute(
    sql`select pg_advisory_xact_lock(hashtext(${collectorBatchNumberPrefix(collectionDate)}))`
  );
}

/**
 * The next collector batch number for a collection date, allocated atomically
 * inside the caller's transaction.
 */
export async function getNextCollectorBatchNumber(
  executor: DbExecutor,
  collectionDate: string
): Promise<string> {
  await lockCollectorBatchNumber(executor, collectionDate);

  const prefix = collectorBatchNumberPrefix(collectionDate);
  const existing = await executor
    .select({ batchNumber: collectorBatches.batchNumber })
    .from(collectorBatches)
    .where(like(collectorBatches.batchNumber, `${prefix}%`));

  const sequenceNumber = nextCollectorBatchSequenceNumber(
    existing.map((row) => row.batchNumber),
    collectionDate
  );

  return generateCollectorBatchNumber(collectionDate, sequenceNumber);
}