// Unit tests for the ledger integrity check.
//
// These are the tests that make `verifyLedgerIntegrity` trustworthy. A check that
// always answers `isValid: true` is worse than no check at all, so the broken,
// deleted, and duplicated cases below deliberately feed it a corrupted chain and
// require it to say so — with the numbers needed to explain the failure.

import { describe, expect, it } from "vitest";

import type { LedgerEntryType } from "@bcis/shared";
import {
  computeRunningBalanceCentavos,
  verifyLedgerChain,
  type LedgerChainEntry,
} from "../src/modules/ledger/ledger-integrity";

interface EntrySpec {
  entryType: LedgerEntryType;
  amountCentavos: number;
}

/** Builds a sound chain: each running balance is the previous one adjusted. */
function buildChain(specs: EntrySpec[]): LedgerChainEntry[] {
  let balanceCentavos = 0;
  return specs.map((spec, index) => {
    balanceCentavos = computeRunningBalanceCentavos(
      balanceCentavos,
      spec.entryType,
      spec.amountCentavos
    );
    return {
      id: `entry-${index + 1}`,
      sequenceNumber: index + 1,
      entryType: spec.entryType,
      amountCentavos: spec.amountCentavos,
      runningBalanceCentavos: balanceCentavos,
    };
  });
}

const MIXED_CHAIN: EntrySpec[] = [
  { entryType: "invoice_posted", amountCentavos: 99900 },
  { entryType: "payment_received", amountCentavos: 50000 },
  { entryType: "late_fee", amountCentavos: 5000 },
  { entryType: "payment_received", amountCentavos: 54900 },
  { entryType: "invoice_posted", amountCentavos: 99900 },
];

describe("verifyLedgerChain", () => {
  it("accepts a sound chain and reports the net balance", () => {
    const result = verifyLedgerChain(buildChain(MIXED_CHAIN));

    expect(result.isValid).toBe(true);
    expect(result.failure).toBeNull();
    expect(result.entryCount).toBe(5);
    // 99900 + 99900 debits − 50000 − 5000 − 54900 credits = 99900
    expect(result.lastComputedBalanceCentavos).toBe(99900);
    expect(result.lastStoredBalanceCentavos).toBe(99900);
    expect(result.discrepancyCentavos).toBe(0);
  });

  it("treats an account with no entries as valid and zero", () => {
    const result = verifyLedgerChain([]);

    expect(result.isValid).toBe(true);
    expect(result.entryCount).toBe(0);
    expect(result.lastComputedBalanceCentavos).toBe(0);
  });

  it("detects a broken running balance", () => {
    const entries = buildChain(MIXED_CHAIN);
    // Somebody tampered with the third entry's cached balance.
    entries[2] = { ...entries[2]!, runningBalanceCentavos: entries[2]!.runningBalanceCentavos + 1 };

    const result = verifyLedgerChain(entries);

    expect(result.isValid).toBe(false);
    expect(result.failure).toBe("broken_running_balance");
    expect(result.discrepancyCentavos).toBe(-1);
  });

  it("detects a deleted middle entry as a sequence gap", () => {
    const entries = buildChain(MIXED_CHAIN);
    // Simulate a row that disappeared: entry 2 is gone but entry 3 still follows.
    const withMiddleRemoved = [entries[0]!, entries[2]!, entries[3]!, entries[4]!];

    const result = verifyLedgerChain(withMiddleRemoved);

    expect(result.isValid).toBe(false);
    expect(result.failure).toBe("sequence_gap");
    expect(result.missingSequenceNumber).toBe(2);
  });

  it("detects a duplicated sequence number", () => {
    const entries = buildChain(MIXED_CHAIN);
    // Two writers raced and both used sequence 3.
    const withDuplicate = [...entries, { ...entries[2]!, id: "entry-duplicate" }];

    const result = verifyLedgerChain(withDuplicate);

    expect(result.isValid).toBe(false);
    expect(result.failure).toBe("duplicate_sequence_number");
    expect(result.duplicateSequenceNumber).toBe(3);
  });

  it("accepts entries given out of order, because it sorts by sequence first", () => {
    const entries = buildChain(MIXED_CHAIN);
    const shuffled = [entries[3]!, entries[0]!, entries[4]!, entries[1]!, entries[2]!];

    expect(verifyLedgerChain(shuffled).isValid).toBe(true);
  });

  it("stays exact across a long sequence with no rounding drift", () => {
    const specs: EntrySpec[] = [];
    for (let index = 0; index < 5000; index += 1) {
      specs.push({
        entryType: index % 2 === 0 ? "invoice_posted" : "payment_received",
        amountCentavos: (index % 7) + 1,
      });
    }
    const chain = buildChain(specs);
    const result = verifyLedgerChain(chain);

    expect(result.isValid).toBe(true);
    for (const entry of chain) {
      expect(Number.isInteger(entry.runningBalanceCentavos)).toBe(true);
    }
  });
});

describe("computeRunningBalanceCentavos", () => {
  it("adds for every debit type", () => {
    const debitTypes: LedgerEntryType[] = [
      "invoice_posted",
      "late_fee",
      "manual_debit",
      "payment_reversal",
      "advance_credit_applied",
    ];

    for (const entryType of debitTypes) {
      expect(computeRunningBalanceCentavos(1000, entryType, 250)).toBe(1250);
    }
  });

  it("subtracts for every credit type", () => {
    const creditTypes: LedgerEntryType[] = [
      "payment_received",
      "invoice_void",
      "advance_credit",
      "manual_credit",
      "write_off",
    ];

    for (const entryType of creditTypes) {
      expect(computeRunningBalanceCentavos(1000, entryType, 250)).toBe(750);
    }
  });
});
