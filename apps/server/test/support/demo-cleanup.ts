// Test-only removal of a generated demo dataset.
//
// The demo generator is a seeding script: it writes, it never deletes. The
// PostgreSQL suite still has to leave `bcis_test` exactly as it found it — other
// suites assert whole-database invariants and page over the subscriber list — so
// this helper removes the rows the generator created, and only those, identified by
// the demo markers (`demo.` usernames, `DEMO-DATA` subscriber notes, `DEMO-` area
// codes, `Demo ` plan names).
//
// The ledger rows go through `deleteLedgerEntriesForServiceAccounts`, the one
// documented door for that append-only table. Nothing here is used by the
// application; this is cleanup for a test fixture, the same pattern
// `payments.postgres.test.ts` and its neighbours already use.

import { pool } from "../../src/db/connection";
import { deleteAuditLogsForUsers } from "./audit-cleanup";
import { deleteLedgerEntriesForServiceAccounts } from "./ledger-cleanup";

export interface DemoCleanupOptions {
  /** Every user id the demo created, plus the bootstrap Administrator when it was created by the run. */
  userIds: readonly string[];
  /** Delete billing runs recorded at or after this instant (the demo runs). */
  billingRunsSince: Date;
}

/** Ids of every row the demo dataset owns, gathered by its markers. */
async function loadDemoIdentifiers(): Promise<{
  subscriberIds: string[];
  serviceAccountIds: string[];
  invoiceIds: string[];
  paymentIds: string[];
  batchIds: string[];
  planIds: string[];
  areaIds: string[];
  demoUserIds: string[];
}> {
  const query = async (sql: string, params: unknown[] = []): Promise<string[]> =>
    pool.query<{ id: string }>(sql, params).then((result) => result.rows.map((row) => row.id));

  const subscriberIds = await query(
    "SELECT id FROM subscribers WHERE internal_notes LIKE 'DEMO-DATA%'"
  );
  const serviceAccountIds = await query(
    "SELECT id FROM service_accounts WHERE subscriber_id = ANY($1::uuid[])",
    [subscriberIds]
  );
  const invoiceIds = await query(
    "SELECT id FROM invoices WHERE service_account_id = ANY($1::uuid[])",
    [serviceAccountIds]
  );
  const paymentIds = await query(
    "SELECT id FROM payments WHERE service_account_id = ANY($1::uuid[])",
    [serviceAccountIds]
  );
  const demoUserIds = await query("SELECT id FROM users WHERE username LIKE 'demo.%'");
  const batchIds = await query(
    "SELECT id FROM collector_batches WHERE collector_id = ANY($1::uuid[])",
    [demoUserIds]
  );
  const planIds = await query("SELECT id FROM subscription_plans WHERE name LIKE 'Demo %'");
  const areaIds = await query("SELECT id FROM collection_areas WHERE code LIKE 'DEMO-%'");

  return {
    subscriberIds,
    serviceAccountIds,
    invoiceIds,
    paymentIds,
    batchIds,
    planIds,
    areaIds,
    demoUserIds,
  };
}

/** Removes every row the demo dataset created. Idempotent. */
export async function deleteDemoDataset(options: DemoCleanupOptions): Promise<void> {
  const ids = await loadDemoIdentifiers();

  const { subscriberIds, serviceAccountIds, invoiceIds, paymentIds, batchIds, planIds, areaIds } =
    ids;

  const run = (sql: string, params: unknown[] = []): Promise<unknown> => pool.query(sql, params);

  await run("DELETE FROM collector_remittances WHERE batch_id = ANY($1::uuid[])", [batchIds]);
  await run(
    "DELETE FROM batch_assignments WHERE batch_id = ANY($1::uuid[]) OR payment_id = ANY($2::uuid[])",
    [batchIds, paymentIds]
  );
  await run("DELETE FROM collector_batches WHERE id = ANY($1::uuid[])", [batchIds]);

  await run("DELETE FROM reconnection_records WHERE service_account_id = ANY($1::uuid[])", [
    serviceAccountIds,
  ]);
  await run("DELETE FROM suspension_records WHERE service_account_id = ANY($1::uuid[])", [
    serviceAccountIds,
  ]);
  await run("DELETE FROM service_status_history WHERE service_account_id = ANY($1::uuid[])", [
    serviceAccountIds,
  ]);

  await run("DELETE FROM payment_reversals WHERE original_payment_id = ANY($1::uuid[])", [
    paymentIds,
  ]);
  await run("DELETE FROM payment_allocations WHERE payment_id = ANY($1::uuid[])", [paymentIds]);
  await run("DELETE FROM gcash_payments WHERE payment_id = ANY($1::uuid[])", [paymentIds]);
  // The ledger references both payments and invoices, so it is cleared first. This
  // is the one documented door for the append-only ledger table.
  await deleteLedgerEntriesForServiceAccounts(serviceAccountIds);
  await run("DELETE FROM payments WHERE id = ANY($1::uuid[])", [paymentIds]);

  await run("DELETE FROM invoice_line_items WHERE invoice_id = ANY($1::uuid[])", [invoiceIds]);
  await run("DELETE FROM billing_runs WHERE ran_at >= $1", [options.billingRunsSince]);
  await run("DELETE FROM invoices WHERE id = ANY($1::uuid[])", [invoiceIds]);

  await run("DELETE FROM service_accounts WHERE id = ANY($1::uuid[])", [serviceAccountIds]);
  await run("DELETE FROM subscriber_addresses WHERE subscriber_id = ANY($1::uuid[])", [
    subscriberIds,
  ]);
  await run("DELETE FROM subscribers WHERE id = ANY($1::uuid[])", [subscriberIds]);

  await run("DELETE FROM subscription_plans WHERE id = ANY($1::uuid[])", [planIds]);
  await run("DELETE FROM collection_areas WHERE id = ANY($1::uuid[])", [areaIds]);

  const userIds = [...new Set([...options.userIds, ...ids.demoUserIds])];
  await run("DELETE FROM user_roles WHERE user_id = ANY($1::uuid[])", [userIds]);
  await run("DELETE FROM login_audit_log WHERE user_id = ANY($1::uuid[])", [userIds]);
  await run("DELETE FROM revoked_tokens WHERE user_id = ANY($1::uuid[])", [userIds]);
  // The append-only audit trigger needs its documented test-only escape hatch.
  await deleteAuditLogsForUsers(pool, userIds);
  await run("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
}
