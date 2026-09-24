// Test-only cleanup for the append-only audit trail.
//
// The `audit_logs` table carries a database trigger that refuses an UPDATE or a
// DELETE, because in the running system an audit row is permanent. A database-
// backed test, however, must remove the rows it created before it can delete the
// users those rows reference (the `performed_by` foreign key).
//
// This helper is the one deliberate escape hatch: it disables the trigger for the
// single cleanup statement and turns it straight back on. The application never
// does this — a dedicated test proves the trigger blocks an ordinary DELETE.

import type { Pool } from "pg";

/** Removes audit rows performed by the given users so those users can be deleted. */
export async function deleteAuditLogsForUsers(pool: Pool, userIds: string[]): Promise<void> {
  if (userIds.length === 0) {
    return;
  }

  await pool.query("ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only");
  try {
    await pool.query("DELETE FROM audit_logs WHERE performed_by = ANY($1::uuid[])", [userIds]);
  } finally {
    await pool.query("ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only");
  }
}
