// S5-3 — re-verification must not leave a row claiming to be verified.
//
// `POST /api/backups/:id/verify` re-checks a recorded archive against its stored
// size and checksum. When that check fails the row used to keep its old
// `verified_at`, so the list went on advertising an archive that no longer
// verifies (it had been corrupted or overwritten since it was recorded).
//
// This suite pins the corrected contract: a failed re-verification clears
// `verified_at` and records the reason in `notes`, and still answers the caller
// with a conflict.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db/connection", async () => {
  const { fakeDatabase } = await import("./support/fake-database");
  return {
    db: fakeDatabase.db,
    pool: {},
    checkDatabaseConnection: async () => ({ isReachable: true, latencyMs: 0, errorMessage: null }),
    closeDatabaseConnection: async () => {},
  };
});

import { backupHistory } from "../src/db/schema/system";
import { verifyBackup } from "../src/modules/backup/backup.service";
import { fakeDatabase } from "./support/fake-database";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const backupDirectory = path.join(repositoryRoot, "backups");
mkdirSync(backupDirectory, { recursive: true });

const writtenFiles: string[] = [];

/** Writes a real gzip archive so the verifier reaches the size/checksum checks. */
function writeArchive(absolutePath: string, uncompressedBytes: number): void {
  const contents = gzipSync(randomBytes(uncompressedBytes));
  writeFileSync(absolutePath, contents);
  writtenFiles.push(absolutePath);
}

afterAll(() => {
  for (const file of writtenFiles) {
    rmSync(file, { force: true });
  }
  rmSync(path.join(tmpdir(), `bcis-backup-verify-${process.pid}`), { recursive: true, force: true });
});

beforeEach(() => {
  fakeDatabase.reset();
});

describe("re-verifying a recorded backup that no longer matches", () => {
  it("clears verified_at and records the reason when a re-verification fails", async () => {
    const fileName = "bcis_backup_reverify_cleared.sql.gz";
    writeArchive(path.join(backupDirectory, fileName), 4_000);

    const entry = {
      id: "13131313-1313-1313-1313-131313131313",
      filename: fileName,
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

  it("keeps verified_at and its checksum when the archive still matches", async () => {
    const fileName = "bcis_backup_reverify_ok.sql.gz";
    const contents = gzipSync(randomBytes(4_000));
    writeFileSync(path.join(backupDirectory, fileName), contents);
    writtenFiles.push(path.join(backupDirectory, fileName));
    const checksum = createHash("sha256").update(contents).digest("hex");

    const entry = {
      id: "14141414-1414-1414-1414-141414141414",
      filename: fileName,
      sizeBytes: contents.length,
      checksum,
      checksumAlgorithm: "sha256",
      createdBy: null,
      createdAt: new Date(),
      verifiedAt: null,
      restoreTestedAt: null,
      notes: null,
    };
    fakeDatabase.queueSelectRows([entry]);
    fakeDatabase.queueUpdateRows([{ ...entry, verifiedAt: new Date() }]);

    const verified = await verifyBackup(entry.id);

    expect(verified.verifiedAt).toBeInstanceOf(Date);
    // The failure path must not have run: nothing clears the stamp on success.
    const updates = fakeDatabase.updatedRows.filter((row) => row.table === backupHistory);
    expect(updates).toHaveLength(1);
    expect((updates[0]?.values as Record<string, unknown>).verifiedAt).not.toBeNull();
  });
});
