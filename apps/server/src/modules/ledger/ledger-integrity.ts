// Pure ledger-integrity checks.
//
// These functions do no I/O: they take the entries of one service account and
// decide whether the chain is sound. Keeping the logic pure means the corruption
// tests can feed it a deliberately broken chain and prove it says so — a check
// that can only ever return `isValid: true` would be worthless.
//
// A sound ledger has three properties:
//   1. Sequence numbers start at 1 and increase by exactly one, with no gaps and
//      no duplicates. A gap means an entry was deleted; a duplicate means two
//      writers raced past the lock.
//   2. Each entry's running balance equals the previous running balance plus the
//      amount for a debit, or minus it for a credit.
//   3. Therefore the last entry's running balance equals the sum of every debit
//      minus every credit.

import { isDebitLedgerEntryType, type LedgerEntryType } from "@bcis/shared";

/** The ledger fields the integrity check needs. */
export interface LedgerChainEntry {
  id: string;
  sequenceNumber: number;
  entryType: LedgerEntryType;
  amountCentavos: number;
  runningBalanceCentavos: number;
}

/** Why a ledger chain failed verification. */
export type LedgerIntegrityFailure =
  "duplicate_sequence_number" | "sequence_gap" | "broken_running_balance";

export interface LedgerIntegrityResult {
  isValid: boolean;
  failure: LedgerIntegrityFailure | null;
  /** computed − stored at the point of failure; 0 when the chain is sound. */
  discrepancyCentavos: number;
  duplicateSequenceNumber: number | null;
  missingSequenceNumber: number | null;
  entryCount: number;
  lastComputedBalanceCentavos: number;
  lastStoredBalanceCentavos: number;
}

/**
 * The balance after an entry of `entryType`, given the balance before it.
 * A debit adds; a credit subtracts. Amounts are always positive integers.
 */
export function computeRunningBalanceCentavos(
  previousBalanceCentavos: number,
  entryType: LedgerEntryType,
  amountCentavos: number
): number {
  return isDebitLedgerEntryType(entryType)
    ? previousBalanceCentavos + amountCentavos
    : previousBalanceCentavos - amountCentavos;
}

/**
 * Verifies one service account's ledger chain.
 *
 * Entries are sorted by sequence number before checking, so callers do not have
 * to care about query order. Returns the first failure found, with the numbers
 * needed to explain it.
 */
export function verifyLedgerChain(entries: readonly LedgerChainEntry[]): LedgerIntegrityResult {
  const orderedEntries = [...entries].sort(
    (left, right) => left.sequenceNumber - right.sequenceNumber || left.id.localeCompare(right.id)
  );

  if (orderedEntries.length === 0) {
    return {
      isValid: true,
      failure: null,
      discrepancyCentavos: 0,
      duplicateSequenceNumber: null,
      missingSequenceNumber: null,
      entryCount: 0,
      lastComputedBalanceCentavos: 0,
      lastStoredBalanceCentavos: 0,
    };
  }

  const seenSequenceNumbers = new Set<number>();
  let expectedSequenceNumber = 1;
  let computedBalanceCentavos = 0;

  for (const entry of orderedEntries) {
    if (seenSequenceNumbers.has(entry.sequenceNumber)) {
      return {
        isValid: false,
        failure: "duplicate_sequence_number",
        discrepancyCentavos: computedBalanceCentavos - entry.runningBalanceCentavos,
        duplicateSequenceNumber: entry.sequenceNumber,
        missingSequenceNumber: null,
        entryCount: orderedEntries.length,
        lastComputedBalanceCentavos: computedBalanceCentavos,
        lastStoredBalanceCentavos: entry.runningBalanceCentavos,
      };
    }

    if (entry.sequenceNumber !== expectedSequenceNumber) {
      return {
        isValid: false,
        failure: "sequence_gap",
        discrepancyCentavos: computedBalanceCentavos - entry.runningBalanceCentavos,
        duplicateSequenceNumber: null,
        missingSequenceNumber: expectedSequenceNumber,
        entryCount: orderedEntries.length,
        lastComputedBalanceCentavos: computedBalanceCentavos,
        lastStoredBalanceCentavos: entry.runningBalanceCentavos,
      };
    }

    seenSequenceNumbers.add(entry.sequenceNumber);
    expectedSequenceNumber += 1;

    computedBalanceCentavos = computeRunningBalanceCentavos(
      computedBalanceCentavos,
      entry.entryType,
      entry.amountCentavos
    );

    if (computedBalanceCentavos !== entry.runningBalanceCentavos) {
      return {
        isValid: false,
        failure: "broken_running_balance",
        discrepancyCentavos: computedBalanceCentavos - entry.runningBalanceCentavos,
        duplicateSequenceNumber: null,
        missingSequenceNumber: null,
        entryCount: orderedEntries.length,
        lastComputedBalanceCentavos: computedBalanceCentavos,
        lastStoredBalanceCentavos: entry.runningBalanceCentavos,
      };
    }
  }

  return {
    isValid: true,
    failure: null,
    discrepancyCentavos: 0,
    duplicateSequenceNumber: null,
    missingSequenceNumber: null,
    entryCount: orderedEntries.length,
    lastComputedBalanceCentavos: computedBalanceCentavos,
    lastStoredBalanceCentavos: computedBalanceCentavos,
  };
}
