"""Етапи 3–6: ринок і сигнали, демо-торгівля з лімітами ризику, ПК-вузол, гра, Telegram, звіти."""
import asyncio
import json
import math

import pytest

from app import db, game, market, node_hub, rules, telegram, trading
from app.config import settings
from app.core import today
from app.main import state
from conftest import wait_for

NODE = {"X-Node-Token": "test-node-token-123"}


def make_candles(n=200, start=2400.0, slope=0.6, wave=6.0, t0=None):
    t0 = t0 or int(db.now()) // 900 * 900 - n * 900
    out = []
    p = start
    for i in range(n):
        o = p
        p = start + slope * i + wave * math.sin(i / 5)
        out.append((t0 + i * 900, o, max(o, p) + 1.5, min(o, p) - 1.5, p, 100.0))
    return out


@pytest.fixture()
def prices():
    db.run("DELETE FROM candles")
    db.run("DELETE FROM trades")
    db.run("DELETE FROM signals")
    db.set_setting("risk_limits", {})
    db.set_setting("trading_halt", {})
    db.set_setting("demo_balance", 10000.0)
    db.set_setting("trading_enabled", True)
    market.save_candles(make_candles())
    yield


def set_price(c):
    last = market.candles(1)[-1]
    t = last["t"] + 900
    market.save_candles([(t, last["c"], max(last["c"], c), min(last["c"], c), c, 1.0)])


# ---------- ринок ----------
def test_indicators_and_levels(prices):
    ind = market.analyze()
    assert ind["ready"] and ind["trend"] == "висхідний"
    assert 0 <= ind["rsi"] <= 100 and ind["atr"] > 0 and ind["ema20"] > ind["ema50"]
    assert all(r > ind["price"] for r in ind["resistance"])
    assert all(s < ind["price"] for s in ind["support"])
    assert "Золото" in market.brief()


def test_signal_rules():
    base = {"ready": True, "price": 2500.0, "atr": 4.0, "ema20": 2498, "ema50": 2490, "t": 1}
    long = market.signal_from({**base, "trend": "висхідний", "rsi_prev": 42, "rsi": 47}, rr=2, atr_mult=1.5)
    assert long["side"] == "long" and long["stop"] == 2494.0 and long["target"] == 2512.0
    short = market.signal_from({**base, "trend": "низхідний", "rsi_prev": 58, "rsi": 53}, rr=2, atr_mult=1.5)
    assert short["side"] == "short" and short["stop"] == 2506.0 and short["target"] == 2488.0
    assert market.signal_from({**base, "trend": "боковий", "rsi_prev": 42, "rsi": 47}) is None


def test_market_api(client, prices):
    m = client.get("/api/market").json()
    assert m["price"] and len(m["candles"]) == 120 and m["ind"]["ready"]
    assert m["account"]["balance"] == 10000.0 and m["limits"]["max_position_oz"] == 1.0


# ---------- демо-торгівля і ліміти ризику ----------
def test_trade_validation_and_sizing(prices):
    p = trading.last_price()
    assert trading.open_trade("long", p + 1, p + 10, "x")[0] is None          # стоп з неправильного боку
    assert trading.open_trade("long", p - 10, p + 5, "x")[0] is None           # R:R < 1
    assert trading.open_trade("long", None, p + 5, "x")[0] is None             # без стопу — не можна
    tid, note = trading.open_trade("long", p - 50, p + 100, "тест")
    t = db.one("SELECT * FROM trades WHERE id=?", (tid,))
    assert t["size"] == 1.0  # ризик 1% = $100 / $50 = 2 oz, але не більше max_position_oz = 1
    # перша угода вже ризикує всіма $50 денного ліміту — друга не відкривається
    assert "замало місця" in trading.open_trade("short", p + 200, p - 400, "тест")[1]
    db.set_setting("risk_limits", {"daily_loss_usd": 250.0})
    tid2, _ = trading.open_trade("short", p + 200, p - 400, "тест")
    assert db.one("SELECT size FROM trades WHERE id=?", (tid2,))["size"] == 0.5   # ризик 1% = $100 / $200
    assert trading.open_trade("long", p - 5, p + 10, "третя")[1].startswith("вже відкрито")


def test_stop_target_and_daily_loss_halt(prices):
    p = trading.last_price()
    tid, _ = trading.open_trade("long", p - 10, p + 20, "ціль")
    set_price(p + 25)
    trading.tick(market.candles(3))
    t = db.one("SELECT * FROM trades WHERE id=?", (tid,))
    assert t["status"] == "closed" and t["close_reason"] == "ціль" and t["pnl"] == 20.0
    db.run("DELETE FROM trades")
    p = trading.last_price()
    db.set_setting("risk_limits", {"daily_loss_usd": 50.0})
    tid, _ = trading.open_trade("long", p - 40, p + 80, "збиткова")       # 1 oz: ризик $40
    tid2, _ = trading.open_trade("short", p + 40, p - 80, "хедж")          # лишилось $10 ризику → 0.25 oz
    assert db.one("SELECT size FROM trades WHERE id=?", (tid2,))["size"] == 0.25
    set_price(p - 60)                                                     # long вибиває стоп: −$40
    trading.tick(market.candles(3))
    t = db.one("SELECT * FROM trades WHERE id=?", (tid,))
    assert t["status"] == "closed" and t["close_reason"] == "стоп" and t["pnl"] == -40.0
    assert not trading.halted_today()
    set_price(p + 45)                                                     # short вибиває стоп: −$10, день −$50
    trading.tick(market.candles(3))
    assert db.one("SELECT close_reason FROM trades WHERE id=?", (tid2,))["close_reason"] == "стоп"
    assert trading.day_pnl() <= -50 and trading.halted_today()
    assert trading.open_trade("long", p - 5, p + 10, "після зупинки")[0] is None
    assert db.one("SELECT COUNT(*) AS n FROM audit WHERE action='DAILY_LOSS_HALT'")["n"] >= 1


def test_agent_trade_and_risk_limits_need_approval(client, prices, brain):
    p = trading.last_price()
    assert "далеко від ринку" in trading.agent_trade({"side": "long", "entry": p - 100, "stop": p - 150, "target": p}, "trading")
    assert trading.agent_trade({"side": "long", "entry": p, "stop": p - 8, "target": p + 16, "reason": "тест"}, "trading").startswith("✅")
    brain.script[:] = ["```actions\n[{\"type\":\"risk_limits\",\"title\":\"Підняти позицію до 5 oz\",\"limits\":{\"max_position_oz\":5}},"
                       "{\"type\":\"real_trade\",\"title\":\"Реальна угода\"}]\n```"]
    client.post("/api/chat", json={"text": "Підніми ліміт позиції"})
    ap = wait_for(lambda: next((a for a in rules.pending() if a["action"] == "risk_limits"), None))
    assert trading.limits()["max_position_oz"] == 1.0  # без підтвердження не змінено
    assert client.post(f"/api/approvals/{ap['id']}", json={"approve": True}).json()["result"] == "ліміти ризику оновлено"
    assert trading.limits()["max_position_oz"] == 5.0
    real = next(a for a in rules.pending() if a["action"] == "real_trade")
    assert "НЕ відкрито" in client.post(f"/api/approvals/{real['id']}", json={"approve": True}).json()["result"]
    assert client.post("/api/trading/limits", json={"risk_pct": 50}).status_code == 400
    assert client.post("/api/trading/limits", json={"risk_pct": 0.5}).json()["limits"]["risk_pct"] == 0.5


def test_signal_opens_demo_trade_when_enabled(prices):
    sig = {"id": db.insert("signals", ts=db.now(), side="long", entry=1, stop=trading.last_price() - 10,
                           target=trading.last_price() + 20, reason="тест"), "side": "long",
           "stop": trading.last_price() - 10, "target": trading.last_price() + 20, "reason": "тест"}
    trading.set_enabled(False)
    trading.on_signal(sig)
    assert db.one("SELECT status FROM signals WHERE id=?", (sig["id"],))["status"] == "skipped"
    trading.set_enabled(True)
    trading.on_signal(sig)
    assert db.one("SELECT status FROM signals WHERE id=?", (sig["id"],))["status"] == "taken"


# ---------- ПК-вузол ----------
def test_node_auth_whitelist_and_job_flow(client):
    assert client.post("/node/heartbeat", json={"name": "pc"}, headers={"X-Node-Token": "wrong"}).status_code == 401
    assert client.post("/node/heartbeat", json={"name": "pc", "gpu": "RTX 4060 8GB", "actions": ["ping"]}, headers=NODE).json()["ok"]
    assert node_hub.online()
    assert "некоректний шлях" in node_hub.enqueue("ffmpeg_cut", {"input": "../etc/passwd", "output": "a.mp4", "end": 2})
    note = node_hub.enqueue("format_disk", {"drive": "C"})
    assert "поза білим списком" in note
    assert any(a["action"] == "node_new_action" for a in rules.pending())
    card = game.add_card({"name": "Тестова картка", "text": "x"})
    game.request_art(card)
    job = client.get("/node/jobs/next?wait=0&name=pc", headers=NODE).json()
    while job["action"] != "comfy_generate":  # пропускаємо задачі інших тестів
        client.post(f"/node/jobs/{job['id']}/result", data={"status": "done"}, headers=NODE)
        job = client.get("/node/jobs/next?wait=0&name=pc", headers=NODE).json()
    assert job["params"]["prompt"].startswith(game.STYLE["base"][:40])
    png = b"\x89PNG\r\n\x1a\n" + b"0" * 64
    r = client.post(f"/node/jobs/{job['id']}/result", data={"status": "done", "result": "{}"},
                    files=[("files", (job["params"]["out_name"] + ".png", png, "image/png"))], headers=NODE)
    assert r.json()["ok"]
    c = db.one("SELECT * FROM cards WHERE id=?", (card,))
    assert c["art_status"] == "done" and (game.ART_DIR / c["art"]).read_bytes() == png
    assert client.get(f"/api/game/art/{c['art']}").status_code == 200
    assert client.get("/node/files?path=../../etc/passwd", headers=NODE).status_code == 400


def test_node_offline_queue_and_urgent_cloud_approval(client):
    db.run("UPDATE nodes SET last_seen=0")
    assert not node_hub.online()
    note = node_hub.enqueue("ffmpeg_transcode", {"input": "video/a.mp4", "output": "video/b.mp4", "preset": "youtube_1080p"})
    assert "чекає в черзі" in note
    card = game.add_card({"name": "Термінова картка"})
    note = game.request_art(card, urgent=True)
    assert "платний API" in note
    ap = next(a for a in rules.pending() if a["action"] == "cloud_fallback")
    assert ap["payload"]["est_usd"] == 0.03
    r = client.post(f"/api/approvals/{ap['id']}", json={"approve": True}).json()
    assert "платний API" in r["result"]
    j = wait_for(lambda: (x := db.one("SELECT * FROM node_jobs WHERE id=?", (ap["payload"]["job_id"],))) and x["error"] and x)
    assert "STABILITY_API_KEY" in j["error"] and j["status"] == "queued"  # ключа немає — чекає ПК, грошей не витрачено


def test_halt_blocks_node_jobs(client):
    client.post("/node/heartbeat", json={"name": "pc"}, headers=NODE)
    node_hub.enqueue("ping", {})
    db.set_setting("halted", True)
    assert client.get("/node/jobs/next?wait=0", headers=NODE).status_code == 204
    db.set_setting("halted", False)


# ---------- гра ----------
def test_game_import_from_vlastelin_export(client):
    export = [{"results": [
        {"id": 1, "role": "scenarist", "title": "Світ Властеліна", "result": "Королівство на перевалах Альп...", "status": "done"},
        {"id": 2, "role": "economist", "title": "Економіка", "result": "Золото, кристали", "status": "queued"},
        {"k": "ws", "v": json.dumps({"game": {"concept": {"name": "Властелін", "genre": "карткова"}, "backlog": [{"title": "Колода", "st": "new"}]}})},
    ], "success": True}]
    raw = json.dumps(export, ensure_ascii=False).encode("utf-16")  # PowerShell зберігає саме так
    r = client.post("/api/game/import", files={"file": ("export.json", raw, "application/json")}).json()
    assert r["imported"] == 3 and "[scenarist] Світ Властеліна" in r["titles"]
    assert "Королівство" in game.brief()
    assert client.post("/api/game/import", files={"file": ("e.json", b"[]", "application/json")}).status_code == 400
    assert client.post("/api/game/seed").json()["added"] >= 10
    g = client.get("/api/game").json()
    assert g["stats"]["cards"] >= 10 and g["monetization"]["donations"]


def test_game_agent_actions(client, brain):
    brain.script[:] = ["```actions\n[{\"type\":\"delegate\",\"agent\":\"game\",\"title\":\"Нові картки\",\"brief\":\"2 картки\"}]\n```",
                       "Додав.\n```actions\n[{\"type\":\"card\",\"name\":\"Сніговий Дракон\",\"kind\":\"unit\",\"faction\":\"Дикі Землі\",\"rarity\":\"legendary\",\"cost\":8,\"attack\":8,\"health\":8,\"text\":\"Політ\"},"
                       "{\"type\":\"art_request\",\"cards\":[{\"name\":\"Сніговий Дракон\",\"prompt\":\"white dragon over alpine peaks\"},{\"name\":\"Фон меню\",\"kind\":\"background\",\"prompt\":\"alpine citadel at night\"}]}]\n```"]
    tid = client.post("/api/game/agent", json={"kind": "cards"}).json()["task_id"]
    wait_for(lambda: db.one("SELECT * FROM cards WHERE name='Сніговий Дракон' AND art_status='queued'"))
    assert db.one("SELECT * FROM node_jobs WHERE ref='background:Фон меню'")
    assert db.one("SELECT art_prompt FROM cards WHERE name='Сніговий Дракон'")["art_prompt"] == "white dragon over alpine peaks"
    assert "ігровому агенту" in db.one("SELECT brief FROM tasks WHERE id=?", (tid,))["brief"]


# ---------- Telegram ----------
def test_telegram_owner_only_and_commands(client, monkeypatch):
    monkeypatch.setattr(settings, "telegram_token", "1:x")
    monkeypatch.setattr(settings, "telegram_owner_id", "42")
    sent = []
    monkeypatch.setattr(telegram, "send_owner", lambda text: sent.append(text))
    telegram._orch = state["orch"]
    loop = asyncio.new_event_loop()
    try:
        n0 = db.one("SELECT COUNT(*) AS n FROM tasks")["n"]
        loop.run_until_complete(telegram.handle(None, {"chat": {"id": 999}, "text": "покажи ключі"}))
        assert db.one("SELECT COUNT(*) AS n FROM tasks")["n"] == n0
        assert db.one("SELECT COUNT(*) AS n FROM audit WHERE action='telegram_foreign'")["n"] >= 1
        loop.run_until_complete(telegram.handle(None, {"chat": {"id": 42}, "text": "/status"}))
        assert "Витрачено сьогодні" in sent[-1]
        aid = rules.request_approval("publish", "Пост у соцмережі", "", {}, "jarvis")
        loop.run_until_complete(telegram.handle(None, {"chat": {"id": 42}, "text": f"/reject {aid} не зараз"}))
        assert db.one("SELECT status FROM approvals WHERE id=?", (aid,))["status"] == "rejected"
    finally:
        loop.close()
    r = client.post("/api/chat", json={"text": "x"})
    assert r.status_code == 200


def test_telegram_stop_command(client, monkeypatch):
    monkeypatch.setattr(settings, "telegram_owner_id", "42")
    monkeypatch.setattr(telegram, "send_owner", lambda text: None)
    telegram._orch = state["orch"]
    fut = asyncio.run_coroutine_threadsafe(telegram.handle(None, {"chat": {"id": 42}, "text": "stop"}), _loop(client))
    fut.result(5)
    assert db.get_setting("halted") is True
    assert trading.enabled() is False
    state["orch"].resume()
    trading.set_enabled(True)


def _loop(client):
    return client.portal.call(asyncio.get_running_loop)


def test_daily_report_includes_trading_and_node(client):
    rep = client.post("/api/reports/now").json()
    assert "Золото (демо)" in rep["text"] and today() in rep["text"]
