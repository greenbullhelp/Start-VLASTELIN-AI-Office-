#!/usr/bin/env bash
# Резервна копія даних (база панелі, пам'ять Hermes, робочі файли, .env) у /opt/jarvis-backups.
# Зберігає 14 останніх копій. Автоматично щоночі — див. docs/RECOVERY.md (cron).
set -euo pipefail
cd "$(dirname "$0")/.."
DEST="${BACKUP_DIR:-/opt/jarvis-backups}"; mkdir -p "$DEST"; chmod 700 "$DEST"
F="$DEST/jarvis-$(date +%Y%m%d-%H%M%S).tar.gz"
# безпечна копія SQLite навіть під час роботи
docker compose exec -T panel python -c "import sqlite3;s=sqlite3.connect('/data/jarvis.db');d=sqlite3.connect('/data/backup.db');s.backup(d);d.close()" 2>/dev/null || true
tar -czf "$F" --exclude='data/panel/whisper' --exclude='data/hermes/tools' --exclude='data/hermes/cache' .env data
rm -f data/panel/backup.db
chmod 600 "$F"
ls -1t "$DEST"/jarvis-*.tar.gz | tail -n +15 | xargs -r rm -f
echo "$F"
