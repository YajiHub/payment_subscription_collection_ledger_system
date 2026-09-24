// Guardrails for the two rules that make the ledger trustworthy.
//
// 1. Append-only. No production source file may UPDATE or DELETE the ledger table.
//    Corrections are new, offsetting rows. This scan fails the moment such a
//    statement is introduced anywhere in apps/server/src.
// 2. No stored balance. No subscriber or service-account table may carry a balance
//    column; the balance is always computed from the ledger.
//
// These are cheap, framework-free checks, so they run on every `pnpm test`.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

/** Every .ts source file under apps/server/src. */
function listSourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const fullPath = path.join(directory, entry);
    if (statSync(fullPath).isDirectory()) {
      return listSourceFiles(fullPath);
    }
    return entry.endsWith(".ts") ? [fullPath] : [];
  });
}

describe("ledger immutability", () => {
  it("never emits an UPDATE or DELETE against the ledger table", () => {
    const offenders: string[] = [];
    // `.update(ledgerEntries)` or `.delete(ledgerEntries)` — including a line break
    // or whitespace between the method and the table reference.
    const mutationPattern = /(?:update|delete)\s*\(\s*ledgerEntries\b/;

    for (const file of listSourceFiles(sourceRoot)) {
      if (mutationPattern.test(readFileSync(file, "utf8"))) {
        offenders.push(path.relative(sourceRoot, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("writes ledger entries only through the ledger service's inserts", () => {
    const ledgerService = readFileSync(
      path.join(sourceRoot, "modules/ledger/ledger.service.ts"),
      "utf8"
    );

    expect(ledgerService).toMatch(/insert\(ledgerEntries\)/);
    expect(ledgerService).not.toMatch(/update\(ledgerEntries\)/);
    expect(ledgerService).not.toMatch(/delete\(ledgerEntries\)/);
  });
});

describe("balance is computed, never stored", () => {
  const subscribersSchema = readFileSync(
    path.resolve(sourceRoot, "db/schema/subscribers.ts"),
    "utf8"
  );
  const ledgerSchema = readFileSync(path.resolve(sourceRoot, "db/schema/ledger.ts"), "utf8");

  it("declares no balance column on subscribers, service accounts, or plans", () => {
    // A column declaration looks like `someBalanceColumn: integer("...")`.
    const balanceColumnPattern = /^\s*\w*[Bb]alance\w*\s*:\s*(?:integer|numeric|bigint|uuid)\b/m;
    expect(balanceColumnPattern.test(subscribersSchema)).toBe(false);
  });

  it("keeps the balance on the ledger only as a running-balance cache", () => {
    expect(ledgerSchema).toMatch(/runningBalanceCentavos:\s*integer\("running_balance_centavos"\)/);
    // There is no plain, mutable `balanceCentavos` column anywhere.
    expect(ledgerSchema).not.toMatch(/^\s*balanceCentavos\s*:/m);
  });

  it("gives every ledger entry a sequence number and a unique per-account index", () => {
    expect(ledgerSchema).toMatch(/sequenceNumber:\s*integer\("sequence_number"\)/);
    expect(ledgerSchema).toMatch(/uniqueIndex\("ledger_entries_account_sequence_uq"\)/);
  });
});
