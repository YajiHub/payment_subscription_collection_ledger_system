// System settings: the configurable business rules, stored as text key/value rows.
//
// A value is text because a setting may be a number, an address, or a sentence.
// The code that reads a numeric setting parses it explicitly (see
// `parseIntSetting` in the shared package), so a hand-edited row can never leak a
// `NaN` into a calculation.
//
// `updated_by` records who last changed a setting; the change itself is also
// written to the audit trail.

import { bigint, index, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import { users } from "./users";

export const systemSettings = pgTable("system_settings", {
  key: varchar("key", { length: 100 }).primaryKey(),
  value: text("value").notNull(),
  description: text("description").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => users.id),
});

export type SystemSetting = typeof systemSettings.$inferSelect;
export type NewSystemSetting = typeof systemSettings.$inferInsert;

// ─── Backup History ───────────────────────────────────────────────────────────
// S1-8: one row per backup the application creates or restores.
//
// Backups used to exist only as files and shell output, so the system could not
// answer "which backup is verified and safe to restore?". Every application
// backup now appends a row here; `verified_at` records a successful integrity
// check and `restore_tested_at` records a restore that was actually rehearsed.
//
// Rows are never updated in place to correct history — a new backup is a new row.
// `created_by` is nullable because a scheduled backup has no actor, matching the
// convention on audit_logs.performed_by.
export const backupHistory = pgTable(
  "backup_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // File name (not a full path) of the archive, e.g. bcis_db-20250115-0300.dump.
    filename: varchar("filename", { length: 255 }).notNull(),

    // Archive size in bytes. bigint: a dump of a large database exceeds 2 GB.
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),

    // Integrity digest of the archive as stored on disk.
    checksum: varchar("checksum", { length: 128 }).notNull(),
    checksumAlgorithm: varchar("checksum_algorithm", { length: 20 }).notNull().default("sha256"),

    // Who ran the backup. Null for a scheduled or system backup.
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    // Set when the archive passed an integrity check; null while unverified.
    verifiedAt: timestamp("verified_at", { withTimezone: true }),

    // Set when a restore of this archive was rehearsed successfully.
    restoreTestedAt: timestamp("restore_tested_at", { withTimezone: true }),

    notes: text("notes"),
  },
  (table) => [
    // The backup list is ordered by recency; the filename lookup finds one archive.
    index("backup_history_created_at_idx").on(table.createdAt),
    index("backup_history_filename_idx").on(table.filename),
  ]
);

export type BackupHistoryEntry = typeof backupHistory.$inferSelect;
export type NewBackupHistoryEntry = typeof backupHistory.$inferInsert;
