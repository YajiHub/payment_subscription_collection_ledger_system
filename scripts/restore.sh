#!/usr/bin/env bash
#
# Restores the BCIS database from a backup produced by scripts/backup.sh.
#
# CAUTION: this OVERWRITES the current database contents. It is the last resort
# after data loss, not a routine step.
#
#   pnpm restore backups/bcis_backup_2025-01-31_23-59-00_a1b2c3d4.sql.gz
#
# Before restoring:
#   1. Stop the API server so nothing writes during the restore
#      (pm2 stop bcis-api).
#   2. Take a fresh backup of the broken database if it still starts at all.
#
# Requires `pg_restore` and `gunzip`, installed with PostgreSQL and Git Bash/WSL.

set -euo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -z "${DATABASE_URL:-}" ] && [ -f "$REPOSITORY_ROOT/.env" ]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$REPOSITORY_ROOT/.env" | tail -n 1 | cut -d= -f2-)"
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set and was not found in $REPOSITORY_ROOT/.env" >&2
  exit 1
fi

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 /path/to/bcis_backup_YYYY-MM-DD_HH-MM-SS_xxxxxxxx.sql.gz" >&2
  exit 1
fi

BACKUP_FILE="$1"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "Backup file not found: $BACKUP_FILE" >&2
  exit 1
fi

# Validate the archive BEFORE anything destructive runs. pg_restore --clean drops
# the existing objects first, so feeding it a corrupt or empty backup would wipe
# the database and restore nothing. An empty gzip still passes `gzip -t`, so also
# require that it actually decompresses to some content.
if ! gzip -t "$BACKUP_FILE" 2>/dev/null; then
  echo "Refusing to restore: $BACKUP_FILE is not a readable gzip archive." >&2
  exit 1
fi

if [ "$(gzip -dc "$BACKUP_FILE" | wc -c)" -eq 0 ]; then
  echo "Refusing to restore: $BACKUP_FILE decompresses to zero bytes." >&2
  echo "Nothing was changed in the database." >&2
  exit 1
fi

echo "This replaces all current data in the database at DATABASE_URL."
echo "Backup file: $BACKUP_FILE"
read -r -p "Type 'yes' to confirm: " CONFIRMATION

if [ "$CONFIRMATION" != "yes" ]; then
  echo "Restore cancelled."
  exit 0
fi

# --clean --if-exists drops the existing objects before recreating them, so the
# restore does not need permission to CREATE DATABASE. gunzip -c decompresses to
# stdout, which is what pg_restore reads.
#
# A dump taken with a NEWER pg_dump than the server writes `SET transaction_timeout
# = 0` into the archive — a setting the server only knows from PostgreSQL 17 on.
# pg_restore reports it, ignores it, restores everything else, and STILL exits 1,
# which the API reported as a failed restore even though the data was restored. Only
# that class of error is tolerated, and only when pg_restore itself says the errors
# were ignorable, so a real failure still fails loudly.
RESTORE_LOG="$(mktemp)"
trap 'rm -f "$RESTORE_LOG"' EXIT

set +e
gunzip -c "$BACKUP_FILE" | pg_restore --dbname="$DATABASE_URL" --no-password --clean --if-exists 2> "$RESTORE_LOG"
RESTORE_CODE=$?
set -e

if [ "$RESTORE_CODE" -ne 0 ]; then
  ERROR_LINES="$(grep -c 'pg_restore: error:' "$RESTORE_LOG" || true)"
  BENIGN_LINES="$(grep -c 'unrecognized configuration parameter' "$RESTORE_LOG" || true)"

  if grep -q 'errors ignored on restore' "$RESTORE_LOG" &&
     [ "$ERROR_LINES" -gt 0 ] &&
     [ "$ERROR_LINES" -eq "$BENIGN_LINES" ]; then
    echo "Warning: the only errors were settings this server does not know, which" >&2
    echo "means the backup was taken with a newer PostgreSQL client than the server." >&2
    echo "Everything else was restored." >&2
    sed 's/^/  /' "$RESTORE_LOG" >&2
  else
    echo "Restore failed:" >&2
    sed 's/^/  /' "$RESTORE_LOG" >&2
    exit 1
  fi
fi

# Prove the restore actually put something back. A restore that reports success but
# leaves the schema empty is worse than one that fails loudly.
if command -v psql >/dev/null 2>&1; then
  RESTORED_TABLES="$(psql --dbname="$DATABASE_URL" --no-password -t -A -c \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'" 2>/dev/null || echo 0)"
  if [ "${RESTORED_TABLES:-0}" -lt 1 ]; then
    echo "Restore failed: the database has no tables after the restore." >&2
    exit 1
  fi
  echo "Restore complete: $RESTORED_TABLES tables in the public schema."
else
  echo "Restore complete. (psql was not found, so the result could not be counted.)"
fi

echo "Start the API server again (pm2 start bcis-api)."
