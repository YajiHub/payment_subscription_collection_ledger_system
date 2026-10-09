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

/**
 * Foreign keys to `users` that cleanup must NOT clear, because another documented
 * path already removes the rows that hold them. `audit_logs` refuses UPDATE outright
 * (`audit_logs_append_only`), and its rows for demo users go through
 * `deleteAuditLogsForUsers`; `login_audit_log` rows are deleted by `user_id` below.
 */
const USER_REFERENCES_HANDLED_ELSEWHERE = [
  "audit_logs.performed_by",
  "login_audit_log.user_id",
] as const;

/**
 * Nulls every nullable reference to a demo user, so the final `DELETE FROM users` is
 * not refused by a foreign key.
 *
 * The rows holding these pointers are not the demo dataset's to delete: `backup_history`
 * is global, and a real subscriber can carry `updated_by` naming a demo operator. A
 * single such row used to leave the dataset half-removed — the users survived with
 * their grants already deleted — and the whole-database invariants in
 * `wp1-schema.postgres.test.ts` then failed with an unrelated "missing its mapped role"
 * message. Clearing the pointer keeps the row and removes the blockage.
 *
 * A NOT NULL reference is deliberately left alone: the row that owns one is demo data
 * already removed above, so a surviving one is a genuine anomaly and should fail
 * loudly rather than be papered over.
 */
async function detachUserReferences(userIds: readonly string[]): Promise<void> {
  await assertUserReferencesHandled();

  const clear = (sql: string): Promise<unknown> => pool.query(sql, [userIds]);

  await clear("UPDATE backup_history SET created_by = NULL WHERE created_by = ANY($1::uuid[])");
  await clear("UPDATE batch_assignments SET voided_by = NULL WHERE voided_by = ANY($1::uuid[])");
  await clear(
    "UPDATE collector_batches SET cancelled_by = NULL WHERE cancelled_by = ANY($1::uuid[])"
  );
  await clear(
    "UPDATE collector_batches SET closed_by = NULL WHERE closed_by = ANY($1::uuid[])"
  );
  await clear(
    "UPDATE collector_batches SET reconciled_by = NULL WHERE reconciled_by = ANY($1::uuid[])"
  );
  await clear(
    "UPDATE gcash_payments SET verified_by = NULL WHERE verified_by = ANY($1::uuid[])"
  );
  await clear(
    "UPDATE gcash_payments SET rejected_by = NULL WHERE rejected_by = ANY($1::uuid[])"
  );
  await clear("UPDATE invoices SET posted_by = NULL WHERE posted_by = ANY($1::uuid[])");
  await clear("UPDATE invoices SET voided_by = NULL WHERE voided_by = ANY($1::uuid[])");
  await clear("UPDATE payments SET reversed_by = NULL WHERE reversed_by = ANY($1::uuid[])");
  await clear(
    "UPDATE reconnection_records SET technician_id = NULL WHERE technician_id = ANY($1::uuid[])"
  );
  await clear(
    "UPDATE suspension_records SET technician_id = NULL WHERE technician_id = ANY($1::uuid[])"
  );
  await clear("UPDATE role_permissions SET granted_by = NULL WHERE granted_by = ANY($1::uuid[])");
  await clear(
    "UPDATE service_accounts SET assigned_collector_id = NULL WHERE assigned_collector_id = ANY($1::uuid[])"
  );
  await clear(
    "UPDATE subscriber_addresses SET updated_by = NULL WHERE updated_by = ANY($1::uuid[])"
  );
  await clear("UPDATE subscribers SET updated_by = NULL WHERE updated_by = ANY($1::uuid[])");
  await clear("UPDATE system_settings SET updated_by = NULL WHERE updated_by = ANY($1::uuid[])");
  await clear("UPDATE user_roles SET assigned_by = NULL WHERE assigned_by = ANY($1::uuid[])");
}

/**
 * Fails loudly when a later migration adds a nullable reference to `users` that this
 * helper has not been taught about. Without this the cleanup would fail with a bare
 * foreign key error that hides which table caused it.
 */
async function assertUserReferencesHandled(): Promise<void> {
  const handled = [
    "backup_history.created_by",
    "batch_assignments.voided_by",
    "collector_batches.cancelled_by",
    "collector_batches.closed_by",
    "collector_batches.reconciled_by",
    "gcash_payments.verified_by",
    "gcash_payments.rejected_by",
    "invoices.posted_by",
    "invoices.voided_by",
    "payments.reversed_by",
    "reconnection_records.technician_id",
    "suspension_records.technician_id",
    "role_permissions.granted_by",
    "service_accounts.assigned_collector_id",
    "subscriber_addresses.updated_by",
    "subscribers.updated_by",
    "system_settings.updated_by",
    "user_roles.assigned_by",
    ...USER_REFERENCES_HANDLED_ELSEWHERE,
  ];

  const result = await pool.query<{ reference: string }>(
    `SELECT tc.table_name || '.' || kcu.column_name AS reference
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
        AND kcu.table_schema = tc.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
       JOIN information_schema.columns col
         ON col.table_schema = tc.table_schema
        AND col.table_name = tc.table_name
        AND col.column_name = kcu.column_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND ccu.table_name = 'users'
        AND ccu.column_name = 'id'
        AND col.is_nullable = 'YES'
        AND NOT (tc.table_name || '.' || kcu.column_name) = ANY($1::text[])`,
    [handled]
  );

  const unhandled = result.rows.map((row) => row.reference);
  if (unhandled.length > 0) {
    throw new Error(
      `Demo cleanup does not know how to clear these references to a demo user: ${unhandled.join(
        ", "
      )}. Add each to the statements in detachUserReferences, or to ` +
        "USER_REFERENCES_HANDLED_ELSEWHERE when another documented path removes the rows that hold it."
    );
  }
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
  // Rows this helper does not own can still name a demo user. Clearing those
  // pointers keeps the delete below from being refused by a foreign key, which
  // would leave the dataset half-removed and then fail the whole-database
  // invariants in `wp1-schema.postgres.test.ts` with an unrelated message.
  await detachUserReferences(userIds);
  await run("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
}
