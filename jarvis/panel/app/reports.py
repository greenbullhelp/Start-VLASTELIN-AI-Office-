"""Щоденний звіт Джарвіса: що зроблено, що в процесі, проблеми, скільки витрачено.

Звіт складає код (без моделі) — він безкоштовний і завжди чесний: помилки, збитки й
відхилені перевірки показуються як є. Надсилається раз на 24 години (REPORT_HOUR) у панель і Telegram.
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, time as dtime, timedelta

from . import db, models
from .core import TZ, audit, bus, local_now, today


def _day_bounds(day: str) -> tuple[float, float]:
    d = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=TZ)
    start = datetime.combine(d.date(), dtime(0), tzinfo=TZ)
    return start.timestamp(), (start + timedelta(days=1)).timestamp()


def collect(day: str | None = None) -> dict:
    day = day or today()
    a, b = _day_bounds(day)
    done = db.q("SELECT id, agent, title, cost FROM tasks WHERE status='done' AND finished BETWEEN ? AND ? ORDER BY id", (a, b))
    active = db.q("SELECT id, agent, title, status FROM tasks WHERE status IN ('queued','waiting','running','review','review_running','delegated') ORDER BY id")
    failed = db.q("SELECT id, agent, title, status, error, review FROM tasks WHERE status IN ('failed','needs_owner') AND updated BETWEEN ? AND ?", (a, b))
    errors = db.q("SELECT action, details FROM audit WHERE level='error' AND ts BETWEEN ? AND ? ORDER BY id DESC LIMIT 10", (a, b))
    approvals = db.q("SELECT id, title FROM approvals WHERE status='pending'")
    spend = models.summary(day)
    trading = {}
    try:
        from . import trading as tr

        trading = tr.day_stats(day)
    except ImportError:
        pass
    node = {}
    try:
        from . import node_hub

        node = {"online": node_hub.online(), "queued": node_hub.queued_count()}
    except ImportError:
        pass
    return {"day": day, "done": done, "active": active, "failed": failed, "errors": errors,
            "approvals": approvals, "spend": spend, "trading": trading, "node": node}


def render(d: dict) -> str:
    L = [f"📋 Звіт Джарвіса за {d['day']}"]
    L.append(f"\n✅ Зроблено ({len(d['done'])}):")
    L += [f"  • #{t['id']} [{t['agent']}] {t['title'][:80]}" for t in d["done"][:15]] or ["  — нічого"]
    L.append(f"\n⏳ В процесі ({len(d['active'])}):")
    L += [f"  • #{t['id']} [{t['agent']}] {t['title'][:80]} — {t['status']}" for t in d["active"][:15]] or ["  — немає"]
    probs = [f"  • #{t['id']} [{t['agent']}] {t['title'][:60]}: {(t['error'] or t['review'])[:160]}" for t in d["failed"]]
    probs += [f"  • {e['action']}: {e['details'][:160]}" for e in d["errors"][:5]]
    if d["approvals"]:
        probs.append(f"  • Чекають вашого підтвердження: {len(d['approvals'])} (" + ", ".join(f"#{x['id']}" for x in d["approvals"][:8]) + ")")
    if d.get("node") and not d["node"].get("online") and d["node"].get("queued"):
        probs.append(f"  • ПК-вузол офлайн, у черзі задач: {d['node']['queued']}")
    L.append(f"\n⚠ Проблеми ({len(probs)}):")
    L += probs or ["  — немає"]
    s = d["spend"]
    L.append(f"\n💰 Витрачено: ${s['total']:.3f} з ліміту ${s['limit']:.2f}")
    for r in sorted(s["rows"], key=lambda r: -r["usd"])[:8]:
        L.append(f"  • {r['agent']} / {r['model']}: ${r['usd']:.3f} ({r['n']} запусків)")
    t = d.get("trading") or {}
    if t:
        L.append(f"\n◆ Золото (демо): угод {t.get('trades', 0)}, P/L ${t.get('pnl', 0):+.2f}, баланс ${t.get('balance', 0):.2f}"
                 + (" — ТОРГІВЛЮ ЗУПИНЕНО денним лімітом" if t.get("halted") else ""))
    return "\n".join(L)


def make_report(save: bool = True, day: str | None = None) -> dict:
    d = collect(day)
    text = render(d)
    rid = None
    if save:
        rid = db.insert("reports", day=d["day"], text=text, data=d, created=db.now())
        audit("jarvis", "daily_report", f"Звіт за {d['day']}")
        bus.publish("reports", {"id": rid})
    return {"id": rid, "text": text, "data": d}


def status_text() -> str:
    from .orchestrator import TERMINAL

    act = db.q(f"SELECT id, agent, title, status FROM tasks WHERE status NOT IN ({','.join('?' * len(TERMINAL))}) ORDER BY id DESC LIMIT 10", TERMINAL)
    halted = db.get_setting("halted", False)
    lines = [("⏸ Агенти ЗУПИНЕНІ" if halted else "▶ Агенти працюють"),
             f"Витрачено сьогодні: ${models.spent_today():.3f} з ${models.daily_limit():.2f}"]
    lines += [f"#{t['id']} [{t['agent']}] {t['title'][:60]} — {t['status']}" for t in act] or ["Активних задач немає"]
    return "\n".join(lines)


async def scheduler(hour: int) -> None:
    """Раз на добу о `hour` за місцевим часом формує звіт і надсилає в Telegram."""
    from . import telegram

    while True:
        now = local_now()
        last = db.get_setting("last_report_day", "")
        if now.hour >= hour and last != now.strftime("%Y-%m-%d"):
            db.set_setting("last_report_day", now.strftime("%Y-%m-%d"))
            rep = make_report(save=True)
            telegram.send_owner(rep["text"])
        await asyncio.sleep(60)


def list_reports(limit: int = 30) -> list[dict]:
    rows = db.q("SELECT id, day, text, created FROM reports ORDER BY id DESC LIMIT ?", (limit,))
    return rows


__all__ = ["make_report", "status_text", "scheduler", "list_reports", "collect", "json"]
