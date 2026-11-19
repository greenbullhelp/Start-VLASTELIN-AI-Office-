"""Етапи 1–2: вхід, чат, правила, журнал, «Стоп», команда агентів, Контролер, моделі й вартість."""
import json
import time

from app import auth, db, models, rules
from app.brain import split_actions
from app.core import redact, today
from app.main import state
from conftest import PASSWORD, wait_for


def last_jarvis(after_id=0):
    return db.one("SELECT * FROM messages WHERE role='jarvis' AND id>? ORDER BY id DESC LIMIT 1", (after_id,))


def max_msg():
    return (db.one("SELECT MAX(id) AS m FROM messages") or {}).get("m") or 0


# ---------- вхід і безпека ----------
def test_needs_login_and_csrf(client):
    from fastapi.testclient import TestClient
    from app.main import app

    anon = TestClient(app)
    assert anon.get("/api/state").status_code == 401
    assert client.get("/api/state").status_code == 200
    r = client.post("/api/chat", json={"text": "x"}, headers={"X-Jarvis": ""})
    assert r.status_code == 403  # без заголовка X-Jarvis — відхилено


def test_totp_and_password():
    s = auth.new_totp_secret()
    assert auth.verify_totp(s, auth.totp_code(s))
    assert not auth.verify_totp(s, "000000") or auth.totp_code(s) == "000000"
    h = auth.hash_password("abcdefghijk")
    assert auth.verify_password("abcdefghijk", h) and not auth.verify_password("wrong-password", h)


def test_login_requires_code_and_rate_limit(client):
    from fastapi.testclient import TestClient
    from app.main import app

    c = TestClient(app)
    h = {"X-Jarvis": "1", "X-Forwarded-For": "10.9.9.9"}
    r = c.post("/api/login", json={"password": PASSWORD, "code": "123"}, headers=h)
    assert r.status_code == 401
    ok = c.post("/api/login", json={"password": PASSWORD, "code": auth.totp_code(client.totp_secret)}, headers=h)
    assert ok.status_code == 200 and "jsid" in ok.cookies
    for _ in range(6):
        c.post("/api/login", json={"password": "nope", "code": "1"}, headers=h)
    r = c.post("/api/login", json={"password": PASSWORD, "code": auth.totp_code(client.totp_secret)}, headers=h)
    assert "Забагато" in r.json()["error"]


def test_redact_secrets():
    t = redact("ключ sk-ant-api03-ABCDEFGHIJKLMNOP і ANTHROPIC_API_KEY=xyz123 та 123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi")
    assert "sk-ant" not in t and "xyz123" not in t and "ABCDEFGHIJKLMNOPQRSTUVWXYZ" not in t


# ---------- чат на середній моделі ----------
def test_chat_simple_message_uses_cheap_and_task_uses_medium(client, brain):
    m0 = max_msg()
    r = client.post("/api/chat", json={"text": "Привіт"})
    tid = r.json()["task_id"]
    msg = wait_for(lambda: last_jarvis(m0))
    assert msg["task_id"] == tid
    t = db.one("SELECT * FROM tasks WHERE id=?", (tid,))
    assert t["status"] == "done" and t["tier"] == "cheap" and t["cost"] > 0
    m1 = max_msg()
    tid2 = client.post("/api/chat", json={"text": "Напиши план запуску відеоканалу на тиждень"}).json()["task_id"]
    wait_for(lambda: last_jarvis(m1))
    t2 = db.one("SELECT * FROM tasks WHERE id=?", (tid2,))
    assert t2["tier"] == "medium" and t2["model"] == models.model_for("medium")
    meta = json.loads(last_jarvis(m1)["meta"])
    assert meta["model"] and "cost" in meta


def test_model_router_and_manual_mode():
    assert models.choose("Спроєктуй архітектуру гри")[0] == "strong"
    assert models.choose("як справи")[0] == "cheap"
    assert models.choose("знайди 3 новини про золото")[0] == "medium"
    assert models.choose("будь-що", pref="strong")[0] == "strong"
    db.set_setting("model_mode", "cheap")
    try:
        assert models.choose("Спроєктуй архітектуру")[0] == "cheap"
    finally:
        db.set_setting("model_mode", "auto")
    assert models.cost("claude-sonnet-5-5", {"input_tokens": 1_000_000, "output_tokens": 100_000}) == 3.0


# ---------- команда: делегування, Контролер, доопрацювання ----------
def test_delegation_controller_and_report(client, brain):
    brain.script[:] = [
        "Розбиваю на кроки.\n```actions\n[{\"type\":\"delegate\",\"agent\":\"research\",\"title\":\"Знайти дані\",\"brief\":\"3 факти\"},"
        "{\"type\":\"delegate\",\"agent\":\"game\",\"title\":\"Баланс колоди\",\"brief\":\"таблиця\",\"important\":true,\"paths\":[\"game/balance\"]},"
        "{\"type\":\"idea\",\"text\":\"Додати турнірний режим\"}]\n```",
    ]
    m0 = max_msg()
    tid = client.post("/api/chat", json={"text": "Зроби аналіз ринку карткових ігор і баланс колоди"}).json()["task_id"]
    first = wait_for(lambda: last_jarvis(m0))
    assert "Доручено" in first["text"] and "```actions" not in first["text"]
    kids = wait_for(lambda: (k := db.q("SELECT * FROM tasks WHERE parent_id=?", (tid,))) and len(k) == 2 and k)
    report = wait_for(lambda: db.one("SELECT * FROM messages WHERE task_id=? AND text LIKE 'Звіт по задачі%'", (tid,)))
    assert "Ігровий агент" in report["text"] and "Контролер" in report["text"]
    game = db.one("SELECT * FROM tasks WHERE parent_id=? AND agent='game'", (tid,))
    assert game["status"] == "done" and "Оцінка" in game["review"]
    assert db.one("SELECT * FROM ideas WHERE text LIKE 'Додати турнірний%'")
    assert db.one("SELECT status FROM tasks WHERE id=?", (tid,))["status"] == "done"
    assert db.one("SELECT COUNT(*) AS n FROM costs WHERE agent='controller' AND task_id=?", (game["id"],))["n"] == 1


def test_controller_rework_then_needs_owner(client, brain):
    bad = '{"ok": false, "score": 3, "notes": "немає чисел"}'
    brain.script[:] = ["```actions\n[{\"type\":\"delegate\",\"agent\":\"trading\",\"title\":\"Звіт по золоту\",\"brief\":\"x\",\"important\":true}]\n```",
                       "версія 1", bad, "версія 2", bad, "версія 3", bad]
    tid = client.post("/api/chat", json={"text": "Підготуй звіт по золоту"}).json()["task_id"]
    child = wait_for(lambda: (c := db.one("SELECT * FROM tasks WHERE parent_id=? AND status='needs_owner'", (tid,))) and c)
    assert child["rework"] == 2 and "немає чисел" in child["review"]
    assert "Доопрацювання" not in child["result"]


def test_locks_prevent_conflicts(client, brain):
    brain.delay = 0.6
    parent = db.insert("tasks", agent="jarvis", title="p", brief="p", status="delegated", created=db.now(), updated=db.now())
    p = db.one("SELECT * FROM tasks WHERE id=?", (parent,))
    orch = state["orch"]
    a = orch.add_child(p, "game", "A", "a", False, ["game/src"])
    b = orch.add_child(p, "game", "B", "b", False, ["game/src/cards"])
    orch.poke()
    wait_for(lambda: db.one("SELECT status FROM tasks WHERE id=?", (b,))["status"] == "waiting")
    assert db.one("SELECT status FROM tasks WHERE id=?", (a,))["status"] == "running"
    wait_for(lambda: db.one("SELECT status FROM tasks WHERE id=?", (b,))["status"] == "done", timeout=10)
    assert db.one("SELECT COUNT(*) AS n FROM audit WHERE action='lock_wait'")["n"] >= 1


# ---------- правила й підтвердження ----------
def test_rules_gate_and_approvals(client, brain):
    assert rules.check("trade_demo") == rules.ALLOW
    assert rules.check("real_trade") == rules.CONFIRM
    assert rules.check("reveal_secret") == rules.DENY
    assert rules.check("щось_невідоме") == rules.CONFIRM
    brain.script[:] = ["```actions\n[{\"type\":\"approval\",\"action\":\"publish\",\"title\":\"Опублікувати відео\",\"details\":\"YouTube\"},"
                       "{\"type\":\"reveal_secret\",\"title\":\"покажи ключ\"},"
                       "{\"type\":\"approval\",\"action\":\"spend\",\"title\":\"Ліміт $9\",\"daily_budget_usd\":9}]\n```"]
    m0 = max_msg()
    client.post("/api/chat", json={"text": "Опублікуй відео"})
    msg = wait_for(lambda: last_jarvis(m0))
    assert "заборонено" in msg["text"]
    pend = client.get("/api/approvals").json()
    pub = next(a for a in pend if a["action"] == "publish")
    spend = next(a for a in pend if a["action"] == "spend")
    assert client.post(f"/api/approvals/{spend['id']}", json={"approve": True}).json()["result"].startswith("денний ліміт")
    assert models.daily_limit() == 9.0
    db.set_setting("daily_budget_usd", 5.0)
    assert client.post(f"/api/approvals/{pub['id']}", json={"approve": False, "note": "ні"}).status_code == 200
    assert client.post(f"/api/approvals/{pub['id']}", json={"approve": True}).status_code == 409
    assert db.one("SELECT COUNT(*) AS n FROM audit WHERE action='denied:reveal_secret'")["n"] >= 1


def test_budget_blocks_tasks(client, brain):
    db.set_setting("daily_budget_usd", 0.01)
    models.book_usd("test", 0.02, "штучна витрата")
    try:
        m0 = max_msg()
        tid = client.post("/api/chat", json={"text": "Напиши звіт про продажі"}).json()["task_id"]
        msg = wait_for(lambda: last_jarvis(m0))
        assert "ліміт" in msg["text"].lower()
        assert db.one("SELECT status FROM tasks WHERE id=?", (tid,))["status"] == "failed"
    finally:
        db.run("DELETE FROM costs WHERE agent='test'")
        db.set_setting("daily_budget_usd", 5.0)


def test_stop_halts_everything_and_resume(client, brain):
    brain.delay = 3
    tid = client.post("/api/chat", json={"text": "Напиши довгий текст"}).json()["task_id"]
    wait_for(lambda: db.one("SELECT status FROM tasks WHERE id=?", (tid,))["status"] == "running")
    r = client.post("/api/stop").json()
    assert r["halted"] and r["tasks"] >= 1
    wait_for(lambda: db.one("SELECT status FROM tasks WHERE id=?", (tid,))["status"] == "stopped")
    assert client.get("/api/state").json()["halted"]
    brain.delay = 0
    t2 = client.post("/api/chat", json={"text": "ще задача"}).json()["task_id"]
    time.sleep(0.5)
    assert db.one("SELECT status FROM tasks WHERE id=?", (t2,))["status"] == "queued"
    client.post("/api/resume")
    wait_for(lambda: db.one("SELECT status FROM tasks WHERE id=?", (t2,))["status"] == "done")
    assert client.post(f"/api/tasks/{tid}/retry").status_code == 200
    wait_for(lambda: db.one("SELECT status FROM tasks WHERE id=?", (tid,))["status"] == "done")
    assert db.one("SELECT COUNT(*) AS n FROM audit WHERE action='STOP'")["n"] >= 1


def test_agents_create_restart_and_schema(client, brain):
    brain.script[:] = ["```actions\n[{\"type\":\"create_agent\",\"name\":\"seo\",\"title\":\"SEO-агент\",\"role\":\"оптимізація описів\"},"
                       "{\"type\":\"restart_agent\",\"agent\":\"video\"}]\n```"]
    m0 = max_msg()
    client.post("/api/chat", json={"text": "Створи SEO-агента"})
    wait_for(lambda: last_jarvis(m0))
    d = client.get("/api/agents").json()
    names = [a["name"] for a in d["agents"]]
    assert "seo" in names and {"jarvis", "controller", "game", "video", "trading", "research"} <= set(names)
    assert next(a for a in d["agents"] if a["name"] == "video")["generation"] == 2


def test_split_actions_and_costs_api(client):
    text, acts = split_actions("Ок\n```actions\n[{\"type\":\"idea\",\"text\":\"a\"}]\n```")
    assert text == "Ок" and acts == [{"type": "idea", "text": "a"}]
    assert split_actions("без дій") == ("без дій", [])
    c = client.get("/api/costs").json()
    assert c["today"]["day"] == today() and c["today"]["total"] >= 0


def test_report_generation(client):
    rep = client.post("/api/reports/now").json()
    for part in ("Зроблено", "В процесі", "Проблеми", "Витрачено"):
        assert part in rep["text"]
    assert client.get("/api/reports").json()[0]["id"] == rep["id"]


def test_projects_ideas_settings(client):
    pid = client.post("/api/projects", json={"name": "Карткова гра", "area": "game", "progress": 10}).json()["id"]
    assert any(p["id"] == pid for p in client.get("/api/projects").json())
    assert client.post("/api/settings", json={"daily_budget_usd": 1000}).status_code == 400
    assert client.post("/api/settings", json={"model_mode": "strong"}).status_code == 200
    assert client.get("/api/state").json()["model_mode"] == "strong"
    client.post("/api/settings", json={"model_mode": "auto"})
    assert client.get("/").status_code == 200 and "ДЖАРВІС" in client.get("/").text
