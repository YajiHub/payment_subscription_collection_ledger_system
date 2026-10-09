# Backup and Restore

A cable ISP cannot recover from losing its ledger by re-typing it. Back up the
database daily, keep a copy off PC-1, and practise a restore before you need one.

The scripts live in `scripts/` and are wired to pnpm:

| Command         | Script                | Does                                              |
| --------------- | --------------------- | ------------------------------------------------- |
| `pnpm backup`   | `scripts/backup.sh`   | Dumps the database to a timestamped `.sql.gz`     |
| `pnpm restore <file>` | `scripts/restore.sh` | Replaces the database from that file      |

Both read `DATABASE_URL` from the environment, or from the repository `.env`
file when it is not set. `pg_dump`, `psql`, and `pg_restore` come with PostgreSQL
and must be on `PATH`. On Windows, run them from Git Bash or WSL.

---

## Taking a backup

```bash
pnpm backup
# uses DATABASE_URL from .env

BCIS_BACKUP_DIR=/mnt/usb/bcis pnpm backup
# writes the file somewhere else, e.g. a USB drive

BCIS_BACKUP_RETENTION_DAYS=7 pnpm backup
# keep one week instead of the default 30 days
```

The script:

1. reads `DATABASE_URL` (the password inside it is passed straight to `pg_dump`
   and never printed);
2. runs `pg_dump --format=custom` and gzips the result into
   `backups/bcis_backup_YYYY-MM-DD_HH-MM-SS_xxxxxxxx.sql.gz`. The trailing random
   suffix keeps two backups in the same second from sharing a name; a name that
   already exists is re-drawn rather than overwritten;
3. prints the file path and its size;
4. deletes backups older than the retention window.

`--format=custom` is what lets `pg_restore` rebuild every table, index, foreign
key, enum, and the append-only trigger on `audit_logs` exactly as they were. A
plain text dump would restore the data but not the guarantees.

**Store a copy somewhere other than PC-1.** A backup that lives only on the disk
that failed is not a backup. Copy the weekly file to a USB drive or a network
share.

### Windows Task Scheduler

Create one daily task on PC-1:

- Trigger: daily at 11:59 PM
- Action: Start a program → `C:\Program Files\Git\bin\bash.exe`
- Arguments: `-lc "cd /c/bcis && pnpm backup"`
- Start in: the repository folder

Point `BCIS_BACKUP_DIR` at a second drive (for example `D:\BCIS-Backups`) by
setting the environment variable for the task.

---

## Restoring from a backup

> **Warning.** A restore **replaces all current data**. It is the last resort
> after data loss, not a routine step. If the broken database still starts at
> all, take one more backup of it first — the failed state is sometimes worth
> inspecting.

1. **Stop the API server** so nothing writes during the restore:

   ```bash
   pm2 stop bcis-api
   ```

2. Run the restore and type `yes` at the confirmation prompt:

   ```bash
   pnpm restore backups/bcis_backup_2025-01-31_23-59-00_a1b2c3d4.sql.gz
   ```

   The script decompresses the dump and runs
   `pg_restore --clean --if-exists`, which drops the existing objects before
   recreating them. Because it does not drop and recreate the *database*, it needs
   no superuser rights.

3. Start the API server again:

   ```bash
   pm2 start bcis-api
   ```

4. Verify the restore before letting staff back in:

   ```bash
   curl http://localhost:3/health/db          # must return 200
   ```

   Then log in as the Administrator and check that:
   - the Dashboard shows the expected number of active accounts;
   - **Reports → AR Aging** totals match the day before the failure;
   - open one service account's ledger and choose **Verify integrity** — it must
     report a valid, unbroken running balance.

---

## Testing a restore

A restore that has never been rehearsed is a guess. Rehearse it on a spare
database:

1. Point `DATABASE_URL` at a scratch database (for example `bcis_restore_test`)
   and run `pnpm db:migrate` to give it an empty schema.
2. Run `pnpm backup` against the real database.
3. Point `DATABASE_URL` at the scratch database and run
   `pnpm restore <the file>`.
4. Compare row counts and the AR aging total between the two databases. They must
   match.

> **Note on this development machine.** These two scripts were run here against a
> live PostgreSQL 16 server: a backup was produced and restored into an empty
> database whose schema and data matched the source. Because this machine had no
> `pg_dump`/`pg_restore` on its `PATH`, those two binaries were supplied from the
> PostgreSQL container; on PC-1 they come from the PostgreSQL install and must be
> on `PATH`. Still rehearse the restore on PC-1 before relying on it.

---

## What is not in a database backup

The database dump contains every financial record. It does **not** contain:

- the uploaded GCash screenshots in `UPLOADS_DIR` (default `uploads/`) — copy that
  folder separately if those images must be kept;
- the server's `.env` file — store it securely; it holds the JWT secret, and
  without the same secret every existing session token becomes invalid after a
  restore (users simply log in again).