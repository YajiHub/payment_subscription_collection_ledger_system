// S5-3 — the shipped restore script must tell a real failure apart from a
// client/server version skew.
//
// A dump taken with a newer pg_dump than the server carries `SET
// transaction_timeout = 0`, a setting the server only knows from PostgreSQL 17 on.
// pg_restore reports it, ignores it, restores everything else — and still exits 1.
// The API read that non-zero code as a failed restore and told the operator the
// restore had failed over data that had in fact been restored.
//
// The script must tolerate exactly that class of error, and nothing else. pg_restore
// and psql are replaced by shims, so the suite needs no PostgreSQL — only bash,
// gzip and coreutils, exactly what the script itself requires.

import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

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

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const restoreScriptPath = path.join(repositoryRoot, "scripts", "restore.sh");

const scratchDirectory = mkdtempSync(path.join(tmpdir(), `bcis-restore-script-${process.pid}-`));
const shimDirectory = path.join(scratchDirectory, "bin");
mkdirSync(shimDirectory, { recursive: true });

/** A real gzip archive with content — all the script's own pre-checks need. */
const archivePath = path.join(scratchDirectory, "bcis_backup_2026-01-01_00-00-00_abcdef01.sql.gz");
writeFileSync(archivePath, gzipSync(Buffer.from("PGDMP shimmed archive contents")));

/**
 * Writes an executable shim. `cat > /dev/null` drains the archive from the pipe
 * first, so gunzip is never killed by SIGPIPE and the pipeline's exit status is the
 * one under test rather than 141.
 */
function writeShim(name: string, body: string): void {
  const shimPath = path.join(shimDirectory, name);
  writeFileSync(shimPath, `#!/usr/bin/env bash\ncat > /dev/null\n${body}\n`);
  chmodSync(shimPath, 0o755);
}

/** The benign skew: what pg_restore 18 prints when restoring into a 16 server. */
const BENIGN_RESTORE = [
  `printf '%s\\n' 'pg_restore: error: could not execute query: ERROR:  unrecognized configuration parameter "transaction_timeout"' >&2`,
  `printf '%s\\n' 'Command was: SET transaction_timeout = 0;' >&2`,
  `printf '%s\\n' 'pg_restore: warning: errors ignored on restore: 1' >&2`,
  "exit 1",
].join("\n");

afterAll(() => {
  rmSync(scratchDirectory, { recursive: true, force: true });
});

/** Runs the restore exactly as the API does, answering its confirmation prompt. */
function runRestoreScript(): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [restoreScriptPath, archivePath], {
      env: {
        ...process.env,
        PATH: `${shimDirectory}:${process.env.PATH ?? ""}`,
        DATABASE_URL: "postgresql://shim:shim@localhost:5432/shim",
      },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end("yes\n");
  });
}

describe("scripts/restore.sh result reporting", () => {
  it("succeeds when the only errors are settings this server does not know", async () => {
    writeShim("pg_restore", BENIGN_RESTORE);
    writeShim("psql", "printf '%s\\n' 29");

    const result = await runRestoreScript();

    expect(result.code, result.stderr).toBe(0);
    // The operator must be told why, not left thinking the restore was clean.
    expect(result.stderr).toContain("newer PostgreSQL client");
    expect(result.stdout).toContain("29 tables");
  });

  it("fails when the restore reports an error that is not that skew", async () => {
    writeShim(
      "pg_restore",
      [
        `printf '%s\\n' 'pg_restore: error: connection to server at "localhost", port 5432 failed: FATAL:  database "bcis_db" does not exist' >&2`,
        `printf '%s\\n' 'pg_restore: warning: errors ignored on restore: 1' >&2`,
        "exit 1",
      ].join("\n")
    );
    writeShim("psql", "printf '%s\\n' 29");

    const result = await runRestoreScript();

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Restore failed");
  });

  it("fails when a tolerated restore leaves the database with no tables", async () => {
    writeShim("pg_restore", BENIGN_RESTORE);
    writeShim("psql", "printf '%s\\n' 0");

    const result = await runRestoreScript();

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no tables");
  });
});
