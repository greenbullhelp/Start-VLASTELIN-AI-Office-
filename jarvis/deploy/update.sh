#!/usr/bin/env bash
# Оновлення Джарвіса до останньої версії з GitHub: bash /opt/jarvis/deploy/update.sh
set -euo pipefail
cd "$(dirname "$0")/.."
./deploy/backup.sh >/dev/null && echo "✔ Резервну копію зроблено"
git pull --ff-only
docker compose pull hermes caddy
docker compose up -d --build
docker image prune -f >/dev/null
echo "✔ Оновлено. Стан:"; docker compose ps
