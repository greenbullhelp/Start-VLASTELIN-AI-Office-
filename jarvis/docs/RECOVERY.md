# Резервні копії і відновлення з нуля

## Що зберігати

| Що | Де | Як відновити, якщо втрачено |
|---|---|---|
| Код | GitHub | клонувати знову |
| Ключі й налаштування | `/opt/jarvis/.env` на сервері | ключ Anthropic — створити новий на console.anthropic.com; решту генерує `install.sh` |
| Дані (чат, задачі, витрати, журнал, ринок, гра) | `data/panel/jarvis.db` | з резервної копії |
| Пам'ять і навички Hermes, робочі файли агентів | `data/hermes/` | з резервної копії |

## Автоматична щоденна копія

```bash
(crontab -l 2>/dev/null; echo "30 3 * * * /opt/jarvis/deploy/backup.sh >/dev/null 2>&1") | crontab -
```

Копії лежать у `/opt/jarvis-backups` (14 останніх). Зробити копію вручну: `bash /opt/jarvis/deploy/backup.sh`.

**Копія поза сервером** (рекомендовано раз на тиждень): у Termius відкрийте **SFTP** → сервер → `/opt/jarvis-backups` →
довге натискання на останній файл → **Download** — файл збережеться в iPhone («Файли»). У копії є `.env` з ключами — не пересилайте її нікому.

## Відновлення на тому самому сервері

```bash
ls /opt/jarvis-backups
bash /opt/jarvis/deploy/restore.sh /opt/jarvis-backups/jarvis-РРРРММДД-ГГХХСС.tar.gz
```

## Відновлення з нуля (новий сервер)

1. Створіть новий VPS (Ubuntu 24.04) і виконайте кроки 1–2 з [SERVER_SETUP.md](SERVER_SETUP.md) — встановлення пройде як уперше.
   На питання про ключі можна натискати Enter: їх замінить резервна копія.
2. Перенесіть файл копії на новий сервер: Termius → SFTP → завантажити файл з iPhone у `/opt/jarvis-backups/` (створіть папку).
3. Відновіть:
   ```bash
   bash /opt/jarvis/deploy/restore.sh /opt/jarvis-backups/<файл>.tar.gz
   ```
4. Якщо IP-адреса змінилась, а ви використовуєте адресу `*.sslip.io` — оновіть домен:
   ```bash
   cd /opt/jarvis && IP=$(curl -fsS4 https://api.ipify.org) && sed -i "s/^PANEL_DOMAIN=.*/PANEL_DOMAIN=${IP//./-}.sslip.io/; s#^PUBLIC_URL=.*#PUBLIC_URL=https://${IP//./-}.sslip.io#" .env && docker compose up -d
   ```
   Нова адреса панелі: `https://<IP-через-дефіси>.sslip.io`. Вхід — тим самим паролем і кодом 2FA.
5. ПК-вузол: оновіть адресу сервера в `config.toml` (нова адреса Tailscale — `tailscale ip -4` на новому сервері).

## Якщо втрачено телефон із 2FA

```bash
cd /opt/jarvis && docker compose exec panel python -m app.cli reset-2fa
```

Під час наступного входу панель покаже новий QR-код. Пароль змінити: `docker compose exec panel python -m app.cli set-password`.

## Якщо ключ API міг потрапити до сторонніх

1. console.anthropic.com → API Keys → **Disable** старий ключ → створіть новий.
2. `nano /opt/jarvis/.env` → новий `ANTHROPIC_API_KEY` → `docker compose up -d`.
3. Так само з токеном Telegram (@BotFather → `/revoke`) і `NODE_TOKEN` (`openssl rand -hex 24`, оновити на сервері й у `config.toml` ПК).
