#!/usr/bin/env bash
#
# Restores the BCIS database from a backup produced by scripts/backup.sh.
#
# CAUTION: this OVERWRITES the current database contents. It is the last resort
# after data loss, not a routine step.
#
#   pnpm restore backups/bcis_backup_2025-01-31_23-59-00.sql.gz
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
  echo "Usage: $0 /path/to/bcis_backup_YYYY-MM-DD_HH-MM-SS.sql.gz" >&2
  exit 1
fi

BACKUP_FILE="$1"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "Backup file not found: $BACKUP_FILE" >&2
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
gunzip -c "$BACKUP_FILE" | pg_restore --dbname="$DATABASE_URL" --no-password --clean --if-exists

echo "Restore complete. Start the API server again (pm2 start bcis-api)."