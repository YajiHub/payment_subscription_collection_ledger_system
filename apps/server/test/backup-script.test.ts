// S5-3 — the shipped backup script's own naming guarantee.
//
// scripts/backup.sh names each archive. A name that ends at whole seconds is not
// unique: two backups started in the same second pick the same file name, the
// second overwrites the first, and the first row in backup_history can then never
// be verified again (its recorded size and checksum describe bytes that are gone).
//
// This suite pins the clock, so "the same second" is exact and deterministic
// rather than a race the test would only sometimes catch, and proves two runs
// produce two distinct, independently verifiable archives.
//
// pg_dump is replaced by a shim, so the suite needs no PostgreSQL — only bash,
// gzip and coreutils, exactly what the script itself requires.

import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it, vi } from "vitest";

// The service module pulls in the database connection at import time; this suite
// never queries, so it stands in a fake connection exactly as the other suites do.
vi.mock("../src/db/connection", async () => {
  const { fakeDatabase } = await import("./support/fake-database");
  return {
    db: fakeDatabase.db,
    pool: {},
    checkDatabaseConnection: async () => ({ isReachable: false, latencyMs: 0, errorMessage: null }),
    closeDatabaseConnection: async () => {},
  };
});

import { verifyBackupArchive } from "../src/modules/backup/backup.service";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const backupScriptPath = path.join(repositoryRoot, "scripts", "backup.sh");

const scratchDirectory = mkdtempSync(path.join(tmpdir(), `bcis-backup-script-${process.pid}-`));
const shimDirectory = path.join(scratchDirectory, "bin");
const backupDirectory = path.join(scratchDirectory, "backups");
mkdirSync(shimDirectory, { recursive: true });
mkdirSync(backupDirectory, { recursive: true });

// A `date` that always answers with the same second, so two runs are provably "in
// the same second" however fast the machine is.
const FIXED_SECOND = "2026-01-01_00-00-00";
writeFileSync(
  path.join(shimDirectory, "date"),
  `#!/usr/bin/env bash\nprintf '%s\\n' '${FIXED_SECOND}'\n`
);
// A `pg_dump` that emits incompressible bytes, so gzip yields a plausible archive
// well above the script's "too small to be a real dump" threshold, with no database.
writeFileSync(
  path.join(shimDirectory, "pg_dump"),
  "#!/usr/bin/env bash\nhead -c 4000 /dev/urandom\nexit 0\n"
);
chmodSync(path.join(shimDirectory, "date"), 0o755);
chmodSync(path.join(shimDirectory, "pg_dump"), 0o755);

afterAll(() => {
  rmSync(scratchDirectory, { recursive: true, force: true });
});

/** Runs one backup exactly as pnpm backup would, against the shims above. */
function runBackupScript(): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [backupScriptPath], {
      env: {
        ...process.env,
        PATH: `${shimDirectory}:${process.env.PATH ?? ""}`,
        DATABASE_URL: "postgresql://shim:shim@localhost:5432/shim",
        BCIS_BACKUP_DIR: backupDirectory,
        BCIS_BACKUP_RETENTION_DAYS: "0",
      },
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

describe("scripts/backup.sh file naming", () => {
  it("gives two backups in the same second distinct, independently verifiable names", async () => {
    const first = await runBackupScript();
    const second = await runBackupScript();
    expect(first.code, first.stderr).toBe(0);
    expect(second.code, second.stderr).toBe(0);

    const archives = readdirSync(backupDirectory).filter((name) => name.endsWith(".sql.gz"));

    // Two runs, two files: the second must not have overwritten the first.
    expect(archives).toHaveLength(2);
    expect(new Set(archives).size).toBe(2);

    // Both must stand on their own, which is what a following `verify` checks.
    for (const archive of archives) {
      const verification = await verifyBackupArchive(path.join(backupDirectory, archive));
      expect(verification.ok, `${archive}: ${verification.reason ?? ""}`).toBe(true);
    }
  });
});
