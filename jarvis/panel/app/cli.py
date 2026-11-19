"""Команди обслуговування (виконуються на сервері):

  docker compose exec panel python -m app.cli set-password   — задати/змінити пароль
  docker compose exec panel python -m app.cli reset-2fa      — скинути 2FA (новий QR при вході)
  docker compose exec panel python -m app.cli logout-all     — завершити всі сесії
  docker compose exec panel python -m app.cli stop           — зупинити агентів (на наступному кроці)
  docker compose exec panel python -m app.cli resume
  docker compose exec panel python -m app.cli status
"""
from __future__ import annotations

import getpass
import os
import sys

from . import auth, db


def main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else "help"
    db.conn()
    if cmd == "set-password":
        pw = os.environ.get("JARVIS_NEW_PASSWORD") or getpass.getpass("Новий пароль (мін. 10 символів): ")
        if not os.environ.get("JARVIS_NEW_PASSWORD"):
            if pw != getpass.getpass("Повторіть пароль: "):
                print("Паролі не збігаються.")
                return 1
        try:
            auth.set_password(pw)
        except ValueError as e:
            print(e)
            return 1
        print("✅ Пароль збережено. Відкрийте панель і увійдіть — при першому вході підключите 2FA.")
        return 0
    if cmd == "reset-2fa":
        auth.reset_2fa()
        print("✅ 2FA скинуто. При наступному вході панель покаже новий QR-код.")
        return 0
    if cmd == "logout-all":
        auth.drop_all_sessions()
        print("✅ Усі сесії завершено.")
        return 0
    if cmd in ("stop", "resume"):
        db.set_setting("halted", cmd == "stop")
        from .core import audit

        audit("owner(cli)", cmd.upper(), "з консолі сервера", "warn")
        print("⏹ Агентів зупинено." if cmd == "stop" else "▶ Роботу відновлено.")
        return 0
    if cmd == "status":
        from .reports import status_text

        print(status_text())
        return 0
    print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
