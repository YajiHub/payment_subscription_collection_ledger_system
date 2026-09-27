// Test-only removal of ledger fixture rows.
//
// `ledger_entries` is append-only: migration 0011 installs a trigger that raises
// on any UPDATE or DELETE, and the whole point of that trigger is that no code
// path can erase financial history. The PostgreSQL suites still build a throwaway
// subscriber, service account and invoice for each case, and their ledger rows
// must go before the next run: `phase9-invariants.postgres.test.ts` asserts
// whole-database invariants (allocation sums, paid amounts, ledger chains), and
// leftover half-cleaned fixtures make those assertions meaningless.
//
// So the removal goes through the one door that exists for a table owner: the
// trigger is disabled and re-enabled inside a single transaction. No window is
// left open, a failure rolls both statements back, and nothing in application
// code or in a migration does this.
//
// This helper is the ONLY place in the repository that deletes a ledger row. If
// a production code path ever needs it, that is a design bug, not a use case.

import { pool } from "../../src/db/connection";

/** Deletes the ledger rows of the given service accounts. Test fixtures only. */
export async function deleteLedgerEntriesForServiceAccounts(
  serviceAccountIds: readonly string[]
): Promise<void> {
  if (serviceAccountIds.length === 0) {
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query('ALTER TABLE "ledger_entries" DISABLE TRIGGER "ledger_entries_append_only"');
    await client.query("DELETE FROM ledger_entries WHERE service_account_id = ANY($1::uuid[])", [
      serviceAccountIds,
    ]);
    await client.query('ALTER TABLE "ledger_entries" ENABLE TRIGGER "ledger_entries_append_only"');
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
