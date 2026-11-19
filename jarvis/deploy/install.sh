#!/usr/bin/env bash
# Встановлення Джарвіса на чистий Ubuntu-сервер (ZAP-Hosting VPS). Запускати від root.
#   bash install.sh
# Скрипт можна запускати повторно: що вже зроблено — пропускає, ключі не перезаписує.
set -euo pipefail

REPO_URL="${JARVIS_REPO:-https://github.com/greenbullhelp/jarvis.git}"
BRANCH="${JARVIS_BRANCH:-main}"
DIR="${JARVIS_DIR:-/opt/jarvis}"

say()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✔ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
ask()  { local __v; read -r -p "$1" __v < /dev/tty; printf '%s' "$__v"; }
ask_secret() { local __v; read -r -s -p "$1" __v < /dev/tty; echo > /dev/tty; printf '%s' "$__v"; }

[ "$(id -u)" = 0 ] || { echo "Запустіть від root: sudo bash install.sh"; exit 1; }
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || warn "Скрипт перевірено на Ubuntu 22.04/24.04, у вас: ${PRETTY_NAME:-?}"

say "1/9 Оновлення системи"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get -o Dpkg::Options::=--force-confold upgrade -y
apt-get install -y curl git ufw fail2ban unattended-upgrades ca-certificates openssl
ok "Систему оновлено"

say "2/9 Автоматичні оновлення безпеки"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
systemctl enable --now fail2ban >/dev/null 2>&1 || true
ok "Оновлення безпеки ставитимуться самі; fail2ban блокує підбір паролів SSH"

say "3/9 Файл підкачки (для 4 ГБ RAM)"
if ! swapon --show | grep -q . && [ "$(awk '/MemTotal/{print int($2/1024/1024)}' /proc/meminfo)" -lt 7 ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ok "Додано 2 ГБ swap"
else
  ok "Swap не потрібен або вже є"
fi

say "4/9 Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker
docker compose version >/dev/null || { echo "Немає docker compose"; exit 1; }
ok "Docker готовий і стартує разом із сервером"

say "5/9 Файрвол"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ok "Відкрито лише SSH (22), HTTP (80) і HTTPS (443)"

say "6/9 Код Джарвіса з GitHub"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only || warn "Не вдалося оновити код (локальні зміни?) — продовжую з наявним"
else
  if ! git ls-remote "$REPO_URL" >/dev/null 2>&1; then
    warn "Репозиторій приватний. Потрібен токен GitHub лише на читання цього репозиторію."
    TOKEN="$(ask_secret 'Вставте токен GitHub (символи не показуються): ')"
    REPO_AUTH="${REPO_URL/https:\/\//https://x-access-token:${TOKEN}@}"
    git clone -b "$BRANCH" "$REPO_AUTH" "$DIR"
    git -C "$DIR" remote set-url origin "$REPO_URL"
    git -C "$DIR" config credential.helper store
    printf 'https://x-access-token:%s@github.com\n' "$TOKEN" > /root/.git-credentials && chmod 600 /root/.git-credentials
  else
    git clone -b "$BRANCH" "$REPO_URL" "$DIR"
  fi
fi
cd "$DIR"
ok "Код у $DIR"

say "7/9 Ключі та налаштування (.env)"
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
fi
setenv() { # setenv KEY VALUE — записує значення в .env, не показуючи його
  local k="$1" v="$2"
  if grep -q "^${k}=" .env; then
    python3 - "$k" "$v" <<'PY'
import sys, re
k, v = sys.argv[1], sys.argv[2]
p = ".env"; s = open(p).read()
s = re.sub(rf"^{re.escape(k)}=.*$", lambda m: f"{k}={v}", s, flags=re.M)
open(p, "w").write(s)
PY
  else
    echo "${k}=${v}" >> .env
  fi
}
getenv() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//' ; }

if [ -z "$(getenv ANTHROPIC_API_KEY)" ]; then
  KEY="$(ask_secret 'Вставте ключ Anthropic API (sk-ant-..., не показується): ')"
  [ -n "$KEY" ] && setenv ANTHROPIC_API_KEY "$KEY"
fi
[ -n "$(getenv API_SERVER_KEY)" ] || setenv API_SERVER_KEY "$(openssl rand -hex 32)"
[ -n "$(getenv NODE_TOKEN)" ] || setenv NODE_TOKEN "$(openssl rand -hex 24)"
if [ -z "$(getenv PANEL_DOMAIN)" ]; then
  IP="$(curl -fsS4 https://api.ipify.org || curl -fsS4 https://ifconfig.me)"
  DEF="${IP//./-}.sslip.io"
  D="$(ask "Домен панелі [Enter = ${DEF}]: ")"
  D="${D:-$DEF}"
  setenv PANEL_DOMAIN "$D"
  setenv PUBLIC_URL "https://$D"
fi
if [ -z "$(getenv TELEGRAM_BOT_TOKEN)" ]; then
  T="$(ask_secret 'Токен Telegram-бота (Enter — пропустити): ')"
  if [ -n "$T" ]; then
    setenv TELEGRAM_BOT_TOKEN "$T"
    U="$(ask 'Ваш Telegram ID (цифри, див. @userinfobot): ')"
    setenv TELEGRAM_OWNER_ID "$U"
  fi
fi
RAM_GB="$(awk '/MemTotal/{print int($2/1024/1024+0.5)}' /proc/meminfo)"
if [ "$RAM_GB" -le 4 ]; then
  setenv HERMES_MEM 2g
  setenv PANEL_MEM 1g
fi
ok "Ключі збережено в $DIR/.env (доступ лише root)"

say "8/9 Hermes Agent і запуск"
mkdir -p data/hermes/workspace data/panel
[ -f data/hermes/config.yaml ] || cp hermes/config.yaml data/hermes/config.yaml
[ -f data/hermes/SOUL.md ] || cp hermes/SOUL.md data/hermes/SOUL.md
if [ ! -d data/hermes/workspace/game/.git ]; then   # стартовий прототип гри для ігрового агента
  mkdir -p data/hermes/workspace/game && cp -rn game-starter/. data/hermes/workspace/game/
  git -C data/hermes/workspace/game init -q -b main
  git -C data/hermes/workspace/game add -A
  git -C data/hermes/workspace/game -c user.name=Jarvis -c user.email=jarvis@localhost commit -qm "Starter card game prototype" || true
fi
chown -R 10000:10000 data
docker compose pull hermes caddy
docker compose up -d --build
cat > /etc/systemd/system/jarvis.service <<EOF
[Unit]
Description=Jarvis (Hermes + panel)
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$DIR
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose stop
TimeoutStartSec=600

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable jarvis.service >/dev/null
ok "Джарвіс запущено й стартуватиме сам після перезавантаження"

say "9/9 Пароль панелі"
for i in $(seq 1 30); do docker compose exec -T panel python -c "print(1)" >/dev/null 2>&1 && break; sleep 2; done
if docker compose exec -T panel python -c "from app import auth,db;db.conn();import sys;sys.exit(0 if auth.owner() else 1)" >/dev/null 2>&1; then
  ok "Пароль уже задано (змінити: docker compose exec panel python -m app.cli set-password)"
else
  docker compose exec panel python -m app.cli set-password < /dev/tty
fi

DOMAIN="$(getenv PANEL_DOMAIN)"
printf '\n\033[1;32m════════════════════════════════════════════\033[0m\n'
printf '\033[1;32m  Готово! Адреса панелі:  https://%s\033[0m\n' "$DOMAIN"
printf '\033[1;32m════════════════════════════════════════════\033[0m\n'
echo "Відкрийте її в Safari на iPhone. Перший вхід: пароль → підключення 2FA."
echo "Сертифікат HTTPS з'являється за 1–2 хвилини після запуску."
echo "Стан: cd $DIR && docker compose ps    Журнал: docker compose logs -f --tail 50"
