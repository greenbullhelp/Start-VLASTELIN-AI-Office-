"""Демо-торгівля золотом з обов'язковими лімітами ризику. Реальних угод модуль не відкриває.

Ліміти (змінює лише власник; агент — тільки через підтвердження risk_limits):
  * max_position_oz — максимальний розмір позиції (унцій);
  * risk_pct — ризик на угоду, % демо-балансу (розмір = ризик / відстань до стопу, але не більше max_position_oz);
  * daily_loss_usd — денний ліміт збитку: при досягненні всі позиції закриваються, торгівля стоїть до завтра;
  * автоматичний стоп — кожна угода без стопу або з неправильним стопом відхиляється; стоп і ціль супроводжує код.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from . import db
from .core import audit, bus, today

router = APIRouter(prefix="/api/trading")

DEFAULT_LIMITS = {"max_position_oz": 1.0, "risk_pct": 1.0, "daily_loss_usd": 50.0, "rr": 2.0, "atr_mult": 1.5,
                  "max_trades_day": 5, "max_open": 2}
BOUNDS = {"max_position_oz": (0.01, 100), "risk_pct": (0.1, 5), "daily_loss_usd": (1, 100000), "rr": (1, 5),
          "atr_mult": (0.5, 5), "max_trades_day": (1, 20), "max_open": (1, 5)}
START_BALANCE = 10000.0


def limits() -> dict:
    return {**DEFAULT_LIMITS, **(db.get_setting("risk_limits", {}) or {})}


def enabled() -> bool:
    return bool(db.get_setting("trading_enabled", True))


def set_enabled(flag: bool, actor: str = "owner") -> None:
    if enabled() != flag:
        db.set_setting("trading_enabled", bool(flag))
        audit(actor, "trading_" + ("on" if flag else "off"), "Демо-торгівля " + ("увімкнена" if flag else "вимкнена"), "warn")
        bus.publish("market", {})


def balance() -> float:
    return float(db.get_setting("demo_balance", START_BALANCE))


def _day_start() -> float:
    from .reports import _day_bounds

    return _day_bounds(today())[0]


def last_price() -> float | None:
    r = db.one("SELECT c FROM candles ORDER BY t DESC LIMIT 1")
    return r["c"] if r else None


def _pnl(t: dict, price: float) -> float:
    return round((price - t["entry"]) * t["size"] * (1 if t["side"] == "long" else -1), 2)


def day_pnl(price: float | None = None) -> float:
    realized = db.one("SELECT COALESCE(SUM(pnl),0) AS s FROM trades WHERE status='closed' AND mode='demo' AND closed>=?", (_day_start(),))["s"]
    price = price or last_price()
    unreal = sum(_pnl(t, price) for t in open_trades()) if price else 0
    return round(realized + unreal, 2)


def open_trades() -> list[dict]:
    return db.q("SELECT * FROM trades WHERE status='open' AND mode='demo' ORDER BY id")


def halted_today() -> str:
    h = db.get_setting("trading_halt", {}) or {}
    return h.get("why", "") if h.get("day") == today() else ""


def open_trade(side: str, stop: float, target: float, reason: str, source: str = "engine",
               signal_id: int | None = None) -> tuple[int | None, str]:
    """Відкриває демо-позицію за ринком. Повертає (id або None, пояснення)."""
    if db.get_setting("halted", False):
        return None, "агенти зупинені кнопкою «Стоп»"
    if not enabled():
        return None, "демо-торгівлю вимкнено"
    why = halted_today()
    if why:
        return None, f"торгівля зупинена до завтра: {why}"
    lim = limits()
    price = last_price()
    if not price:
        return None, "немає ціни"
    if side not in ("long", "short"):
        return None, "напрям має бути long або short"
    try:
        stop, target = float(stop), float(target)
    except (TypeError, ValueError):
        return None, "стоп і ціль обов'язкові"
    dist = price - stop if side == "long" else stop - price
    gain = target - price if side == "long" else price - target
    if dist <= 0:
        return None, f"стоп {stop} з неправильного боку від ціни {price}"
    if gain <= 0:
        return None, f"ціль {target} з неправильного боку від ціни {price}"
    if gain / dist < 1:
        return None, f"співвідношення прибуток/ризик {gain / dist:.2f} < 1"
    n_today = db.one("SELECT COUNT(*) AS n FROM trades WHERE mode='demo' AND opened>=?", (_day_start(),))["n"]
    if n_today >= lim["max_trades_day"]:
        return None, f"досягнуто ліміт угод за день ({lim['max_trades_day']})"
    if len(open_trades()) >= lim["max_open"]:
        return None, f"вже відкрито {lim['max_open']} позицій"
    risk_usd = balance() * lim["risk_pct"] / 100
    # місце до денного ліміту: мінус уже зафіксовані збитки дня і мінус ризик відкритих позицій (до їхніх стопів)
    realized = db.one("SELECT COALESCE(SUM(pnl),0) AS s FROM trades WHERE status='closed' AND mode='demo' AND closed>=?", (_day_start(),))["s"]
    open_risk = sum(t["size"] * abs(t["entry"] - t["stop"]) for t in open_trades())
    loss_room = lim["daily_loss_usd"] + min(0.0, realized) - open_risk
    size = min(lim["max_position_oz"], risk_usd / dist, max(0.0, loss_room) / dist)
    size = round(int(size * 100) / 100, 2)
    if size < 0.01:
        return None, "до денного ліміту збитку замало місця для угоди"
    tid = db.insert("trades", mode="demo", side=side, size=size, entry=round(price, 2), stop=round(stop, 2),
                    target=round(target, 2), opened=db.now(), reason=reason[:600], signal_id=signal_id)
    audit(source, "trade_open", f"#{tid} DEMO {side} {size} oz @ {price:.2f}, стоп {stop:.2f}, ціль {target:.2f} — {reason[:200]}")
    bus.publish("market", {"trade": tid})
    return tid, f"демо-угода #{tid}: {side} {size} oz @ {price:.2f}, стоп {stop:.2f}, ціль {target:.2f}"


def close_trade(tid: int, price: float, why: str, actor: str = "engine") -> dict | None:
    t = db.one("SELECT * FROM trades WHERE id=? AND status='open'", (tid,))
    if not t:
        return None
    pnl = _pnl(t, price)
    db.update("trades", tid, status="closed", closed=db.now(), exit=round(price, 2), pnl=pnl, close_reason=why)
    db.set_setting("demo_balance", round(balance() + pnl, 2))
    audit(actor, "trade_close", f"#{tid} закрито @ {price:.2f} ({why}), P/L {pnl:+.2f}$", "warn" if pnl < 0 else "info")
    bus.publish("market", {"trade": tid})
    return {**t, "pnl": pnl, "exit": price}


def tick(recent: list[dict]) -> None:
    """Супровід позицій: стоп/ціль за high/low свічок, денний ліміт збитку."""
    if not recent:
        return
    price = recent[-1]["c"]
    for t in open_trades():
        # свічка, в якій відкрито позицію, враховується лише ціною закриття (без «заднім числом» стопів)
        bars = [c for c in recent if c["t"] > t["opened"]]
        hi = max([price] + [c["h"] for c in bars])
        lo = min([price] + [c["l"] for c in bars])
        if t["side"] == "long":
            if lo <= t["stop"]:
                close_trade(t["id"], t["stop"], "стоп")
            elif hi >= t["target"]:
                close_trade(t["id"], t["target"], "ціль")
        else:
            if hi >= t["stop"]:
                close_trade(t["id"], t["stop"], "стоп")
            elif lo <= t["target"]:
                close_trade(t["id"], t["target"], "ціль")
    lim = limits()
    dp = day_pnl(price)
    if dp <= -lim["daily_loss_usd"] and not halted_today():
        for t in open_trades():
            close_trade(t["id"], price, "денний ліміт збитку")
        why = f"денний збиток {day_pnl(price):.2f}$ досяг ліміту {lim['daily_loss_usd']:.2f}$"
        db.set_setting("trading_halt", {"day": today(), "why": why})
        audit("trading", "DAILY_LOSS_HALT", why, "error")
        from . import telegram

        telegram.send_owner(f"⛔ Демо-торгівлю зупинено до завтра: {why}")


def on_signal(sig: dict) -> None:
    tid, note = open_trade(sig["side"], sig["stop"], sig["target"], sig["reason"], "engine", sig.get("id"))
    if sig.get("id"):
        db.update("signals", sig["id"], status="taken" if tid else "skipped")
    if not tid:
        audit("trading", "signal_skipped", f"Сигнал #{sig.get('id')}: {note}")


def agent_trade(a: dict, actor: str) -> str:
    """Дія trade_demo від трейдингового агента. Код перевіряє всі ліміти; вхід лише за ринком."""
    from . import market

    ind = market.analyze()
    price = last_price()
    try:
        entry = float(a.get("entry") or price or 0)
    except (TypeError, ValueError):
        entry = price or 0
    if price and ind.get("atr") and abs(entry - price) > 0.5 * ind["atr"]:
        return f"Демо-угоду не відкрито: вхід {entry} далеко від ринку {price} (лімітні ордери не підтримуються)"
    sid = db.insert("signals", ts=db.now(), side=str(a.get("side", "")), entry=price or entry,
                    stop=float(a.get("stop") or 0), target=float(a.get("target") or 0),
                    reason=str(a.get("reason", ""))[:500], source=actor)
    tid, note = open_trade(str(a.get("side", "")), a.get("stop"), a.get("target"), str(a.get("reason", "")), actor, sid)
    db.update("signals", sid, status="taken" if tid else "skipped")
    return ("✅ " if tid else "Демо-угоду не відкрито: ") + note


def apply_limits(new: dict, actor: str) -> str:
    cur = limits()
    for k, (lo, hi) in BOUNDS.items():
        if k in new:
            try:
                v = float(new[k])
            except (TypeError, ValueError):
                raise ValueError(f"{k}: має бути число")
            if not lo <= v <= hi:
                raise ValueError(f"{k}: від {lo} до {hi}")
            cur[k] = int(v) if k in ("max_trades_day", "max_open") else round(v, 2)
    db.set_setting("risk_limits", cur)
    audit(actor, "risk_limits", ", ".join(f"{k}={v}" for k, v in cur.items()), "warn")
    bus.publish("market", {})
    return "ліміти ризику оновлено"


def real_trade(p: dict) -> str:
    audit("owner", "real_trade_blocked", f"Підтверджено реальну угоду, але брокер не підключено: {p}", "warn")
    return "реальний брокер не підключено — угоду НЕ відкрито (лише демо)"


def view() -> dict:
    price = last_price()
    closed = db.q("SELECT * FROM trades WHERE status='closed' AND mode='demo' ORDER BY id DESC LIMIT 40")
    allc = db.one("SELECT COUNT(*) AS n, SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END) AS w FROM trades WHERE status='closed' AND mode='demo'")
    opens = open_trades()
    for t in opens:
        t["upnl"] = _pnl(t, price) if price else 0
    upnl = sum(t["upnl"] for t in opens)
    return {"enabled": enabled(), "limits": limits(), "open": opens, "journal": closed,
            "account": {"balance": balance(), "equity": round(balance() + upnl, 2), "day_pnl": day_pnl(price),
                        "closed": allc["n"] or 0, "win_rate": round(100 * (allc["w"] or 0) / allc["n"]) if allc["n"] else None,
                        "halted": halted_today()}}


def brief() -> str:
    v = view()
    a, lim = v["account"], v["limits"]
    s = (f"Демо-рахунок: баланс ${a['balance']:.2f}, сьогодні {a['day_pnl']:+.2f}$, відкрито {len(v['open'])}. "
         f"Ліміти: позиція ≤ {lim['max_position_oz']} oz, ризик {lim['risk_pct']}%/угоду, денний збиток ≤ ${lim['daily_loss_usd']}, "
         f"ціль {lim['rr']}R, стоп {lim['atr_mult']}×ATR. Демо-торгівля {'увімкнена' if v['enabled'] else 'вимкнена'}.")
    if a["halted"]:
        s += f" ЗУПИНЕНО: {a['halted']}."
    return s


def day_stats(day: str) -> dict:
    from .reports import _day_bounds

    a, b = _day_bounds(day)
    r = db.one("SELECT COUNT(*) AS n, COALESCE(SUM(pnl),0) AS p FROM trades WHERE mode='demo' AND status='closed' AND closed BETWEEN ? AND ?", (a, b))
    h = db.get_setting("trading_halt", {}) or {}
    return {"trades": r["n"], "pnl": round(r["p"], 2), "balance": balance(), "halted": h.get("day") == day}


# ---------- маршрути (лише власник) ----------
@router.post("/enabled")
async def api_enabled(request: Request):
    b = await request.json()
    set_enabled(bool(b.get("enabled")), "owner")
    return {"enabled": enabled()}


@router.post("/limits")
async def api_limits(request: Request):
    try:
        return {"note": apply_limits(await request.json(), "owner"), "limits": limits()}
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/close/{tid}")
async def api_close(tid: int):
    price = last_price()
    if not price or not close_trade(tid, price, "закрито вручну", "owner"):
        raise HTTPException(409, "Позицію не знайдено або немає ціни")
    return {"ok": True}


@router.post("/reset")
async def api_reset():
    for t in open_trades():
        close_trade(t["id"], last_price() or t["entry"], "скидання рахунку", "owner")
    db.set_setting("demo_balance", START_BALANCE)
    db.set_setting("trading_halt", {})
    audit("owner", "demo_reset", f"Демо-баланс скинуто до ${START_BALANCE:.0f}", "warn")
    return {"ok": True}
