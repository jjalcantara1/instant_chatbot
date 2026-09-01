#!/usr/bin/env bash
# Nightly copy. The 24h TTL means losing a day is losing nothing important.
set -euo pipefail
DB="${DATABASE_PATH:-/srv/sitechat/data/sitechat.db}"
DEST="${BACKUP_DIR:-/srv/sitechat/backups}"
mkdir -p "$DEST"
# .backup is WAL-safe; cp is not.
sqlite3 "$DB" ".backup '$DEST/sitechat-$(date +%F).db'"
find "$DEST" -name 'sitechat-*.db' -mtime +7 -delete
