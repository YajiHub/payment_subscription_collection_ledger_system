// Seeds a SYNTHETIC demo dataset, for the section 11.1 live demonstration.
//
// This is deliberately separate from `seed.ts`, which stays the production
// bootstrap (default settings + one Administrator) and is never modified by this
// script. The demo generator is only run when somebody explicitly asks for it:
//
//   pnpm db:seed:demo                 # into a fresh / demo-only database
//   pnpm db:seed:demo --seed=42       # a different, still deterministic dataset
//   pnpm db:seed:demo --confirm       # also when the database already holds non-demo data
//
// Every row it writes is obviously synthetic (names say "(DEMO)", phones use the
// reserved-looking 0900 prefix, GCash references start with DEMOGCASH-), it is
// deterministic from its seed, and it refuses to run against a database that
// already holds real subscribers unless `--confirm` is given.
//
// Run with:  pnpm db:seed:demo     (from the repository root)

import { fileURLToPath } from "node:url";
import path from "node:path";

import { config } from "../config";
import { closeDatabaseConnection } from "./connection";
import {
  DemoDatasetConflictError,
  generateDemoDataset,
  type DemoDatasetSummary,
} from "./demo/demo-dataset";
import { DEMO_PASSWORD, DEMO_USERS } from "./demo/synthetic-catalog";

interface DemoScriptArguments {
  seed?: number;
  confirmed: boolean;
}

/** Reads the script's own arguments. Environment variables are never read here. */
function parseArguments(argv: readonly string[]): DemoScriptArguments {
  const parsed: DemoScriptArguments = { confirmed: false };

  for (const argument of argv) {
    if (argument === "--confirm") {
      parsed.confirmed = true;
      continue;
    }

    if (argument.startsWith("--seed=")) {
      const rawSeed = argument.slice("--seed=".length);
      const seed = Number.parseInt(rawSeed, 10);
      if (!Number.isInteger(seed)) {
        throw new Error(`--seed expects a whole number, received "${rawSeed}"`);
      }
      parsed.seed = seed;
    }
  }

  return parsed;
}

/** Prints the counts against each section 8 minimum. */
function printSummary(summary: DemoDatasetSummary): void {
  const { counts, totals } = summary;

  console.log("");
  console.log(`Demo dataset seeded (seed ${summary.seed}, anchored to ${summary.referenceDate}).`);
  console.log("");
  console.log("Section 8 minimum                     Required        Generated");
  console.log("────────────────────────────────────  ──────────────  ──────────────");
  const rows: Array<[string, string, number]> = [
    ["Users (5 categories covered)", "5+", counts.users],
    ["Plans", "7 (3+2+2)", counts.plans],
    ["  Internet plans", "3", counts.internetPlans],
    ["  Cable TV plans", "2", counts.cablePlans],
    ["  Combo plans", "2", counts.comboPlans],
    ["Collectors", "2", counts.collectors],
    ["Collection areas", "3", counts.areas],
    ["Subscribers", "50", counts.subscribers],
    ["Service accounts", "60+", counts.serviceAccounts],
    ["  Internet accounts", "—", counts.internetAccounts],
    ["  Cable TV accounts", "—", counts.cableAccounts],
    ["  Combo accounts", "—", counts.comboAccounts],
    ["Billing months", "3+", counts.billingMonths],
    ["Invoices", "—", counts.invoices],
    ["Payments", "mixed", counts.payments],
    ["  Cash payments", "1+", counts.cashPayments],
    ["  GCash payments", "1+", counts.gcashPayments],
    ["    verified", "1+", counts.verifiedGcashPayments],
    ["    pending", "0+", counts.pendingGcashPayments],
    ["    rejected", "0+", counts.rejectedGcashPayments],
    ["  Partial payments", "1+", counts.partialPayments],
    ["  Advance-credit payments", "1+", counts.advanceCreditPayments],
    ["Overdue accounts", "10+", counts.overdueAccounts],
    ["Reversed payments", "1+", counts.reversedPayments],
    ["Suspension records", "2+", counts.suspensionRecords],
    ["Reconnection records", "2+", counts.reconnectionRecords],
    ["Collector batches", "1+", counts.collectorBatches],
  ];

  for (const [label, required, generated] of rows) {
    console.log(`${label.padEnd(36)}  ${required.padEnd(14)}  ${String(generated)}`);
  }

  console.log("");
  console.log(`Invoiced:    PHP ${(totals.invoicedCentavos / 100).toFixed(2)}`);
  console.log(`Collected:   PHP ${(totals.collectedCentavos / 100).toFixed(2)}`);
  console.log(`Outstanding: PHP ${(totals.outstandingCentavos / 100).toFixed(2)}`);
  console.log(`Ledger net:  PHP ${(totals.ledgerNetCentavos / 100).toFixed(2)}`);
  console.log("");
  console.log("Demo logins (username / shared password):");
  for (const user of DEMO_USERS) {
    console.log(`  ${user.username.padEnd(22)} ${DEMO_PASSWORD}   ${user.fullName}`);
  }
  console.log("");
  console.log("All of this data is synthetic. Do not use it in a real office database.");
}

const isEntryPoint =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isEntryPoint) {
  void (async () => {
    const options = parseArguments(process.argv.slice(2));
    // A plain string split, not `new URL()`: the database name is only printed,
    // and a malformed URL must not throw before the guard gets a chance to run.
    const target = config.DATABASE_URL.replace(/^.*\//, "").split("?")[0];
    console.log(`Seeding the demo dataset into database "${target}"…`);

    const summary = await generateDemoDataset({
      seed: options.seed,
      confirmed: options.confirmed,
    });
    printSummary(summary);
  })()
    .catch((error: unknown) => {
      if (error instanceof DemoDatasetConflictError) {
        console.error(`Refused: ${error.message}`);
      } else {
        console.error("Demo seeding failed:", error instanceof Error ? error.message : error);
      }
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeDatabaseConnection();
    });
}
