// The Collector Remittance Report (report R5).
//
// It is the piece of paper the office and the collector sign when the cash is
// handed over: what the batch says was collected, what the collector actually
// turned in, and the difference between the two.
//
// The variance is `actual - expected`, exactly as the collection service stores it
// on the batch: positive means the collector handed in more than they collected
// (an overage), negative means less (a shortage). The report never recomputes it
// from other numbers — a second computation is how two documents start disagreeing.
//
// A voided collection contributed nothing: voiding reverses its payment, so the
// assignment's collected amount is already null and its line shows zero.
//
// All arithmetic is on integer centavos.

import type { CollectedMethod, CollectionResult, CollectorBatchStatus } from "@bcis/shared";
import type { CollectorBatchDetail } from "../collections/collector-batches.service";

/** One line of the report: one assigned subscriber. */
export interface CollectorRemittanceLine {
  subscriberName: string;
  serviceAccountNumber: string;
  /** 0 when nothing was collected, or when the collection was voided. */
  collectedAmountCentavos: number;
  collectedMethod: CollectedMethod | null;
  collectionResult: CollectionResult | null;
  /** True when the collector's collection was voided and the money reversed. */
  isVoided: boolean;
}

export interface CollectorRemittanceReport {
  batchId: string;
  batchNumber: string;
  collectorName: string;
  collectionDate: string;
  status: CollectorBatchStatus;
  lines: CollectorRemittanceLine[];
  /** Sum of the line amounts — what the batch expects the collector to remit. */
  expectedRemittanceCentavos: number;
  /** What was handed in, or null while the batch is still open. */
  actualRemittanceCentavos: number | null;
  /** actual - expected, or null while the batch is still open. */
  varianceCentavos: number | null;
  hasVariance: boolean;
}

/**
 * Builds the remittance report for one batch.
 *
 * Pure: it takes the batch detail the collection service already assembled, so the
 * report and the batch detail screen show the same numbers.
 */
export function buildCollectorRemittanceReport(
  batch: CollectorBatchDetail
): CollectorRemittanceReport {
  const lines: CollectorRemittanceLine[] = batch.assignments.map((assignment) => ({
    subscriberName: assignment.subscriberName,
    serviceAccountNumber: assignment.serviceAccountNumber,
    collectedAmountCentavos: assignment.collectedAmountCentavos ?? 0,
    collectedMethod: assignment.collectedMethod,
    collectionResult: assignment.collectionResult,
    isVoided: assignment.voidedAt !== null,
  }));

  const collectedFromLines = lines.reduce(
    (runningTotal, line) => runningTotal + line.collectedAmountCentavos,
    0
  );

  return {
    batchId: batch.id,
    batchNumber: batch.batchNumber,
    collectorName: batch.collectorName,
    collectionDate: batch.collectionDate,
    status: batch.status,
    lines,
    expectedRemittanceCentavos: collectedFromLines,
    actualRemittanceCentavos: batch.actualRemittanceCentavos,
    varianceCentavos: batch.varianceCentavos,
    hasVariance: batch.varianceCentavos !== null && batch.varianceCentavos !== 0,
  };
}
