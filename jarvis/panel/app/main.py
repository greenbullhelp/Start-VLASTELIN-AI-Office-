"""Веб-сервер приватної панелі Джарвіса (FastAPI).

Усі /api/* — лише після входу (cookie-сесія + 2FA). Змінювати дані можна лише запитами
із заголовком X-Jarvis: 1 (захист від підробки запитів з чужих сайтів) .
/node/* — окремий вхід для ПК-вузла за NODE_TOKEN.
"""
from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import agents, auth, db, models, reports, rules, telegram, voice
from .brain import make_brain
from .config import settings
from .core import audit, bus, today
from .orchestrator import Orchestrator, post

STATIC = Path(__file__).resolve().parent.parent / "static"
state: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.conn()
    brain = make_brain()
    orch = Orchestrator(brain)
    state.update(brain=brain, orch=orch, bg=[])
    orch.start()
    bg = state["bg"]
    bg.append(asyncio.create_task(reports.scheduler(int(db.get_setting("report_hour", settings.report_hour)))))
    bg.append(asyncio.create_task(telegram.run(orch)))
    for mod in ("trading", "node_hub"):
        try:
            m = __import__(f"app.{mod}", fromlist=["background"])
            if hasattr(m, "background"):
                bg.append(asyncio.create_task(m.background(orch)))
        except ImportError:
            pass
    audit("system", "startup", f"Панель запущено, мозок: {brain.name}")
    yield
    for t in bg:
        t.cancel()
    await orch.shutdown()


app = FastAPI(title="Jarvis", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Permissions-Policy"] = "microphone=(self), camera=()"
    resp.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; "
        "style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; "
        "base-uri 'none'; form-action 'self'")
    return resp


def client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    return (fwd.split(",")[0].strip() if fwd else "") or (request.client.host if request.client else "?")


def require_owner(request: Request) -> None:
    if not auth.check_session(request.cookies.get("jsid")):
        raise HTTPException(401, "Потрібен вхід")
    if request.method not in ("GET", "HEAD") and request.headers.get("x-jarvis") != "1":
        raise HTTPException(403, "Запит відхилено")


Owner = Depends(require_owner)


def orch() -> Orchestrator:
    return state["orch"]


def _cookie(resp: JSONResponse, token: str) -> JSONResponse:
    resp.set_cookie("jsid", token, max_age=settings.session_days * 86400, httponly=True,
                    secure=settings.cookie_secure, samesite="strict", path="/")
    return resp


# ---------- вхід ----------
@app.post("/api/login")
async def api_login(request: Request):
    if request.headers.get("x-jarvis") != "1":
        raise HTTPException(403)
    b = await request.json()
    res = await asyncio.to_thread(auth.login, str(b.get("password", ""))[:200], str(b.get("code", "")),
                                  client_ip(request), request.headers.get("user-agent", ""))
    if res.get("ok"):
        return _cookie(JSONResponse({"ok": True}), res["token"])
    return JSONResponse(res, status_code=200 if res.get("enroll") else 401)


@app.post("/api/2fa/enroll")
async def api_enroll(request: Request):
    if request.headers.get("x-jarvis") != "1":
        raise HTTPException(403)
    b = await request.json()
    res = auth.finish_enroll(str(b.get("enroll_token", "")), str(b.get("code", "")), client_ip(request),
                             request.headers.get("user-agent", ""))
    if res.get("ok"):
        return _cookie(JSONResponse({"ok": True}), res["token"])
    return JSONResponse(res, status_code=401)


@app.post("/api/logout")
async def api_logout(request: Request):
    auth.drop_session(request.cookies.get("jsid"))
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("jsid", path="/")
    return resp


@app.post("/api/logout-all", dependencies=[Owner])
async def api_logout_all():
    auth.drop_all_sessions()
    audit("owner", "logout_all", "Усі сесії завершено", "warn")
    return {"ok": True}


@app.get("/api/me")
async def api_me(request: Request):
    return {"auth": auth.check_session(request.cookies.get("jsid")), "configured": bool(auth.owner())}


# ---------- загальний стан ----------
@app.get("/api/state", dependencies=[Owner])
async def api_state():
    brain = state["brain"]
    h = await brain.health()
    node = {}
    try:
        from . import node_hub

        node = node_hub.status()
    except ImportError:
        pass
    return {
        "owner": settings.owner_name, "halted": bool(db.get_setting("halted", False)),
        "brain": {"name": brain.name, **h}, "spent": models.spent_today(), "limit": models.daily_limit(),
        "model_mode": models.mode(), "models": {"cheap": settings.model_cheap, "medium": settings.model_medium,
                                                "strong": settings.model_strong},
        "approvals": len(rules.pending()), "telegram": telegram.enabled(), "node": node,
        "stt": voice.available(), "day": today(),
        "running": db.one("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('running','review_running')")["n"],
        "queued": db.one("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('queued','waiting','review')")["n"],
        "settings": {"tts": db.get_setting("tts", True), "voice_name": db.get_setting("voice_name", ""),
                     "report_hour": int(db.get_setting("report_hour", settings.report_hour))},
    }


@app.get("/api/stream", dependencies=[Owner])
async def api_stream(request: Request):
    q = bus.subscribe()

    async def gen():
        try:
            yield "retry: 3000\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=20)
                    yield f"data: {msg}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            bus.unsubscribe(q)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------- чат ----------
@app.get("/api/messages", dependencies=[Owner])
async def api_messages(before: int = 0, limit: int = 60):
    limit = max(1, min(limit, 200))
    if before:
        rows = db.q("SELECT * FROM messages WHERE id<? ORDER BY id DESC LIMIT ?", (before, limit))
    else:
        rows = db.q("SELECT * FROM messages ORDER BY id DESC LIMIT ?", (limit,))
    for r in rows:
        r["meta"] = json.loads(r["meta"] or "{}")
    return rows[::-1]


@app.post("/api/chat", dependencies=[Owner])
async def api_chat(request: Request):
    b = await request.json()
    text = str(b.get("text", "")).strip()
    if not text:
        raise HTTPException(400, "Порожнє повідомлення")
    tid = orch().submit(text, "panel", str(b.get("model", "")))
    return {"task_id": tid}


@app.post("/api/voice", dependencies=[Owner])
async def api_voice(audio: UploadFile = File(...), transcript: str = Form(""), peaks: str = Form("[]"),
                    duration: float = Form(0), model: str = Form("")):
    data = await audio.read()
    ext = "mp4" if "mp4" in (audio.content_type or "") or (audio.filename or "").endswith(".mp4") else "webm"
    path = voice.save_audio(data, ext)
    text = transcript.strip()
    if not text:
        text = await voice.transcribe(path)
    try:
        pk = [round(float(x), 3) for x in json.loads(peaks)][:120]
    except (ValueError, TypeError):
        pk = []
    meta = {"voice": path.name, "peaks": pk, "duration": round(duration, 1)}
    if not text:
        post("owner", "🎤 (голосове)", "panel", None, meta)
        post("jarvis", "Голосове збережено, але розпізнати мову не вдалося. Спробуйте ще раз або напишіть текстом.")
        return {"task_id": None, "text": ""}
    tid = orch().submit(text, "panel", model, meta)
    return {"task_id": tid, "text": text}


@app.get("/api/voice/{name}", dependencies=[Owner])
async def api_voice_file(name: str):
    p = (settings.data_dir / "voice" / Path(name).name)
    if not p.is_file():
        raise HTTPException(404)
    return FileResponse(p)


# ---------- задачі й підтвердження ----------
@app.get("/api/tasks", dependencies=[Owner])
async def api_tasks(limit: int = 100, status: str = ""):
    if status:
        rows = db.q("SELECT * FROM tasks WHERE status=? ORDER BY id DESC LIMIT ?", (status, min(limit, 500)))
    else:
        rows = db.q("SELECT * FROM tasks ORDER BY id DESC LIMIT ?", (min(limit, 500),))
    for r in rows:
        r["result"] = r["result"][:600]
        r["brief"] = r["brief"][:400]
    return rows


@app.get("/api/tasks/{tid}", dependencies=[Owner])
async def api_task(tid: int):
    t = db.one("SELECT * FROM tasks WHERE id=?", (tid,))
    if not t:
        raise HTTPException(404)
    t["children"] = db.q("SELECT id, agent, title, status, cost FROM tasks WHERE parent_id=?", (tid,))
    t["costs"] = db.q("SELECT agent, model, usd, tokens_in, tokens_out, ts FROM costs WHERE task_id=?", (tid,))
    return t


@app.post("/api/tasks/{tid}/{act}", dependencies=[Owner])
async def api_task_act(tid: int, act: str):
    if act == "retry":
        ok = orch().retry(tid)
    elif act == "cancel":
        ok = orch().cancel(tid)
    else:
        raise HTTPException(404)
    if not ok:
        raise HTTPException(409, "Дію неможливо виконати для цієї задачі")
    return {"ok": True}


@app.get("/api/approvals", dependencies=[Owner])
async def api_approvals(all: int = 0):
    if all:
        return db.q("SELECT * FROM approvals ORDER BY id DESC LIMIT 100")
    return rules.pending()


@app.post("/api/approvals/{aid}", dependencies=[Owner])
async def api_decide(aid: int, request: Request):
    b = await request.json()
    ap = rules.decide(aid, bool(b.get("approve")), str(b.get("note", "")))
    if not ap:
        raise HTTPException(409, "Запит уже вирішено або не існує")
    return {"ok": True, "result": orch().on_decision(ap)}


@app.post("/api/stop", dependencies=[Owner])
async def api_stop():
    return await orch().stop_all("owner", "кнопка «Стоп» у панелі")


@app.post("/api/resume", dependencies=[Owner])
async def api_resume():
    orch().resume("owner")
    return {"ok": True}


@app.get("/api/audit", dependencies=[Owner])
async def api_audit(limit: int = 100, level: str = ""):
    if level:
        return db.q("SELECT * FROM audit WHERE level=? ORDER BY id DESC LIMIT ?", (level, min(limit, 1000)))
    return db.q("SELECT * FROM audit ORDER BY id DESC LIMIT ?", (min(limit, 1000),))


# ---------- проєкти та ідеї (власник керує напряму) ----------
@app.get("/api/projects", dependencies=[Owner])
async def api_projects():
    return db.q("SELECT * FROM projects ORDER BY status, updated DESC")


@app.post("/api/projects", dependencies=[Owner])
async def api_project_save(request: Request):
    b = await request.json()
    name = str(b.get("name", "")).strip()[:80]
    if not name:
        raise HTTPException(400, "Потрібна назва")
    fields = dict(name=name, area=str(b.get("area", "general"))[:20], status=str(b.get("status", "active"))[:20],
                  progress=max(0, min(100, int(b.get("progress", 0) or 0))), notes=str(b.get("notes", ""))[:2000],
                  updated=db.now())
    if b.get("id"):
        db.update("projects", int(b["id"]), **fields)
        pid = int(b["id"])
    else:
        pid = db.insert("projects", created=db.now(), **fields)
    audit("owner", "project_saved", name)
    bus.publish("projects", {})
    return {"id": pid}


@app.delete("/api/projects/{pid}", dependencies=[Owner])
async def api_project_del(pid: int):
    db.run("DELETE FROM projects WHERE id=?", (pid,))
    audit("owner", "project_deleted", f"#{pid}", "warn")
    bus.publish("projects", {})
    return {"ok": True}


@app.get("/api/ideas", dependencies=[Owner])
async def api_ideas():
    return db.q("SELECT * FROM ideas ORDER BY id DESC LIMIT 300")


@app.post("/api/ideas", dependencies=[Owner])
async def api_idea_add(request: Request):
    b = await request.json()
    if b.get("id"):
        db.update("ideas", int(b["id"]), status=str(b.get("status", "new"))[:20])
        return {"ok": True}
    text = str(b.get("text", "")).strip()[:1000]
    if not text:
        raise HTTPException(400)
    iid = db.insert("ideas", text=text, source="owner", created=db.now())
    bus.publish("ideas", {})
    return {"id": iid}


@app.post("/api/ideas/{iid}/task", dependencies=[Owner])
async def api_idea_task(iid: int):
    i = db.one("SELECT * FROM ideas WHERE id=?", (iid,))
    if not i:
        raise HTTPException(404)
    db.update("ideas", iid, status="in_work")
    tid = orch().submit(f"Опрацюй ідею: {i['text']}", "panel")
    return {"task_id": tid}


@app.delete("/api/ideas/{iid}", dependencies=[Owner])
async def api_idea_del(iid: int):
    db.run("DELETE FROM ideas WHERE id=?", (iid,))
    bus.publish("ideas", {})
    return {"ok": True}


# ---------- агенти (жива схема) ----------
@app.get("/api/agents", dependencies=[Owner])
async def api_agents():
    day = today()
    out = []
    for a in db.q("SELECT * FROM agents WHERE enabled=1 ORDER BY kind, rowid"):
        name = a["name"]
        if name == "controller":
            cur = db.one("SELECT id, title, status FROM tasks WHERE status='review_running' ORDER BY id LIMIT 1")
            waiting = db.one("SELECT COUNT(*) AS n FROM tasks WHERE status='review'")["n"]
        else:
            cur = db.one("SELECT id, title, status FROM tasks WHERE agent=? AND status='running' ORDER BY id LIMIT 1", (name,))
            waiting = db.one("SELECT COUNT(*) AS n FROM tasks WHERE agent=? AND status IN ('queued','waiting')", (name,))["n"]
        cost = db.one("SELECT COALESCE(SUM(usd),0) AS s FROM costs WHERE agent=? AND day=?", (name, day))["s"]
        last_fail = db.one("SELECT id, error FROM tasks WHERE agent=? AND status='failed' ORDER BY id DESC LIMIT 1", (name,))
        meta = agents.BASE_AGENTS.get(name, {})
        status = "working" if cur else ("waiting" if waiting else "idle")
        if db.get_setting("halted", False):
            status = "stopped"
        out.append({"name": name, "title": a["title"], "icon": meta.get("icon", "◇"), "role": a["role"],
                    "kind": a["kind"], "generation": a["generation"], "status": status, "current": cur,
                    "waiting": waiting, "cost_today": round(cost, 4), "last_fail": last_fail})
    locks = db.q("SELECT * FROM locks")
    node = {}
    try:
        from . import node_hub

        node = node_hub.status()
    except ImportError:
        pass
    return {"agents": out, "locks": locks, "node": node, "halted": bool(db.get_setting("halted", False))}


@app.post("/api/agents/{name}/restart", dependencies=[Owner])
async def api_agent_restart(name: str):
    if not agents.restart(name):
        raise HTTPException(404)
    audit("owner", "restart_agent", name)
    bus.publish("agents", {})
    return {"ok": True}


# ---------- звіти, витрати, налаштування ----------
@app.get("/api/reports", dependencies=[Owner])
async def api_reports():
    return reports.list_reports()


@app.post("/api/reports/now", dependencies=[Owner])
async def api_report_now():
    rep = reports.make_report(save=True)
    telegram.send_owner(rep["text"])
    return rep


@app.get("/api/costs", dependencies=[Owner])
async def api_costs(days: int = 14):
    rows = db.q("SELECT day, SUM(usd) AS usd FROM costs GROUP BY day ORDER BY day DESC LIMIT ?", (min(days, 90),))
    return {"today": models.summary(), "days": rows[::-1]}


@app.get("/api/settings", dependencies=[Owner])
async def api_settings_get():
    return {"model_mode": models.mode(), "daily_budget_usd": models.daily_limit(),
            "tts": db.get_setting("tts", True), "voice_name": db.get_setting("voice_name", ""),
            "report_hour": int(db.get_setting("report_hour", settings.report_hour)),
            "models": {"cheap": settings.model_cheap, "medium": settings.model_medium, "strong": settings.model_strong},
            "prices": {k: list(v) for k, v in settings.prices.items()}, "brain": settings.brain,
            "telegram": telegram.enabled(), "stt": voice.available()}


@app.post("/api/settings", dependencies=[Owner])
async def api_settings_set(request: Request):
    b = await request.json()
    changed = []
    if b.get("model_mode") in ("auto", *models.TIERS):
        db.set_setting("model_mode", b["model_mode"])
        changed.append(f"модель: {b['model_mode']}")
    if "daily_budget_usd" in b:
        v = float(b["daily_budget_usd"])
        if not 0 < v <= 100:
            raise HTTPException(400, "Ліміт має бути від $0.01 до $100 на день")
        db.set_setting("daily_budget_usd", round(v, 2))
        changed.append(f"денний ліміт ${v:.2f}")
    if "tts" in b:
        db.set_setting("tts", bool(b["tts"]))
    if "voice_name" in b:
        db.set_setting("voice_name", str(b["voice_name"])[:100])
    if "report_hour" in b:
        h = int(b["report_hour"])
        if 0 <= h <= 23:
            db.set_setting("report_hour", h)
            changed.append(f"звіт о {h}:00 (після перезапуску)")
    if changed:
        audit("owner", "settings", "; ".join(changed), "warn")
    bus.publish("settings", {})
    return {"ok": True}


# ---------- модулі наступних етапів (ПК-вузол, ринок, гра) ----------
for _mod in ("node_hub", "trading", "game"):
    try:
        _m = __import__(f"app.{_mod}", fromlist=["router"])
        app.include_router(_m.router, dependencies=[] if _mod == "node_hub" else [Owner])
        if _mod == "node_hub":
            app.include_router(_m.owner_router, dependencies=[Owner])
    except ImportError:
        pass


# ---------- статичні файли ----------
@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/manifest.webmanifest")
async def manifest():
    return FileResponse(STATIC / "manifest.webmanifest", media_type="application/manifest+json")


@app.get("/health")
async def health():
    return {"ok": True}


app.mount("/static", StaticFiles(directory=STATIC), name="static")
