"""ПК-вузол: черга важких задач (графіка, відео, субтитри) для домашнього комп'ютера.

Безпека — два рівні білого списку:
  1) сервер ставить у чергу лише дії з WHITELIST з перевіреними параметрами (жодних команд оболонки,
     шляхи — тільки всередині робочої папки);
  2) клієнт на ПК має власний список дозволених дій у config.toml і виконує лише їх.
Нова дія поза списком → запит на підтвердження власника (node_new_action); навіть після згоди ПК
виконає її лише якщо власник сам додасть її в локальний конфіг.

Вузол ходить на сервер через Tailscale: порт 8100 відкрито лише на адресі Tailscale, вхід — за NODE_TOKEN.
Якщо ПК вимкнено — задача чекає в черзі. Термінову можна виконати платним API лише після вашого «Дозволити».
"""
from __future__ import annotations

import asyncio
import hmac
import json
import re
import time
from pathlib import Path

import httpx
from fastapi import APIRouter, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response

from . import db, models, rules
from .config import settings
from .core import audit, bus

router = APIRouter(prefix="/node")
owner_router = APIRouter(prefix="/api/node")
ONLINE_SEC = 75
SENT_TIMEOUT = 3 * 3600

_PATH_RE = re.compile(r"^[\w\-./ ]{1,200}$")


def _rel(p, field: str) -> str:
    p = str(p or "").strip().lstrip("/")
    if not p or not _PATH_RE.match(p) or ".." in p.split("/"):
        raise ValueError(f"{field}: некоректний шлях (лише всередині робочої папки)")
    return p


def _num(v, lo, hi, field):
    try:
        x = float(v)
    except (TypeError, ValueError):
        raise ValueError(f"{field}: має бути число")
    if not lo <= x <= hi:
        raise ValueError(f"{field}: від {lo} до {hi}")
    return x


def _img(p: dict) -> dict:
    prompt = str(p.get("prompt", "")).strip()
    if not prompt:
        raise ValueError("prompt: порожній")
    return {"prompt": prompt[:1500], "negative": str(p.get("negative", ""))[:600],
            "width": int(_num(p.get("width", 512), 256, 1344, "width")) // 8 * 8,
            "height": int(_num(p.get("height", 768), 256, 1344, "height")) // 8 * 8,
            "seed": int(_num(p.get("seed", 1), 0, 2**31 - 1, "seed")),
            "steps": int(_num(p.get("steps", 28), 4, 60, "steps")),
            "kind": str(p.get("kind", "card"))[:20],
            "out_name": re.sub(r"[^\w\-]", "", str(p.get("out_name", "image")))[:60] or "image"}


def _cut(p):
    return {"input": _rel(p.get("input"), "input"), "output": _rel(p.get("output"), "output"),
            "start": _num(p.get("start", 0), 0, 36000, "start"), "end": _num(p.get("end", 1), 0.1, 36000, "end")}


def _concat(p):
    ins = p.get("inputs") or []
    if not isinstance(ins, list) or not 2 <= len(ins) <= 50:
        raise ValueError("inputs: від 2 до 50 файлів")
    return {"inputs": [_rel(x, "inputs") for x in ins], "output": _rel(p.get("output"), "output")}


def _transcode(p):
    preset = p.get("preset", "youtube_1080p")
    if preset not in ("youtube_1080p", "shorts_vertical", "audio_mp3", "preview_480p"):
        raise ValueError("preset: youtube_1080p | shorts_vertical | audio_mp3 | preview_480p")
    return {"input": _rel(p.get("input"), "input"), "output": _rel(p.get("output"), "output"), "preset": preset}


def _whisper(p):
    model = p.get("model", "medium")
    if model not in ("small", "medium", "large-v3"):
        raise ValueError("model: small | medium | large-v3")
    return {"input": _rel(p.get("input"), "input"), "output": _rel(p.get("output") or (str(p.get("input")) + ".srt"), "output"),
            "language": re.sub(r"[^a-z]", "", str(p.get("language", "uk")))[:5] or "uk", "model": model}


def _burn(p):
    return {"input": _rel(p.get("input"), "input"), "subtitles": _rel(p.get("subtitles"), "subtitles"),
            "output": _rel(p.get("output"), "output")}


WHITELIST = {
    "ping": lambda p: {},
    "comfy_generate": _img,
    "sd_generate": _img,
    "ffmpeg_cut": _cut,
    "ffmpeg_concat": _concat,
    "ffmpeg_transcode": _transcode,
    "whisper_subtitles": _whisper,
    "burn_subtitles": _burn,
    "transcribe": lambda p: {"input": _rel(p.get("input"), "input"), "language": "uk"},
}
# Орієнтовна ціна платного запасного варіанту (Stability AI, ~3 кредити за зображення)
CLOUD_PRICE = {"comfy_generate": 0.03, "sd_generate": 0.03}


# ---------- стан ----------
def node_row() -> dict | None:
    return db.one("SELECT * FROM nodes ORDER BY last_seen DESC LIMIT 1")


def online() -> bool:
    r = node_row()
    return bool(r and time.time() - r["last_seen"] < ONLINE_SEC)


def queued_count() -> int:
    return db.one("SELECT COUNT(*) AS n FROM node_jobs WHERE status IN ('queued','sent')")["n"]


def jobs(ref_prefix: str = "", limit: int = 30) -> list[dict]:
    if ref_prefix:
        return db.q("SELECT * FROM node_jobs WHERE ref LIKE ? ORDER BY id DESC LIMIT ?", (ref_prefix + "%", limit))
    return db.q("SELECT * FROM node_jobs ORDER BY id DESC LIMIT ?", (limit,))


def status() -> dict:
    r = node_row()
    info = json.loads(r["info"]) if r else {}
    return {"online": online(), "name": r["name"] if r else "", "last_seen": r["last_seen"] if r else None,
            "gpu": info.get("gpu", ""), "actions": info.get("actions", []), "tools": info.get("tools", {}),
            "queued": queued_count(), "jobs": jobs(limit=15), "whitelist": sorted(WHITELIST)}


# ---------- постановка задач ----------
def enqueue(action: str, params: dict, task_id: int | None = None, urgent: bool = False, ref: str = "",
            actor: str = "jarvis") -> str:
    if action not in WHITELIST:
        aid = rules.request_approval("node_new_action", f"Нова дія на ПК: {action}",
                                     json.dumps(params, ensure_ascii=False)[:1500],
                                     {"action": action, "params": params, "ref": ref}, actor, task_id)
        return f"дія «{action}» поза білим списком — потрібне ваше підтвердження (#{aid})"
    try:
        clean = WHITELIST[action](params or {})
    except ValueError as e:
        audit(actor, "node_job_rejected", f"{action}: {e}", "warn")
        return f"задачу ПК відхилено: {e}"
    jid = db.insert("node_jobs", task_id=task_id, action=action, params=clean, urgent=int(bool(urgent)), ref=ref[:120],
                    created=db.now(), updated=db.now())
    audit(actor, "node_job", f"#{jid} {action} {ref}")
    bus.publish("node", {"job": jid})
    if online():
        return f"задача ПК #{jid} ({action}) у черзі"
    if urgent:
        _ask_cloud(jid, actor, task_id)
        return f"ПК офлайн: задача #{jid} чекає; для термінового виконання через платний API потрібне ваше підтвердження"
    return f"ПК офлайн: задача #{jid} ({action}) чекає в черзі, доки комп'ютер увімкнеться"


def _ask_cloud(jid: int, actor: str, task_id: int | None) -> None:
    j = db.one("SELECT * FROM node_jobs WHERE id=?", (jid,))
    price = CLOUD_PRICE.get(j["action"])
    if price is None or db.one("SELECT id FROM approvals WHERE action='cloud_fallback' AND status='pending' AND payload LIKE ?",
                               (f'%"job_id": {jid}%',)):
        return
    rules.request_approval("cloud_fallback", f"Термінова задача #{jid} ({j['action']}) через платний API",
                           f"ПК-вузол офлайн. Виконати через Stability AI приблизно за ${price:.2f}?",
                           {"job_id": jid, "est_usd": price}, actor, task_id)


def enqueue_from_agent(a: dict, actor: str, task_id: int) -> str:
    return enqueue(str(a.get("action", "")), dict(a.get("params") or {}), task_id, bool(a.get("urgent")),
                   str(a.get("ref", ""))[:120], actor)


def enqueue_approved(p: dict, task_id: int | None) -> str:
    """Власник погодив нову дію: ставимо в чергу як є. ПК виконає її, лише якщо дію додано в його локальний список."""
    action = re.sub(r"[^\w]", "", str(p.get("action", "")))[:40]
    params = p.get("params") if isinstance(p.get("params"), dict) else {}
    jid = db.insert("node_jobs", task_id=task_id, action=action, params=params, ref=str(p.get("ref", ""))[:120],
                    created=db.now(), updated=db.now())
    audit("owner", "node_job_approved", f"#{jid} {action} (поза білим списком, за підтвердженням)", "warn")
    return f"задачу ПК #{jid} поставлено; ПК виконає її, лише якщо «{action}» додано в його config.toml"


def cloud_declined(p: dict) -> None:
    audit("owner", "cloud_declined", f"Задача ПК #{p.get('job_id')} чекатиме на ПК")


async def run_cloud(job_id) -> None:
    j = db.one("SELECT * FROM node_jobs WHERE id=?", (int(job_id or 0),))
    if not j or j["status"] not in ("queued",):
        return
    if j["action"] not in CLOUD_PRICE or not settings.stability_key:
        db.update("node_jobs", j["id"], status="error", updated=db.now(),
                  error="Платний API для цієї дії не налаштовано (STABILITY_API_KEY) — задача лишається для ПК")
        db.update("node_jobs", j["id"], status="queued")
        audit("system", "cloud_unavailable", f"#{j['id']}: немає платного API", "warn")
        return
    p = json.loads(j["params"])
    ratio = "2:3" if p["height"] > p["width"] else "3:2" if p["width"] > p["height"] else "1:1"
    db.update("node_jobs", j["id"], status="sent", node="cloud:stability", updated=db.now())
    try:
        async with httpx.AsyncClient(timeout=120) as c:
            r = await c.post("https://api.stability.ai/v2beta/stable-image/generate/core",
                             headers={"Authorization": f"Bearer {settings.stability_key}", "Accept": "image/*"},
                             files={"none": ("", "")},
                             data={"prompt": p["prompt"], "negative_prompt": p["negative"], "aspect_ratio": ratio,
                                   "seed": str(p["seed"]), "output_format": "png"})
        if r.status_code != 200:
            raise RuntimeError(f"Stability AI: HTTP {r.status_code} {r.text[:200]}")
        name = _save_output(j, f"{p['out_name']}.png", r.content)
        models.book_usd("node", CLOUD_PRICE[j["action"]], f"Stability AI: задача ПК #{j['id']}", j["task_id"])
        _finish(j, "done", {"files": [name], "via": "cloud"}, "", [name])
    except Exception as e:
        db.update("node_jobs", j["id"], status="error", error=str(e)[:500], updated=db.now())
        audit("system", "cloud_error", f"#{j['id']}: {e}", "error")


def _save_output(j: dict, filename: str, data: bytes) -> str:
    """Зберігає результат у робочу папку. Повертає ім'я (для графіки) або відносний шлях."""
    filename = Path(filename).name
    if j["action"] in ("comfy_generate", "sd_generate"):
        from .game import ART_DIR

        ART_DIR.mkdir(parents=True, exist_ok=True)
        (ART_DIR / filename).write_bytes(data)
        return filename
    params = json.loads(j["params"])
    rel = params.get("output") if filename == Path(params.get("output", "")).name else f"node_out/{j['id']}/{filename}"
    dest = settings.workspace / _rel(rel, "output")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return rel


def _finish(j: dict, status: str, result: dict, error: str, files: list[str]) -> None:
    db.update("node_jobs", j["id"], status=status, result=result, error=error[:1000], updated=db.now())
    audit("node", "node_job_" + status, f"#{j['id']} {j['action']}" + (f": {error}" if error else ""),
          "error" if status == "error" else "info")
    bus.publish("node", {"job": j["id"], "status": status})
    if status == "done" and j["ref"]:
        from . import game

        game.on_art_result(j, files)
    if status == "error" and j["ref"].startswith("card:"):
        db.update("cards", int(j["ref"].split(":")[1]), art_status="error")
    if j["task_id"] and status in ("done", "error"):
        from .orchestrator import post

        t = db.one("SELECT source FROM tasks WHERE id=?", (j["task_id"],))
        if t and not j["ref"].startswith("card:"):
            msg = (f"ПК-вузол виконав #{j['id']} ({j['action']}): " + ", ".join(files)) if status == "done" else \
                  f"⚠ ПК-вузол: задача #{j['id']} ({j['action']}) — помилка: {error}"
            post("jarvis", msg, t["source"], j["task_id"])


async def transcribe_via_node(path: Path) -> str:
    if not online():
        return ""
    rel = f"voice_in/{path.name}"
    dest = settings.workspace / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(path.read_bytes())
    jid = db.insert("node_jobs", action="transcribe", params={"input": rel, "language": "uk"}, urgent=1,
                    created=db.now(), updated=db.now())
    for _ in range(90):
        await asyncio.sleep(1)
        j = db.one("SELECT status, result FROM node_jobs WHERE id=?", (jid,))
        if j["status"] in ("done", "error"):
            return str(json.loads(j["result"] or "{}").get("text", "")) if j["status"] == "done" else ""
    return ""


# ---------- API для вузла (Tailscale + NODE_TOKEN) ----------
def _auth(token: str | None) -> None:
    if not settings.node_token or not token or not hmac.compare_digest(token, settings.node_token):
        raise HTTPException(401, "Невірний токен вузла")


@router.post("/heartbeat")
async def hb(request: Request, x_node_token: str | None = Header(None)):
    _auth(x_node_token)
    b = await request.json()
    name = re.sub(r"[^\w\-. ]", "", str(b.get("name", "pc")))[:40] or "pc"
    was = online()
    info = {"gpu": str(b.get("gpu", ""))[:80], "actions": [str(a)[:40] for a in (b.get("actions") or [])][:30],
            "tools": {k: bool(v) for k, v in (b.get("tools") or {}).items()} if isinstance(b.get("tools"), dict) else {},
            "version": str(b.get("version", ""))[:20], "busy": b.get("busy")}
    db.run("INSERT INTO nodes (name, last_seen, info) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET last_seen=excluded.last_seen, info=excluded.info",
           (name, time.time(), json.dumps(info, ensure_ascii=False)))
    if b.get("busy"):
        db.run("UPDATE node_jobs SET updated=? WHERE id=? AND status='sent'", (db.now(), int(b["busy"])))
    if not was:
        audit("node", "node_online", f"ПК-вузол «{name}» онлайн ({info['gpu']})")
        bus.publish("node", {"online": True})
    return {"ok": True, "whitelist": sorted(WHITELIST), "halted": bool(db.get_setting("halted", False))}


def _next_job(name: str) -> dict | None:
    if db.get_setting("halted", False):
        return None
    j = db.one("SELECT * FROM node_jobs WHERE status='queued' ORDER BY urgent DESC, id LIMIT 1")
    if not j:
        return None
    if db.run("UPDATE node_jobs SET status='sent', node=?, updated=? WHERE id=? AND status='queued'", (name, db.now(), j["id"])) != 1:
        return None
    j["params"] = json.loads(j["params"])
    bus.publish("node", {"job": j["id"], "status": "sent"})
    return {"id": j["id"], "action": j["action"], "params": j["params"]}


@router.get("/jobs/next")
async def next_job(wait: int = 25, name: str = "pc", x_node_token: str | None = Header(None)):
    _auth(x_node_token)
    end = time.time() + max(0, min(wait, 50))
    while True:
        j = _next_job(name)
        if j:
            return j
        if time.time() >= end:
            return Response(status_code=204)
        await asyncio.sleep(1)


@router.post("/jobs/{jid}/result")
async def job_result(jid: int, status: str = Form(...), result: str = Form("{}"), error: str = Form(""),
                     files: list[UploadFile] = File(default=[]), x_node_token: str | None = Header(None)):
    _auth(x_node_token)
    j = db.one("SELECT * FROM node_jobs WHERE id=?", (jid,))
    if not j:
        raise HTTPException(404)
    if j["status"] != "sent":
        return {"ok": False, "detail": f"задача вже має статус {j['status']}"}
    try:
        res = json.loads(result)
        if not isinstance(res, dict):
            res = {}
    except ValueError:
        res = {}
    saved = []
    for f in files[:10]:
        data = await f.read()
        if len(data) > 2 * 1024**3:
            continue
        saved.append(_save_output(j, f.filename or "out.bin", data))
    res["files"] = saved
    _finish(j, "done" if status == "done" else "error", res, error if status != "done" else "", saved)
    return {"ok": True, "files": saved}


@router.get("/files")
async def node_file(path: str, x_node_token: str | None = Header(None)):
    _auth(x_node_token)
    try:
        p = settings.workspace / _rel(path, "path")
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not p.is_file():
        raise HTTPException(404)
    return FileResponse(p)


# ---------- API для власника ----------
@owner_router.get("")
async def api_node():
    return status()


@owner_router.post("/jobs/{jid}/cancel")
async def api_cancel(jid: int):
    n = db.run("UPDATE node_jobs SET status='cancelled', updated=? WHERE id=? AND status IN ('queued','sent','error')", (db.now(), jid))
    if not n:
        raise HTTPException(409, "Задачу не можна скасувати")
    audit("owner", "node_job_cancel", f"#{jid}")
    bus.publish("node", {})
    return {"ok": True}


@owner_router.post("/jobs/{jid}/cloud")
async def api_cloud(jid: int):
    j = db.one("SELECT * FROM node_jobs WHERE id=? AND status='queued'", (jid,))
    if not j:
        raise HTTPException(409, "Задача не в черзі")
    if j["action"] not in CLOUD_PRICE:
        raise HTTPException(400, "Для цієї дії немає платного запасного API")
    _ask_cloud(jid, "owner", j["task_id"])
    return {"ok": True}


@owner_router.post("/ping")
async def api_ping():
    return {"note": enqueue("ping", {}, actor="owner")}


async def background(orch) -> None:
    """Повертає в чергу задачі, що «зависли» на вимкненому ПК; стежить за онлайн-статусом."""
    was = online()
    while True:
        await asyncio.sleep(30)
        stale = db.q("SELECT id FROM node_jobs WHERE status='sent' AND node NOT LIKE 'cloud:%' AND updated<?",
                     (db.now() - (SENT_TIMEOUT if online() else 300),))
        for s in stale:
            db.update("node_jobs", s["id"], status="queued", updated=db.now())
            audit("node", "node_job_requeued", f"#{s['id']} повернуто в чергу (ПК не відповів)", "warn")
        now = online()
        if was and not now:
            audit("node", "node_offline", "ПК-вузол офлайн", "warn")
            bus.publish("node", {"online": False})
        was = now
