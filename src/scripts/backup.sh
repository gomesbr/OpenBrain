#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="${1:-./backups}"
SERVICE_NAME="${SERVICE_NAME:-openbrain-db}"
DATABASE="${DATABASE:-openbrain}"
DB_USER="${DB_USER:-openbrain}"

mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d_%H%M%S)"
FILE="$OUT_DIR/openbrain_${STAMP}.sql"

echo "Creating backup: $FILE"
docker exec "$SERVICE_NAME" pg_dump -U "$DB_USER" -d "$DATABASE" --clean --if-exists --no-owner --no-privileges > "$FILE"
echo "Backup complete"
