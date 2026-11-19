"""Команда: Джарвіс (головний), Контролер і четверо виконавців.

Кожен агент — окрема «сесія» Hermes зі своїми інструкціями й робочою папкою.
Перезапуск агента = нове покоління сесії (стара пам'ять розмови не підтягується).
"""
from __future__ import annotations

from . import db
from .rules import RULES_TEXT

WS = "/opt/data/workspace"  # робоча папка всередині контейнера Hermes

BASE_AGENTS = {
    "jarvis": {
        "title": "Джарвіс", "icon": "◎",
        "role": "Головний агент: приймає задачі власника, розбиває на кроки, роздає виконавцям і звітує.",
    },
    "controller": {
        "title": "Контролер", "icon": "◉",
        "role": "Стежить за виконавцями, перевіряє важливі результати, не дає агентам конфліктувати через одні файли, звітує Джарвісу.",
    },
    "game": {
        "title": "Ігровий агент", "icon": "♠", "area": "game",
        "role": ("Геймдизайнер і програміст карткової веб-гри: архітектура, механіки, баланс, код, монетизація "
                 "(донати й банерна реклама без pay-to-win). Пише код у " + WS + "/game (git, окремі гілки agent/*). "
                 "Описи карток для малювання передає діями art_request; нові картки — діями card."),
    },
    "video": {
        "title": "Відео-агент", "icon": "▶", "area": "video",
        "role": ("Монтаж відео: сценарії, план монтажу, субтитри. Важку роботу (FFmpeg, Whisper) виконує ПК-вузол — "
                 "став задачі діями node_job з білого списку. Файли — у " + WS + "/video."),
    },
    "trading": {
        "title": "Трейдинговий агент", "icon": "◆", "area": "trading",
        "role": ("Аналітика золота (XAUUSD): тренд, рівні, новини, сигнали, журнал угод. Торгує ЛИШЕ на демо-рахунку "
                 "через дію trade_demo; ліміти ризику перевіряє код. Реальні угоди — тільки approval real_trade."),
    },
    "research": {
        "title": "Дослідник", "icon": "⌕", "area": "",
        "role": "Пошук і аналіз інформації в інтернеті: ринки, конкуренти, інструменти, факти з джерелами.",
    },
}
EXECUTORS = ("game", "video", "trading", "research")

ACTION_DOC = """Щоб панель виконала дію, додай у КІНЕЦЬ відповіді блок:
```actions
[{"type": "...", ...}]
```
Доступні дії:
- delegate: {"type":"delegate","agent":"game|video|trading|research|<свій агент>","title":"...","brief":"що зробити, критерії готовності","important":true|false,"paths":["game/src"]}
- approval: {"type":"approval","action":"spend|real_trade|risk_limits|publish|delete|main_branch|server|node_new_action","title":"...","details":"..."}
- idea: {"type":"idea","text":"пропозиція покращення"}
- project: {"type":"project","name":"...","area":"game|video|trading|research|general","progress":0-100,"notes":"..."}
- create_agent: {"type":"create_agent","name":"latin_id","title":"Назва","role":"опис ролі"}
- restart_agent: {"type":"restart_agent","agent":"..."}
- node_job: {"type":"node_job","action":"ffmpeg_cut|ffmpeg_concat|ffmpeg_transcode|whisper_subtitles|burn_subtitles|comfy_generate|sd_generate","params":{...},"urgent":false}
- art_request: {"type":"art_request","cards":[{"name":"...","prompt":"опис зображення англійською","kind":"card|background|icon"}]}
- card: {"type":"card","name":"...","kind":"unit|spell|building","faction":"...","rarity":"common|rare|epic|legendary","cost":1,"attack":1,"health":1,"text":"ефект"}
- trade_demo: {"type":"trade_demo","side":"long|short","entry":0,"stop":0,"target":0,"reason":"..."}
Якщо дія не потрібна — блок не додавай. Не вигадуй інших типів."""


def ensure_agents() -> None:
    for name, a in BASE_AGENTS.items():
        if not db.one("SELECT name FROM agents WHERE name=?", (name,)):
            db.insert("agents", name=name, title=a["title"], role=a["role"], kind="base", created=db.now())


def get(name: str) -> dict | None:
    return db.one("SELECT * FROM agents WHERE name=? AND enabled=1", (name,))


def executors() -> list[str]:
    return [r["name"] for r in db.q("SELECT name FROM agents WHERE enabled=1 AND name NOT IN ('jarvis','controller')")]


def area(name: str) -> str:
    return BASE_AGENTS.get(name, {}).get("area", name if name not in BASE_AGENTS else "")


def session_id(name: str) -> str:
    r = get(name)
    return f"jarvis-{name}-g{r['generation'] if r else 1}"


def restart(name: str) -> bool:
    if not get(name):
        return False
    db.run("UPDATE agents SET generation=generation+1 WHERE name=?", (name,))
    return True


def create(name: str, title: str, role: str) -> bool:
    name = "".join(ch for ch in name.lower() if ch.isalnum() or ch == "_")[:24]
    if not name or name in BASE_AGENTS or db.one("SELECT name FROM agents WHERE name=?", (name,)):
        return False
    db.insert("agents", name=name, title=title[:60] or name, role=role[:800], kind="custom", created=db.now())
    return True


def instructions(name: str, context: str = "") -> str:
    a = get(name) or {"title": name, "role": ""}
    team = "\n".join(f"- {r['name']}: {r['title']} — {r['role'][:160]}" for r in db.q(
        "SELECT name, title, role FROM agents WHERE enabled=1 AND name NOT IN ('jarvis','controller')"))
    lang = "Відповідай українською, коротко й по суті."
    if name == "jarvis":
        body = (f"Ти — Джарвіс, персональний AI-асистент власника. {a['role']}\n"
                f"Виконавці:\n{team}\n"
                "Прості питання вирішуй сам. Якщо задача потребує роботи виконавців — коротко поясни план і "
                "роздай кроки діями delegate (важливі результати познач important:true, вкажи paths — папки, які агент змінює). "
                "Робочі файли — у " + WS + ".")
    elif name == "controller":
        body = ("Ти — Контролер команди. Перевір результат виконавця: чи виконано завдання, чи немає помилок, "
                "вигаданих фактів, ризиків, чужих захищених брендів, витоку ключів. "
                'ВЕРДИКТ дай ЛИШЕ JSON: {"ok": true|false, "score": 0-10, "notes": "що виправити"}.')
    else:
        body = (f"Ти — {a['title']} у команді Джарвіса. {a['role']}\n"
                "Виконай задачу повністю. Наприкінці коротко: що зроблено, де лежать файли, що лишилось.")
    parts = [body, lang, RULES_TEXT]
    if name != "controller":
        parts.append(ACTION_DOC)
    if context:
        parts.append("КОНТЕКСТ:\n" + context)
    return "\n\n".join(parts)
