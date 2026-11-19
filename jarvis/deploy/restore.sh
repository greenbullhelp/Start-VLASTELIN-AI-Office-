#!/usr/bin/env bash
# Відновлення з резервної копії: bash deploy/restore.sh /opt/jarvis-backups/jarvis-YYYYMMDD-HHMMSS.tar.gz
set -euo pipefail
[ -f "${1:-}" ] || { echo "Вкажіть файл копії: ls /opt/jarvis-backups"; exit 1; }
cd "$(dirname "$0")/.."
docker compose down
mv data "data.old.$(date +%s)" 2>/dev/null || true
tar -xzf "$1"
[ -f data/panel/backup.db ] && mv -f data/panel/backup.db data/panel/jarvis.db
rm -f data/panel/jarvis.db-wal data/panel/jarvis.db-shm
chown -R 10000:10000 data
docker compose up -d --build
echo "✔ Відновлено з $1. Стару папку даних збережено як data.old.*"
