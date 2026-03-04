#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: restore.sh <backup-file.sql>"
  exit 1
fi

BACKUP_FILE="$1"
SERVICE_NAME="${SERVICE_NAME:-openbrain-db}"
DATABASE="${DATABASE:-openbrain}"
DB_USER="${DB_USER:-openbrain}"

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "Backup file not found: $BACKUP_FILE"
  exit 1
fi

echo "Restoring from $BACKUP_FILE"
cat "$BACKUP_FILE" | docker exec -i "$SERVICE_NAME" psql -U "$DB_USER" -d "$DATABASE"
echo "Restore complete"
