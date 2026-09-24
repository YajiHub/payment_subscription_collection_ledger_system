#!/usr/bin/env bash
#
# Backs up the BCIS PostgreSQL database to a timestamped file.
#
# Run this on the server PC (PC-1), daily. Keep at least 7 days of backups; the
# default retention below is 30.
#
#   pnpm backup                                  # uses DATABASE_URL from .env
#   BCIS_BACKUP_DIR=/mnt/usb pnpm backup         # write the file somewhere else
#   BCIS_BACKUP_RETENTION_DAYS=7 pnpm backup     # keep one week
#
# Requires `pg_dump`, which is installed with PostgreSQL. On Windows, run this
# from Git Bash or WSL and put PostgreSQL's bin directory on PATH.

set -euo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Read DATABASE_URL from the environment, or from the repository .env file. The
# password lives inside the URL, so it is passed to pg_dump directly and never
# echoed to the terminal.
if [ -z "${DATABASE_URL:-}" ] && [ -f "$REPOSITORY_ROOT/.env" ]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$REPOSITORY_ROOT/.env" | tail -n 1 | cut -d= -f2-)"
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set and was not found in $REPOSITORY_ROOT/.env" >&2
  exit 1
fi

BACKUP_DIR="${BCIS_BACKUP_DIR:-$REPOSITORY_ROOT/backups}"
RETENTION_DAYS="${BCIS_BACKUP_RETENTION_DAYS:-30}"
TIMESTAMP="$(date +%Y-%m-%d_%H-%M-%S)"
BACKUP_FILE="$BACKUP_DIR/bcis_backup_$TIMESTAMP.sql.gz"

mkdir -p "$BACKUP_DIR"

# Dump to a temporary file and publish it only once it is known to be a real
# dump. Writing straight to BACKUP_FILE is unsafe: the shell creates the file
# before pg_dump runs, so a failed dump leaves a truncated file behind. An empty
# gzip is exactly 20 bytes AND still passes `gzip -t`, so a crashed run would
# leave something that looks like a good backup. Verify, then rename atomically.
TEMP_FILE="$BACKUP_FILE.partial"
trap 'rm -f "$TEMP_FILE"' EXIT

# --format=custom lets pg_restore rebuild indexes, constraints, and the
# append-only audit trigger exactly as they were. --no-password stops pg_dump
# from prompting, so the script can run unattended from Task Scheduler.
pg_dump --dbname="$DATABASE_URL" --no-password --format=custom | gzip > "$TEMP_FILE"

if ! gzip -t "$TEMP_FILE" 2>/dev/null; then
  echo "Backup failed: the dump is not a readable gzip archive." >&2
  exit 1
fi

# A real dump of any populated database is far larger than this threshold, so a
# tiny file means pg_dump produced no data and must not be published.
BACKUP_BYTES="$(wc -c < "$TEMP_FILE")"
if [ "$BACKUP_BYTES" -lt 100 ]; then
  echo "Backup failed: pg_dump produced no data (see the pg_dump error above)." >&2
  echo "Discarded the incomplete file; no backup was created." >&2
  exit 1
fi

mv "$TEMP_FILE" "$BACKUP_FILE"
trap - EXIT

echo "Backup created: $BACKUP_FILE"
echo "Size: $(du -h "$BACKUP_FILE" | cut -f1)"

# Remove expired backups. A non-numeric retention value disables cleanup rather
# than accidentally deleting everything.
if [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] && [ "$RETENTION_DAYS" -gt 0 ]; then
  find "$BACKUP_DIR" -name 'bcis_backup_*.sql.gz' -mtime "+$RETENTION_DAYS" -delete
  echo "Removed backups older than $RETENTION_DAYS days."
fi
