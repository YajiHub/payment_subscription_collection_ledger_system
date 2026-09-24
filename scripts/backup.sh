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

# --format=custom lets pg_restore rebuild indexes, constraints, and the
# append-only audit trigger exactly as they were. --no-password stops pg_dump
# from prompting, so the script can run unattended from Task Scheduler.
pg_dump --dbname="$DATABASE_URL" --no-password --format=custom | gzip > "$BACKUP_FILE"

echo "Backup created: $BACKUP_FILE"
echo "Size: $(du -h "$BACKUP_FILE" | cut -f1)"

# Remove expired backups. A non-numeric retention value disables cleanup rather
# than accidentally deleting everything.
if [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] && [ "$RETENTION_DAYS" -gt 0 ]; then
  find "$BACKUP_DIR" -name 'bcis_backup_*.sql.gz' -mtime "+$RETENTION_DAYS" -delete
  echo "Removed backups older than $RETENTION_DAYS days."
fi