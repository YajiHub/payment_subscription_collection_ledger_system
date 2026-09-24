// Guardrails for the two rules that keep field collections trustworthy.
//
// 1. No deletion. A recorded collection and a batch are never removed: a mistake is
//    voided (which reverses the payment) or the batch is cancelled. No production
//    source file may DELETE from the collector_batches or batch_assignments tables,
//    and no route may expose an HTTP DELETE. This scan fails the moment such a
//    statement is introduced anywhere in apps/server/src.
// 2. Integer centavos. The collections schema declares only integer money columns;
//    no `numeric`, `real`, or `double precision` column may appear.

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

describe("collections are never destructively deleted", () => {
  it("never emits a DELETE against a collector batch or an assignment", () => {
    const offenders: string[] = [];
    const deletionPattern = /\.delete\s*\(\s*(?:collectorBatches|batchAssignments)\b/;

    for (const file of listSourceFiles(sourceRoot)) {
      if (deletionPattern.test(readFileSync(file, "utf8"))) {
        offenders.push(path.relative(sourceRoot, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("exposes no HTTP DELETE route for collector batches", () => {
    const routes = readFileSync(
      path.join(sourceRoot, "modules/collections/collector-batches.routes.ts"),
      "utf8"
    );

    expect(routes).not.toMatch(/server\.delete\(/);
  });

  it("keeps the collections service free of any delete call", () => {
    const service = readFileSync(
      path.join(sourceRoot, "modules/collections/collector-batches.service.ts"),
      "utf8"
    );

    expect(service).not.toMatch(/\.delete\(/);
  });
});

describe("collection money is integer centavos", () => {
  const collectionsSchema = readFileSync(
    path.resolve(sourceRoot, "db/schema/collections.ts"),
    "utf8"
  );

  it("declares every money column as an integer", () => {
    expect(collectionsSchema).toMatch(
      /expectedRemittanceCentavos:\s*integer\("expected_remittance_centavos"\)/
    );
    expect(collectionsSchema).toMatch(
      /actualRemittanceCentavos:\s*integer\("actual_remittance_centavos"\)/
    );
    expect(collectionsSchema).toMatch(/varianceCentavos:\s*integer\("variance_centavos"\)/);
    expect(collectionsSchema).toMatch(
      /collectedAmountCentavos:\s*integer\("collected_amount_centavos"\)/
    );
  });

  it("uses no floating-point column type anywhere in the schema", () => {
    expect(collectionsSchema).not.toMatch(/\b(?:numeric|real|doublePrecision|float)\b/);
  });
});