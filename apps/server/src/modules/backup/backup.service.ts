// Backup and restore as an application feature (S5-3, S8-3, S12-9).
//
// The pg_dump/pg_restore argument handling already lives in scripts/backup.sh and
// scripts/restore.sh, and those scripts are tested and shipped. This module does
// NOT reimplement them: it runs them, then applies the checks the application must
// own —
//
//   • a produced archive is VERIFIED (size, gzip integrity, decompressed size,
//     sha256 checksum) before it is published to backup_history;
//   • a restore re-verifies the archive and REFUSES an unverified or corrupt one,
//     so the live database is never overwritten from a bad file;
//   • a restore never runs without an explicit confirmation argument.
//
// Every backup and restore writes a row to `backup_history` (S1-8).

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";

import { desc, eq } from "drizzle-orm";

import { childProcessEnvironment, config } from "../../config";
import { db } from "../../db/connection";
import { backupHistory, type BackupHistoryEntry } from "../../db/schema/system";
import { users } from "../../db/schema/users";
import { AppError, ConflictError, NotFoundError } from "../../shared/errors";

/**
 * The repository root, resolved from this file rather than the process working
 * directory, so the shell scripts are found no matter where the server was started.
 */
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(moduleDirectory, "../../../../..");
const backupScriptPath = path.join(repositoryRoot, "scripts", "backup.sh");
const restoreScriptPath = path.join(repositoryRoot, "scripts", "restore.sh");

/** The directory backups are written to; BACKUP_DIR resolves against the repo root. */
function backupDirectory(): string {
  return path.resolve(repositoryRoot, config.BACKUP_DIR);
}

/**
 * Resolves a recorded backup file name to an absolute path, refusing anything that
 * escapes the backup directory. A hostile `backup_history` row (e.g.
 * `../../etc/passwd`) must never be read or fed to pg_restore.
 */
function resolveBackupPath(fileName: string): string {
  const directory = backupDirectory();
  const absolutePath = path.resolve(directory, fileName);
  const relative = path.relative(directory, absolutePath);

  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ConflictError(`Backup file name escapes the backup directory: ${fileName}`);
  }

  return absolutePath;
}

/**
 * The smallest file that can still be a real dump. backup.sh uses the same
 * threshold: an empty gzip is only ~20 bytes and still passes `gzip -t`, so a
 * crashed dump would otherwise look valid.
 */
const MINIMUM_PLAUSIBLE_BACKUP_BYTES = 100;

/**
 * The largest archive the verifier will touch. The check streams, so memory stays
 * bounded, but a hard cap still refuses an absurd file rather than churning CPU on
 * it. A real office dump is far below this.
 */
const MAX_BACKUP_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024;

export interface ArchiveVerification {
  ok: boolean;
  /** Why verification failed; absent when `ok` is true. */
  reason?: string;
  sizeBytes?: number;
  checksum?: string;
  decompressedBytes?: number;
}

/**
 * Verifies a backup archive on disk without ever holding the whole file in memory:
 * the sha256 is streamed and gzip integrity is checked by streaming the archive
 * through `zlib.createGunzip`. Pure with respect to the database.
 *
 * `expectations` lets the caller pin a previously recorded size and checksum, so a
 * file edited after it was recorded is rejected rather than silently restored.
 */
export async function verifyBackupArchive(
  absolutePath: string,
  expectations: { sizeBytes?: number; checksum?: string } = {}
): Promise<ArchiveVerification> {
  let sizeBytes: number;
  try {
    sizeBytes = statSync(absolutePath).size;
  } catch {
    return { ok: false, reason: "The backup file does not exist" };
  }

  if (sizeBytes < MINIMUM_PLAUSIBLE_BACKUP_BYTES) {
    return { ok: false, reason: "The backup file is too small to be a real dump" };
  }

  if (expectations.sizeBytes !== undefined && expectations.sizeBytes !== sizeBytes) {
    return { ok: false, reason: "The backup file size does not match the recorded size" };
  }

  if (sizeBytes > MAX_BACKUP_ARCHIVE_BYTES) {
    return { ok: false, reason: "The backup file is too large to verify safely" };
  }

  // Check the gzip magic bytes before decompressing, so a non-archive gets a
  // precise reason rather than a gunzip error.
  const magicBytes = await readFirstBytes(absolutePath, 2);
  if (magicBytes.length < 2 || magicBytes[0] !== 0x1f || magicBytes[1] !== 0x8b) {
    return { ok: false, reason: "The backup file is not a gzip archive" };
  }

  const checksum = createHash("sha256");
  let decompressedBytes = 0;

  try {
    await pipeline(
      createReadStream(absolutePath),
      // Hash the raw (compressed) bytes as they stream past, then hand them on.
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          checksum.update(chunk);
          callback(null, chunk);
        },
      }),
      createGunzip(),
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          decompressedBytes += chunk.length;
          callback();
        },
      })
    );
  } catch {
    return { ok: false, reason: "The backup file is not a readable gzip archive" };
  }

  if (decompressedBytes === 0) {
    return { ok: false, reason: "The backup file decompresses to zero bytes" };
  }

  const digest = checksum.digest("hex");
  if (expectations.checksum !== undefined && expectations.checksum !== digest) {
    return { ok: false, reason: "The backup file checksum does not match the recorded checksum" };
  }

  return { ok: true, sizeBytes, checksum: digest, decompressedBytes };
}

/** Reads just the first `count` bytes, so the magic-byte check needs no full read. */
async function readFirstBytes(absolutePath: string, count: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    const stream = createReadStream(absolutePath, { start: 0, end: count - 1 });
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

export interface ScriptResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Runs a shipped shell script. Injectable so tests need not spawn processes. */
export type ScriptRunner = (
  scriptPath: string,
  args: string[],
  extraEnv: Record<string, string>,
  stdinText?: string
) => Promise<ScriptResult>;

/** The production runner: `bash <script> <args...>` with the given environment and stdin. */
const runShellScript: ScriptRunner = (scriptPath, args, extraEnv, stdinText) => {
  return new Promise<ScriptResult>((resolve, reject) => {
    const child = spawn("bash", [scriptPath, ...args], {
      env: childProcessEnvironment(extraEnv),
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));

    if (stdinText !== undefined) {
      child.stdin.end(stdinText);
    }
  });
};

/** The newest `bcis_backup_*.sql.gz` in a directory, or undefined when none exists. */
function findNewestBackupFile(directory: string): string | undefined {
  let fileNames: string[];
  try {
    fileNames = readdirSync(directory);
  } catch {
    return undefined;
  }

  const candidates = fileNames
    .filter((fileName) => /^bcis_backup_.*\.sql\.gz$/.test(fileName))
    .map((fileName) => ({
      fileName,
      modifiedAtMs: statSync(path.join(directory, fileName)).mtimeMs,
    }))
    .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);

  return candidates[0]?.fileName;
}

/**
 * Automatically registers any physical archives found in `backups/` that are not
 * yet present in `backup_history`. This ensures backups taken via CLI or retained
 * across database resets are always discoverable and restorable in the UI.
 */
async function syncBackupsFromDisk(): Promise<void> {
  if (process.env.NODE_ENV === "test") {
    return;
  }

  const directory = backupDirectory();
  let fileNames: string[];
  try {
    fileNames = readdirSync(directory);
  } catch {
    return;
  }

  const backupFiles = fileNames.filter((fileName) => /^bcis_backup_.*\.sql\.gz$/.test(fileName));
  if (backupFiles.length === 0) {
    return;
  }

  try {
    const existing = await db.select({ filename: backupHistory.filename }).from(backupHistory);
    const recorded = new Set(existing.map((row) => row.filename));

    for (const fileName of backupFiles) {
      if (!recorded.has(fileName)) {
        const fullPath = path.join(directory, fileName);
        const verification = await verifyBackupArchive(fullPath).catch(() => null);
        if (verification?.ok && verification.sizeBytes !== undefined && verification.checksum !== undefined) {
          const stats = statSync(fullPath);
          await db
            .insert(backupHistory)
            .values({
              filename: fileName,
              sizeBytes: verification.sizeBytes,
              checksum: verification.checksum,
              checksumAlgorithm: "sha256",
              createdBy: null,
              createdAt: new Date(stats.mtimeMs),
              verifiedAt: new Date(),
              notes: "Discovered archive on disk",
            })
            .catch(() => undefined);
        }
      }
    }
  } catch {
    // Ignore query errors in unconventional or transitional states
  }
}

/** Every recorded backup, newest first. */
export async function listBackups(): Promise<BackupHistoryEntry[]> {
  await syncBackupsFromDisk().catch(() => {});
  return db.select().from(backupHistory).orderBy(desc(backupHistory.createdAt));
}

/**
 * Creates a backup by running scripts/backup.sh, verifies the produced archive,
 * and records it in `backup_history`. A verification failure is loud and the
 * archive is NOT recorded as verified.
 */
export async function createBackup(
  createdBy: string,
  runner: ScriptRunner = runShellScript
): Promise<BackupHistoryEntry> {
  const directory = backupDirectory();

  const result = await runner(backupScriptPath, [], { BCIS_BACKUP_DIR: directory });
  if (result.code !== 0) {
    throw new AppError(
      `Backup failed: ${result.stderr.trim() || "the backup script exited with an error"}`,
      500,
      "INTERNAL_ERROR"
    );
  }

  const fileName = findNewestBackupFile(directory);
  if (fileName === undefined) {
    throw new AppError("Backup failed: the backup script produced no archive", 500, "INTERNAL_ERROR");
  }

  const verification = await verifyBackupArchive(path.join(directory, fileName));
  if (!verification.ok || verification.sizeBytes === undefined || verification.checksum === undefined) {
    throw new AppError(
      `Backup failed verification and was not recorded: ${verification.reason ?? "unknown reason"}`,
      500,
      "INTERNAL_ERROR"
    );
  }

  const recorded = await db
    .insert(backupHistory)
    .values({
      filename: fileName,
      sizeBytes: verification.sizeBytes,
      checksum: verification.checksum,
      checksumAlgorithm: "sha256",
      createdBy,
      verifiedAt: new Date(),
      notes: "Created and verified by the application",
    })
    .returning()
    .then((rows) => rows[0]);

  if (recorded === undefined) {
    throw new AppError("Backup was created but could not be recorded", 500, "INTERNAL_ERROR");
  }

  return recorded;
}

/** Loads one recorded backup or throws NotFoundError. */
async function requireBackupEntry(backupId: string): Promise<BackupHistoryEntry> {
  const entry = await db
    .select()
    .from(backupHistory)
    .where(eq(backupHistory.id, backupId))
    .limit(1)
    .then((rows) => rows[0]);

  if (entry === undefined) {
    throw new NotFoundError("Backup not found");
  }

  return entry;
}

/**
 * Re-checks a recorded backup against its size and checksum and stamps
 * `verified_at`. A mismatch is a conflict, clears `verified_at` and records the
 * reason in `notes`, so a row can never claim a verification that no longer holds.
 */
export async function verifyBackup(backupId: string): Promise<BackupHistoryEntry> {
  const entry = await requireBackupEntry(backupId);
  const absolutePath = resolveBackupPath(entry.filename);

  const verification = await verifyBackupArchive(absolutePath, {
    sizeBytes: entry.sizeBytes,
    checksum: entry.checksum,
  });

  if (!verification.ok) {
    const reason = verification.reason ?? "unknown reason";

    // A row must never keep advertising a verification that no longer holds. If the
    // archive has been corrupted or replaced since it was recorded, clear the stamp
    // and record WHY, so an operator reading the list sees the archive is unverified
    // and what failed instead of a stale `verified_at`. Keeping the failure reason in
    // `notes` answers "unverified, but why?" without a schema change.
    await db
      .update(backupHistory)
      .set({ verifiedAt: null, notes: `Verification failed: ${reason}` })
      .where(eq(backupHistory.id, backupId));

    throw new ConflictError(`Backup verification failed: ${reason}`);
  }

  const verified = await db
    .update(backupHistory)
    .set({ verifiedAt: new Date() })
    .where(eq(backupHistory.id, backupId))
    .returning()
    .then((rows) => rows[0]);

  if (verified === undefined) {
    throw new NotFoundError("Backup not found");
  }

  return verified;
}

/**
 * Restores the database from a recorded backup.
 *
 * Refuses an unverified archive and refuses one that fails a live size/checksum
 * check, so a corrupt or tampered file can never overwrite the database. The
 * confirmation is supplied as the restore script's stdin ("yes"), which is only
 * reached after the caller passed the route's explicit confirmation argument.
 */
export async function restoreBackup(
  backupId: string,
  runner: ScriptRunner = runShellScript
): Promise<BackupHistoryEntry> {
  const entry = await requireBackupEntry(backupId);

  if (entry.verifiedAt === null) {
    throw new ConflictError(
      "This backup has not been verified; verify it before restoring so a corrupt archive cannot overwrite the database"
    );
  }

  const absolutePath = resolveBackupPath(entry.filename);
  const verification = await verifyBackupArchive(absolutePath, {
    sizeBytes: entry.sizeBytes,
    checksum: entry.checksum,
  });

  if (!verification.ok) {
    throw new ConflictError(
      `Refusing to restore: ${verification.reason ?? "the archive failed verification"}. The database was not changed.`
    );
  }

  // Preserve existing backup_history rows so that when pg_restore wipes public schema,
  // this backup (and any other backups on disk) remain cataloged and verifiable.
  let priorEntries: BackupHistoryEntry[] = [];
  try {
    priorEntries = await db.select().from(backupHistory);
  } catch {
    priorEntries = [entry];
  }

  const result = await runner(restoreScriptPath, [absolutePath], { DATABASE_URL: config.DATABASE_URL }, "yes\n");
  if (result.code !== 0) {
    throw new AppError(
      `Restore failed: ${result.stderr.trim() || "the restore script exited with an error"}`,
      500,
      "INTERNAL_ERROR"
    );
  }

  const now = new Date();
  const restored = await db
    .update(backupHistory)
    .set({ restoreTestedAt: now })
    .where(eq(backupHistory.id, backupId))
    .returning()
    .then((rows) => rows[0])
    .catch(() => undefined);

  if (restored !== undefined) {
    return restored;
  }

  // In real PostgreSQL, pg_restore drops and restores public schema with the archive's snapshot.
  // Because the archive was produced before entry was recorded, entry.id does not exist
  // in the restored table. Re-insert priorEntries so this backup and its restore timestamp persist.
  try {
    const existingUsers = await db.select({ id: users.id }).from(users).catch(() => []);
    const validUserIds = new Set(existingUsers.map((u) => u.id));

    for (const prior of priorEntries) {
      const isCurrentBackup = prior.id === backupId;
      const restoreDate = isCurrentBackup ? now : prior.restoreTestedAt;
      const createdBy = prior.createdBy && validUserIds.has(prior.createdBy) ? prior.createdBy : null;

      await db
        .insert(backupHistory)
        .values({
          id: prior.id,
          filename: prior.filename,
          sizeBytes: prior.sizeBytes,
          checksum: prior.checksum,
          checksumAlgorithm: prior.checksumAlgorithm,
          createdBy,
          createdAt: prior.createdAt,
          verifiedAt: prior.verifiedAt,
          restoreTestedAt: restoreDate,
          notes: prior.notes,
        })
        .catch(() => undefined);
    }
  } catch {
    // Ignore insertion errors
  }

  const reloaded = await db
    .select()
    .from(backupHistory)
    .where(eq(backupHistory.id, backupId))
    .limit(1)
    .then((rows) => rows[0])
    .catch(() => undefined);

  return (
    reloaded ?? {
      ...entry,
      restoreTestedAt: now,
    }
  );
}
