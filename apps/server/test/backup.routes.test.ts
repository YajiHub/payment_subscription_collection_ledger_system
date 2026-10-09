// S5-3 — backup and restore as an application feature.
//
// What is proved here:
//   • the archive verifier rejects a missing file, a file too small to be a dump,
//     a non-gzip file, a truncated gzip, a tampered checksum and a wrong size;
//   • creating a backup runs scripts/backup.sh, verifies the archive, and records
//     it in backup_history with verified_at set;
//   • a restore REFUSES an unverified archive and a corrupt archive without running
//     pg_restore at all;
//   • a restore requires the explicit confirmation body and never runs without it;
//   • a successful restore passes "yes" on stdin so the shipped restore.sh proceeds.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("../src/db/connection", async () => {
  const { fakeDatabase } = await import("./support/fake-database");
  return {
    db: fakeDatabase.db,
    pool: {},
    checkDatabaseConnection: async () => ({ isReachable: true, latencyMs: 0, errorMessage: null }),
    closeDatabaseConnection: async () => {},
  };
});

import { buildServer } from "../src/index.ts";
import { backupHistory } from "../src/db/schema/system";
import {
  createBackup,
  restoreBackup,
  verifyBackup,
  verifyBackupArchive,
  type ScriptResult,
} from "../src/modules/backup/backup.service";
import { fakeDatabase } from "./support/fake-database";
import { authorizationHeader, signTestToken } from "./support/tokens";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const backupDirectory = path.join(repositoryRoot, "backups");

const scratchDirectory = path.join(tmpdir(), `bcis-backup-test-${process.pid}`);
mkdirSync(scratchDirectory, { recursive: true });
mkdirSync(backupDirectory, { recursive: true });

const writtenFiles: string[] = [];

function writeArchive(absolutePath: string, uncompressedBytes: number): { sizeBytes: number; checksum: string } {
  // Incompressible bytes, so the gzip archive is genuinely larger than the
  // "too small to be a real dump" threshold the verifier enforces.
  const contents = gzipSync(randomBytes(uncompressedBytes));
  writeFileSync(absolutePath, contents);
  writtenFiles.push(absolutePath);
  return {
    sizeBytes: contents.length,
    checksum: createHash("sha256").update(contents).digest("hex"),
  };
}

afterAll(() => {
  for (const file of writtenFiles) {
    rmSync(file, { force: true });
  }
  rmSync(scratchDirectory, { recursive: true, force: true });
});

describe("verifyBackupArchive", () => {
  it("accepts a real gzip archive and reports its size and checksum", async () => {
    const archivePath = path.join(scratchDirectory, "good.sql.gz");
    const expected = writeArchive(archivePath, 4_000);

    const result = await verifyBackupArchive(archivePath);
    expect(result.ok).toBe(true);
    expect(result.sizeBytes).toBe(expected.sizeBytes);
    expect(result.checksum).toBe(expected.checksum);
    expect(result.decompressedBytes).toBe(4_000);
  });

  // Item 10: verification STREAMS. A multi-megabyte archive must verify without the
  // verifier holding the whole file in memory (the assertion is functional: it
  // completes and reports the right size for a file far larger than a buffer we
  // would ever want to hold).
  it("streams a large archive instead of buffering it", async () => {
    const archivePath = path.join(scratchDirectory, "large.sql.gz");
    const expected = writeArchive(archivePath, 4_000_000);

    const result = await verifyBackupArchive(archivePath);
    expect(result.ok).toBe(true);
    expect(result.sizeBytes).toBe(expected.sizeBytes);
    expect(result.decompressedBytes).toBe(4_000_000);
  });

  it("rejects a file that does not exist", async () => {
    expect((await verifyBackupArchive(path.join(scratchDirectory, "nope.sql.gz"))).ok).toBe(false);
  });

  it("rejects a file too small to be a real dump", async () => {
    const archivePath = path.join(scratchDirectory, "tiny.sql.gz");
    writeFileSync(archivePath, Buffer.from("abc"));
    writtenFiles.push(archivePath);

    const result = await verifyBackupArchive(archivePath);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("too small");
  });

  it("rejects a file whose bytes are not gzip", async () => {
    const archivePath = path.join(scratchDirectory, "not-gzip.sql.gz");
    writeFileSync(archivePath, Buffer.alloc(500, 0x7a));
    writtenFiles.push(archivePath);

    const result = await verifyBackupArchive(archivePath);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not a gzip");
  });

  it("rejects a truncated gzip archive", async () => {
    const archivePath = path.join(scratchDirectory, "truncated.sql.gz");
    const expected = writeArchive(archivePath, 4_000);
    // Keep the gzip magic bytes but corrupt the stream so it cannot decompress.
    writeFileSync(archivePath, Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08]), Buffer.alloc(300, 0xff)]));
    writtenFiles.push(archivePath);

    const result = await verifyBackupArchive(archivePath, { sizeBytes: expected.sizeBytes });
    expect(result.ok).toBe(false);
  });

  it("rejects a checksum that no longer matches", async () => {
    const archivePath = path.join(scratchDirectory, "tampered.sql.gz");
    writeArchive(archivePath, 4_000);

    const result = await verifyBackupArchive(archivePath, { checksum: "0".repeat(64) });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("checksum");
  });

  it("rejects a size that no longer matches", async () => {
    const archivePath = path.join(scratchDirectory, "shrunk.sql.gz");
    writeArchive(archivePath, 4_000);

    const result = await verifyBackupArchive(archivePath, { sizeBytes: 999_999 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("size");
  });
});

/** A runner that never spawns anything and records how it was called. */
function recordingRunner(result: ScriptResult = { stdout: "", stderr: "", code: 0 }) {
  const calls: { scriptPath: string; args: string[]; extraEnv: Record<string, string>; stdinText?: string }[] = [];
  const runner = async (
    scriptPath: string,
    args: string[],
    extraEnv: Record<string, string>,
    stdinText?: string
  ): Promise<ScriptResult> => {
    calls.push({ scriptPath, args, extraEnv, stdinText });
    return result;
  };
  return { runner, calls };
}

describe("backup service", () => {
  beforeEach(() => {
    fakeDatabase.reset();
  });

  it("creates a backup, verifies it, and records it in backup_history", async () => {
    const { runner, calls } = recordingRunner();
    // The runner stands in for backup.sh: it writes the archive the script would
    // have produced, into the directory the service told it to use.
    const wrappedRunner = async (scriptPath: string, args: string[], extraEnv: Record<string, string>, stdinText?: string) => {
      const directory = extraEnv.BCIS_BACKUP_DIR ?? backupDirectory;
      writeArchive(path.join(directory, "bcis_backup_wp5_created.sql.gz"), 4_000);
      return runner(scriptPath, args, extraEnv, stdinText);
    };

    const recordedRow = {
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      filename: "bcis_backup_wp5_created.sql.gz",
      sizeBytes: 1,
      checksum: "x",
      checksumAlgorithm: "sha256",
      createdBy: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      createdAt: new Date(),
      verifiedAt: new Date(),
      restoreTestedAt: null,
      notes: null,
    };
    fakeDatabase.queueInsertRows([recordedRow]);

    const result = await createBackup(recordedRow.createdBy, wrappedRunner);

    expect(result.filename).toBe("bcis_backup_wp5_created.sql.gz");
    expect(calls[0]?.scriptPath).toContain("scripts/backup.sh");
    expect(calls[0]?.extraEnv.BCIS_BACKUP_DIR).toBe(backupDirectory);
    const inserted = fakeDatabase.insertedRows.find((row) => row.table === backupHistory)?.values as
      | Record<string, unknown>
      | undefined;
    expect(inserted).toMatchObject({ filename: "bcis_backup_wp5_created.sql.gz" });
    expect(inserted?.verifiedAt).toBeInstanceOf(Date);
  });

  // Defect: a re-verification that FAILS used to throw and leave the row's old
  // `verified_at` in place, so the row kept advertising an archive that no longer
  // verified. The stamp must be cleared and the reason recorded.
  it("clears verified_at and records the reason when a re-verification fails", async () => {
    const archivePath = path.join(backupDirectory, "bcis_backup_wp5_reverify_fail.sql.gz");
    writeArchive(archivePath, 4_000);

    const entry = {
      id: "12121212-1212-1212-1212-121212121212",
      filename: "bcis_backup_wp5_reverify_fail.sql.gz",
      // A recorded size that no longer matches the file on disk.
      sizeBytes: 999_999,
      checksum: "a".repeat(64),
      checksumAlgorithm: "sha256",
      createdBy: null,
      createdAt: new Date(),
      verifiedAt: new Date(),
      restoreTestedAt: null,
      notes: "Created and verified by the application",
    };
    fakeDatabase.queueSelectRows([entry]);

    await expect(verifyBackup(entry.id)).rejects.toThrow(/verification failed/);

    const cleared = fakeDatabase.updatedRows.find((row) => row.table === backupHistory)?.values as
      | Record<string, unknown>
      | undefined;
    expect(cleared).toMatchObject({ verifiedAt: null });
    expect(String(cleared?.notes)).toMatch(/Verification failed/);
    expect(String(cleared?.notes)).toMatch(/size/);
  });

  it("refuses to restore an archive that has not been verified, without running pg_restore", async () => {
    const { runner, calls } = recordingRunner();
    fakeDatabase.queueSelectRows([
      { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", filename: "unverified.sql.gz", verifiedAt: null },
    ]);

    await expect(restoreBackup("cccccccc-cccc-cccc-cccc-cccccccccccc", runner)).rejects.toThrow(
      /has not been verified/
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses to restore a corrupt archive and does not run pg_restore", async () => {
    const archivePath = path.join(backupDirectory, "bcis_backup_wp5_corrupt.sql.gz");
    writeArchive(archivePath, 4_000);
    const { runner, calls } = recordingRunner();

    fakeDatabase.queueSelectRows([
      {
        id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
        filename: "bcis_backup_wp5_corrupt.sql.gz",
        sizeBytes: 1,
        checksum: "f".repeat(64),
        verifiedAt: new Date(),
      },
    ]);

    await expect(restoreBackup("dddddddd-dddd-dddd-dddd-dddddddddddd", runner)).rejects.toThrow(
      /Refusing to restore/
    );
    expect(calls).toHaveLength(0);
  });

  // Item 11: a hostile backup_history row must not escape the backup directory.
  it("refuses a recorded file name that escapes the backup directory", async () => {
    const { runner, calls } = recordingRunner();
    fakeDatabase.queueSelectRows([
      {
        id: "99999999-9999-9999-9999-999999999999",
        filename: "../../etc/passwd",
        sizeBytes: 4_000,
        checksum: "a".repeat(64),
        verifiedAt: new Date(),
      },
    ]);

    await expect(restoreBackup("99999999-9999-9999-9999-999999999999", runner)).rejects.toThrow(
      /escapes the backup directory/
    );
    expect(calls).toHaveLength(0);
  });

  it("restores a verified archive by running restore.sh with an explicit confirmation", async () => {
    const archivePath = path.join(backupDirectory, "bcis_backup_wp5_restore.sql.gz");
    const archive = writeArchive(archivePath, 4_000);
    const { runner, calls } = recordingRunner();

    const entry = {
      id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      filename: "bcis_backup_wp5_restore.sql.gz",
      sizeBytes: archive.sizeBytes,
      checksum: archive.checksum,
      checksumAlgorithm: "sha256",
      createdBy: null,
      createdAt: new Date(),
      verifiedAt: new Date(),
      restoreTestedAt: null,
      notes: null,
    };
    fakeDatabase.queueSelectRows([entry]);
    fakeDatabase.queueUpdateRows([{ ...entry, restoreTestedAt: new Date() }]);

    const result = await restoreBackup(entry.id, runner);

    expect(calls[0]?.scriptPath).toContain("scripts/restore.sh");
    expect(calls[0]?.args[0]).toBe(archivePath);
    // The confirmation is what lets the shipped restore.sh proceed.
    expect(calls[0]?.stdinText).toBe("yes\n");
    expect(result.restoreTestedAt).toBeInstanceOf(Date);
  });
});

describe("backup routes", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = buildServer();
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  afterEach(() => {
    fakeDatabase.reset();
  });

  it("denies a Manager the backup list", async () => {
    const { token } = signTestToken({ role: "manager" });
    fakeDatabase.queueSelectRows([]); // authenticate

    const response = await server.inject({
      method: "GET",
      url: "/api/backups",
      headers: authorizationHeader(token),
    });

    expect(response.statusCode).toBe(403);
  });

  it("requires an explicit confirmation to restore", async () => {
    const { token } = signTestToken({ role: "admin" });
    fakeDatabase.queueSelectRows([]); // authenticate

    const response = await server.inject({
      method: "POST",
      url: `/api/backups/${"ffffffff-ffff-ffff-ffff-ffffffffffff"}/restore`,
      headers: authorizationHeader(token),
      payload: { confirm: false },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("refuses a restore of an unverified archive with a conflict", async () => {
    const { token } = signTestToken({ role: "admin" });
    fakeDatabase.queueSelectRows([]); // authenticate
    fakeDatabase.queueSelectRows([{ id: "11111111-2222-3333-4444-555555555555", verifiedAt: null }]);

    const response = await server.inject({
      method: "POST",
      url: "/api/backups/11111111-2222-3333-4444-555555555555/restore",
      headers: authorizationHeader(token),
      payload: { confirm: true },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toMatch(/not been verified/);
  });
});
