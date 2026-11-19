"""Гра та бізнес: документи гри (сценарій з VLASTELIN), каталог карток, графіка, монетизація.

* Сценарій імпортується з VLASTELIN AI Office (файл експорту D1 або текст) — див. docs/GAME.md.
* Описи карток ігровий агент передає діями `card` / `art_request`; графіку малює ПК-вузол
  (ComfyUI / Stable Diffusion) в ЄДИНОМУ стилі (STYLE нижче), результат з'являється в каталозі.
* Монетизація — донати (косметика, підтримка) і банерна реклама; без pay-to-win.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

from . import db
from .config import settings
from .core import audit, bus

router = APIRouter(prefix="/api/game")
ART_DIR = settings.workspace / "game" / "art"

# Єдиний стиль графіки для всієї гри (однаковий префікс, негатив і розміри під 8 ГБ відеопам'яті)
STYLE = {
    "base": ("dark premium fantasy card game illustration, painterly digital art, dramatic rim light, "
             "deep navy and matte black palette with warm walnut and muted gold accents, subtle alpine mountains, "
             "consistent art direction, high detail, centered composition"),
    "negative": "text, letters, watermark, signature, logo, frame border, blurry, lowres, jpeg artifacts, deformed hands, extra fingers",
    "kinds": {
        "card": {"width": 512, "height": 768, "suffix": "single character or creature portrait, card art"},
        "background": {"width": 768, "height": 512, "suffix": "wide environment background, no characters, soft depth of field"},
        "icon": {"width": 512, "height": 512, "suffix": "game ui icon, simple bold silhouette, centered object, dark background"},
    },
}
RARITIES = ("common", "rare", "epic", "legendary")
KINDS = ("unit", "spell", "building")

# Стартовий набір карток на основі світу VLASTELIN (оригінальні назви; уточнюються з імпортованим сценарієм)
STARTER = [
    ("Вартовий Корони", "unit", "Корона", "common", 1, 1, 2, "Захисник: вороги мусять атакувати його першим."),
    ("Лицар Перевалу", "unit", "Корона", "rare", 3, 3, 3, "Коли входить у гру: дайте іншому союзнику +1 захисту."),
    ("Королівський Указ", "spell", "Корона", "common", 2, 0, 0, "Візьміть 1 карту. Якщо у вас є замок — ще 1."),
    ("Цитадель Властеліна", "building", "Корона", "legendary", 6, 0, 8, "На початку вашого ходу: +1 золото та лікування 1 союзнику."),
    ("Попелястий Послушник", "unit", "Орден Попелу", "common", 1, 2, 1, "Коли гине: завдає 1 шкоди ворожому герою."),
    ("Жриця Згаслого Вогню", "unit", "Орден Попелу", "epic", 4, 3, 4, "Ваші заклинання коштують на 1 менше."),
    ("Вогняна Печать", "spell", "Орден Попелу", "rare", 3, 0, 0, "Завдайте 3 шкоди. Якщо ціль загинула — візьміть карту."),
    ("Вовк Високогір'я", "unit", "Дикі Землі", "common", 2, 3, 1, "Ривок: може атакувати в хід появи."),
    ("Шаман Лавини", "unit", "Дикі Землі", "rare", 3, 2, 3, "Коли входить у гру: заморозьте ворожого бійця на 1 хід."),
    ("Гірський Велетень", "unit", "Дикі Землі", "epic", 6, 6, 7, "Отримує на 1 шкоди менше від усіх джерел."),
    ("Тіньовий Посередник", "unit", "Тіньова Гільдія", "common", 2, 2, 2, "Коли входить у гру: подивіться верхню карту суперника."),
    ("Контракт Гільдії", "spell", "Тіньова Гільдія", "epic", 4, 0, 0, "Візьміть під контроль ворожого бійця з атакою 3 або менше до кінця ходу."),
]


def art_prompt(name: str, kind: str, text: str, faction: str) -> str:
    return f"{name}, {faction} faction, {kind}; {text}"[:400]


def full_prompt(prompt: str, kind: str = "card") -> dict:
    k = STYLE["kinds"].get(kind, STYLE["kinds"]["card"])
    return {"prompt": f"{STYLE['base']}, {k['suffix']}, {prompt}", "negative": STYLE["negative"],
            "width": k["width"], "height": k["height"], "kind": kind}


# ---------- картки ----------
def add_card(c: dict, source: str = "owner") -> int:
    name = str(c.get("name", "")).strip()[:60]
    if not name:
        raise ValueError("Потрібна назва картки")
    vals = dict(kind=c.get("kind") if c.get("kind") in KINDS else "unit", faction=str(c.get("faction", ""))[:40],
                rarity=c.get("rarity") if c.get("rarity") in RARITIES else "common",
                cost=max(0, min(12, int(c.get("cost", 1) or 0))), attack=max(0, min(20, int(c.get("attack", 0) or 0))),
                health=max(0, min(30, int(c.get("health", 0) or 0))), text=str(c.get("text", ""))[:300])
    vals["art_prompt"] = str(c.get("art_prompt") or c.get("prompt") or art_prompt(name, vals["kind"], vals["text"], vals["faction"]))[:500]
    cur = db.one("SELECT id FROM cards WHERE name=?", (name,))
    if cur:
        db.update("cards", cur["id"], **vals)
        cid = cur["id"]
    else:
        cid = db.insert("cards", name=name, created=db.now(), **vals)
    audit(source, "card", f"#{cid} {name}")
    bus.publish("game", {"card": cid})
    return cid


def request_art(cid: int, actor: str = "owner", task_id: int | None = None, urgent: bool = False) -> str:
    c = db.one("SELECT * FROM cards WHERE id=?", (cid,))
    if not c:
        return "картку не знайдено"
    from . import node_hub

    params = full_prompt(c["art_prompt"] or c["name"], "card")
    params.update(seed=1000 + cid, out_name=f"card-{cid}")
    note = node_hub.enqueue("comfy_generate", params, task_id=task_id, urgent=urgent, ref=f"card:{cid}", actor=actor)
    db.update("cards", cid, art_status="queued")
    bus.publish("game", {"card": cid})
    return note


def on_art_result(job: dict, files: list[str]) -> None:
    """Викликається ПК-вузлом/хмарою, коли зображення готове."""
    ref = job.get("ref", "")
    if not ref.startswith("card:") or not files:
        return
    cid = int(ref.split(":")[1])
    db.update("cards", cid, art=files[0], art_status="done")
    audit("node", "art_ready", f"Картка #{cid}: {files[0]}")
    bus.publish("game", {"card": cid})


def apply_action(typ: str, a: dict, actor: str, task_id: int | None) -> str:
    if typ == "card":
        cid = add_card(a, actor)
        return f"Картка «{a.get('name')}» у каталозі (#{cid})"
    if typ == "art_request":
        notes = []
        for item in (a.get("cards") or [])[:12]:
            name = str(item.get("name", "")).strip()[:60]
            if not name:
                continue
            kind = item.get("kind", "card")
            if kind == "card":
                cur = db.one("SELECT id FROM cards WHERE name=?", (name,))
                cid = cur["id"] if cur else add_card({"name": name, "text": item.get("text", "")}, actor)
                if item.get("prompt"):
                    db.update("cards", cid, art_prompt=str(item["prompt"])[:500])
                notes.append(request_art(cid, actor, task_id, bool(a.get("urgent"))))
            else:  # фон або іконка — без картки в каталозі
                from . import node_hub

                params = full_prompt(str(item.get("prompt") or name), kind)
                params.update(seed=abs(hash(name)) % 100000, out_name=re.sub(r"\W+", "-", name.lower())[:40] or kind)
                notes.append(node_hub.enqueue("comfy_generate", params, task_id=task_id, ref=f"{kind}:{name}", actor=actor))
        return "Графіка: " + "; ".join(notes) if notes else ""
    return ""


# ---------- документи ----------
def _decode(raw: bytes) -> str:
    for enc in ("utf-8-sig", "utf-16"):
        try:
            text = raw.decode(enc)
            if enc == "utf-16" or "\x00" not in text:
                return text
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")


def parse_import(text: str) -> list[tuple[str, str]]:
    """Розбирає експорт VLASTELIN: JSON з `wrangler d1 execute --json` (agent_tasks / state ws) або звичайний текст."""
    docs: list[tuple[str, str]] = []
    try:
        data = json.loads(text)
    except ValueError:
        data = None
    if data is None:
        body = text.strip()
        if body:
            first = body.splitlines()[0].lstrip("# ").strip()[:120] or "Сценарій VLASTELIN"
            docs.append((first, body))
        return docs
    rows: list = []
    stack = [data]
    while stack:  # знаходимо всі об'єкти з полями title/result або k/v
        x = stack.pop()
        if isinstance(x, list):
            stack.extend(x)
        elif isinstance(x, dict):
            if "results" in x:
                stack.append(x["results"])
            elif {"title", "result"} <= set(x) or {"k", "v"} <= set(x):
                rows.append(x)
    for r in rows:
        if "result" in r:
            if r.get("status", "done") in ("done", "ready") and str(r.get("result", "")).strip():
                role = r.get("role", "")
                docs.append((f"[{role}] {r['title']}" if role else str(r["title"]), str(r["result"])))
        elif r.get("k") == "ws":
            try:
                g = json.loads(r["v"]).get("game", {}) if isinstance(r["v"], str) else r["v"].get("game", {})
            except (ValueError, AttributeError):
                g = {}
            concept = g.get("concept") or {}
            if concept:
                docs.append(("Концепт гри (VLASTELIN)", "\n".join(f"{k}: {v}" for k, v in concept.items() if v)))
            backlog = g.get("backlog") or []
            if backlog:
                docs.append(("Беклог гри (VLASTELIN)", "\n".join(f"- [{b.get('st', '')}] {b.get('title', '')}: {b.get('desc', '')}" for b in backlog)))
    return docs[:60]


def brief() -> str:
    docs = db.q("SELECT title, body FROM game_docs ORDER BY id")
    n = db.one("SELECT COUNT(*) AS n FROM cards")["n"]
    lines = [f"Каталог гри: {n} карток. Робоча папка коду: /opt/data/workspace/game (git, гілки agent/*)."]
    if docs:
        budget = 6000
        lines.append("ДОКУМЕНТИ ГРИ (сценарій VLASTELIN та інші):")
        for d in docs:
            chunk = d["body"][: max(300, budget // max(1, len(docs)))]
            lines.append(f"## {d['title']}\n{chunk}")
    else:
        lines.append("Сценарій ще не імпортовано — спирайся на docs/GAME.md (світ Властеліна, 4 фракції).")
    m = monetization()
    lines.append(f"Монетизація: донати ({', '.join(m['donations'])}); банери: {', '.join(m['ad_slots'])}. Жодного pay-to-win.")
    lines.append(f"Стиль графіки (для art_request пиши prompt англійською, стиль додасть панель): {STYLE['base'][:160]}…")
    return "\n".join(lines)


def monetization() -> dict:
    return db.get_setting("game_monetization", {
        "donations": ["косметичні рамки й сорочки карток", "набір «Підтримай розробника»", "сезонна косметика"],
        "ad_slots": ["нижній банер у меню", "банер на екрані результатів матчу"],
        "rules": "Без реклами під час бою; без продажу сили; донати — лише косметика й підтримка.",
        "donation_url": "",
    })


# ---------- маршрути ----------
@router.get("")
async def api_game():
    cards = db.q("SELECT * FROM cards ORDER BY faction, cost, id")
    docs = db.q("SELECT id, title, substr(body, 1, 400) AS preview, length(body) AS size, source, created FROM game_docs ORDER BY id")
    jobs = []
    try:
        from . import node_hub

        jobs = node_hub.jobs(ref_prefix="card:", limit=20)
    except ImportError:
        pass
    projects = db.q("SELECT * FROM projects WHERE area IN ('game','general','video','research','trading') ORDER BY updated DESC LIMIT 12")
    return {"cards": cards, "docs": docs, "monetization": monetization(), "style": STYLE, "jobs": jobs,
            "projects": projects, "stats": {"cards": len(cards), "with_art": sum(1 for c in cards if c["art"])}}


@router.get("/docs/{did}")
async def api_doc(did: int):
    d = db.one("SELECT * FROM game_docs WHERE id=?", (did,))
    if not d:
        raise HTTPException(404)
    return d


@router.post("/docs")
async def api_doc_add(request: Request):
    b = await request.json()
    title, body = str(b.get("title", "")).strip()[:120], str(b.get("body", "")).strip()[:100000]
    if not title or not body:
        raise HTTPException(400, "Потрібні назва й текст")
    did = db.insert("game_docs", title=title, body=body, source="owner", created=db.now())
    audit("owner", "game_doc", title)
    bus.publish("game", {})
    return {"id": did}


@router.delete("/docs/{did}")
async def api_doc_del(did: int):
    db.run("DELETE FROM game_docs WHERE id=?", (did,))
    audit("owner", "game_doc_deleted", f"#{did}", "warn")
    bus.publish("game", {})
    return {"ok": True}


@router.post("/import")
async def api_import(file: UploadFile = File(...)):
    raw = await file.read()
    if len(raw) > 5 * 1024 * 1024:
        raise HTTPException(413, "Файл завеликий (макс. 5 МБ)")
    docs = parse_import(_decode(raw))
    if not docs:
        raise HTTPException(400, "У файлі не знайдено сценарію чи документів гри")
    for title, body in docs:
        db.insert("game_docs", title=title[:120], body=body[:100000], source="vlastelin", created=db.now())
    audit("owner", "game_import", f"Імпортовано з VLASTELIN: {len(docs)} документів")
    bus.publish("game", {})
    return {"imported": len(docs), "titles": [t for t, _ in docs]}


@router.post("/cards")
async def api_card_save(request: Request):
    b = await request.json()
    try:
        return {"id": add_card(b)}
    except (ValueError, TypeError) as e:
        raise HTTPException(400, str(e))


@router.delete("/cards/{cid}")
async def api_card_del(cid: int):
    db.run("DELETE FROM cards WHERE id=?", (cid,))
    audit("owner", "card_deleted", f"#{cid}", "warn")
    bus.publish("game", {})
    return {"ok": True}


@router.post("/cards/{cid}/art")
async def api_card_art(cid: int, request: Request):
    b = await request.json() if request.headers.get("content-length", "0") != "0" else {}
    return {"note": request_art(cid, "owner", urgent=bool(b.get("urgent")))}


@router.post("/seed")
async def api_seed():
    n = 0
    for name, kind, faction, rarity, cost, atk, hp, text in STARTER:
        if not db.one("SELECT id FROM cards WHERE name=?", (name,)):
            add_card(dict(name=name, kind=kind, faction=faction, rarity=rarity, cost=cost, attack=atk, health=hp, text=text))
            n += 1
    return {"added": n}


@router.post("/monetization")
async def api_monetization(request: Request):
    b = await request.json()
    m = monetization()
    for k in ("donations", "ad_slots"):
        if isinstance(b.get(k), list):
            m[k] = [str(x)[:120] for x in b[k]][:10]
    if "rules" in b:
        m["rules"] = str(b["rules"])[:600]
    if "donation_url" in b:
        url = str(b["donation_url"]).strip()[:300]
        if url and not url.startswith("https://"):
            raise HTTPException(400, "Посилання має починатися з https://")
        m["donation_url"] = url
    db.set_setting("game_monetization", m)
    audit("owner", "monetization", json.dumps(m, ensure_ascii=False)[:500])
    return m


GAME_TASKS = {
    "architecture": ("Архітектура карткової веб-гри", "Спроєктуй архітектуру карткової веб-гри на основі документів гри: модулі (рушій правил, стан матчу, "
                     "колоди, ШІ суперника, інтерфейс, збереження, монетизація), структура папок у game/, формати даних карток. "
                     "Запиши docs/architecture.md у game/ і створи каркас коду. Важливий результат."),
    "balance": ("Баланс карток", "Проаналізуй баланс каталогу карток (вартість/атака/захист/ефекти), знайди перекоси, запропонуй правки таблицею "
                "і онови картки діями card. Важливий результат."),
    "code": ("Наступна фіча гри", "Візьми наступну незроблену фічу з беклогу (game/BACKLOG.md або документи гри), реалізуй у коді в гілці agent/<назва>, "
             "напиши тести, закоміть. Важливий результат."),
    "monetization": ("Монетизація", "Спроєктуй монетизацію: донати (лише косметика й підтримка) і банерна реклама (не під час бою). "
                     "Опиши екрани, місця банерів, ціни донатів, як не дратувати гравця. Додай заглушки в код (ad-slot, кнопка донату)."),
    "cards": ("Нові картки й графіка", "Придумай 6 нових карток, що доповнюють фракції з документів гри: додай їх діями card і замов графіку діями art_request "
              "(prompt англійською — опис персонажа/сцени без тексту)."),
}


@router.post("/agent")
async def api_game_agent(request: Request):
    b = await request.json()
    kind = str(b.get("kind", ""))
    if kind not in GAME_TASKS:
        raise HTTPException(400, "Невідома задача")
    title, brief_text = GAME_TASKS[kind]
    from .main import orch

    tid = orch().submit(f"Доручи ігровому агенту: {title}. {brief_text}", "panel")
    return {"task_id": tid}


@router.get("/art/{name}")
async def api_art(name: str):
    p = ART_DIR / Path(name).name
    if not p.is_file() or p.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp"):
        raise HTTPException(404)
    return FileResponse(p)
