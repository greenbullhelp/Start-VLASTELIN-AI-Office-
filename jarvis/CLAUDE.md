# Джарвіс: контекст для Claude Code

- Власник не програміст, працює з iPhone. Спілкування українською, просто й покроково. Коміти — англійською.
- Ключі й паролі ніколи не потрапляють у код, Git, чат чи журнали. Лише `.env` на сервері.
- Старий проєкт VLASTELIN AI Office (окремий репозиторій) не змінювати. З нього взято ідеї та сценарій карткової гри.
- Назва «Джарвіс» — вибір власника; жодної символіки Marvel/Iron Man (логотипів, кольорів, персонажів) не використовуємо.

## Архітектура
Див. `docs/ARCHITECTURE.md`. Коротко: `panel` (FastAPI, SQLite, без збірки фронтенду) керує чергою задач і правилами,
а розумну роботу виконує `hermes` (Hermes Agent) через API `/v1/runs`. Агенти повертають дії блоком ```actions```,
панель перевіряє їх `rules.gate`.

## Перевірка
- `cd panel && python -m pytest -q` — тести з `BRAIN=mock` (без мережі й витрат).
- Локально: `cd panel && DATA_DIR=/tmp/j BRAIN=mock COOKIE_SECURE=0 uvicorn app.main:app --port 8765`,
  пароль: `JARVIS_NEW_PASSWORD=... python -m app.cli set-password`.
- Скриншоти — Playwright, розміри 1440×900 і 400×860, консоль без помилок.
- Реальний Hermes: `docker run ... nousresearch/hermes-agent:stable gateway run` з `API_SERVER_ENABLED=true` (див. ARCHITECTURE.md).

## Правила розвитку
- Нова дія агента: опис у `agents.ACTION_DOC`, категорія в `rules.py`, обробка в `orchestrator._apply`, тест.
- Новий розділ панелі: маршрут у модулі з `router`, рендер у `static/*.js` через `R[...]`/`A[...]`.
- Після змін CSS/JS піднімати `?v=` в `static/index.html` і в імпортах модулів.
- Статус етапів — у таблиці README; оновлювати після кожного етапу.
