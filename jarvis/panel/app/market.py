"""Ринок золота: ціни, свічки 15M, індикатори, рівні й сигнали (без моделі — безкоштовно).

Джерела (по черзі, якщо попереднє недоступне):
  свічки XAU/USDT 15M — Binance Futures → OKX (контракт XAU-USDT-SWAP);
  спот XAU/USD — gold-api.com (ближче до цін брокера на графіку власника).
Сигнал — подія «умови входу виконані», а не порада. Торгує лише демо-рушій (trading.py) з лімітами ризику.
"""
from __future__ import annotations

import asyncio
import math

import httpx
from fastapi import APIRouter

from . import db
from .core import audit, bus

TF = "15m"
TF_SEC = 900
router = APIRouter(prefix="/api/market")
_state: dict = {"source": "", "spot": None, "error": "", "updated": 0}


# ---------- джерела ----------
async def _binance(c: httpx.AsyncClient) -> list[tuple]:
    r = await c.get("https://fapi.binance.com/fapi/v1/klines", params={"symbol": "XAUUSDT", "interval": TF, "limit": 300})
    r.raise_for_status()
    return [(int(k[0]) // 1000, float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5])) for k in r.json()]


async def _okx(c: httpx.AsyncClient) -> list[tuple]:
    r = await c.get("https://www.okx.com/api/v5/market/candles", params={"instId": "XAU-USDT-SWAP", "bar": "15m", "limit": 300})
    r.raise_for_status()
    rows = r.json().get("data") or []
    if not rows:
        raise ValueError("OKX: порожня відповідь")
    return sorted((int(k[0]) // 1000, float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5]) * 0.001) for k in rows)


async def _spot(c: httpx.AsyncClient) -> float | None:
    try:
        r = await c.get("https://api.gold-api.com/price/XAU")
        return float(r.json()["price"])
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        return None


SOURCES = (("Binance Futures", _binance), ("OKX", _okx))


async def refresh() -> bool:
    async with httpx.AsyncClient(timeout=15, headers={"User-Agent": "jarvis-panel"}) as c:
        errors = []
        for name, fn in SOURCES:
            try:
                rows = await fn(c)
                save_candles(rows)
                _state.update(source=name, error="", updated=db.now())
                break
            except (httpx.HTTPError, ValueError, KeyError, TypeError) as e:
                errors.append(f"{name}: {type(e).__name__}")
        else:
            _state["error"] = "; ".join(errors)
        _state["spot"] = await _spot(c)
    return not _state["error"]


def save_candles(rows: list[tuple]) -> None:
    for t, o, h, l, cl, v in rows:
        db.run("INSERT INTO candles (tf, t, o, h, l, c, v) VALUES (?,?,?,?,?,?,?) "
               "ON CONFLICT(tf, t) DO UPDATE SET o=excluded.o, h=excluded.h, l=excluded.l, c=excluded.c, v=excluded.v",
               (TF, t, o, h, l, cl, v))
    db.run("DELETE FROM candles WHERE tf=? AND t < (SELECT MAX(t) FROM candles WHERE tf=?) - ?", (TF, TF, 3 * 86400))


def candles(limit: int = 300) -> list[dict]:
    return db.q("SELECT t, o, h, l, c, v FROM candles WHERE tf=? ORDER BY t DESC LIMIT ?", (TF, limit))[::-1]


def closed(limit: int = 300) -> list[dict]:
    """Лише закриті свічки (поточна, що формується, не дає сигналів)."""
    cs = candles(limit)
    if cs and cs[-1]["t"] + TF_SEC > db.now():
        cs = cs[:-1]
    return cs


# ---------- індикатори ----------
def ema(vals: list[float], n: int) -> list[float]:
    if not vals:
        return []
    k = 2 / (n + 1)
    out = [vals[0]]
    for v in vals[1:]:
        out.append(v * k + out[-1] * (1 - k))
    return out


def rsi(vals: list[float], n: int = 14) -> list[float]:
    out = [50.0] * len(vals)
    if len(vals) <= n:
        return out
    gains = [max(0.0, vals[i] - vals[i - 1]) for i in range(1, len(vals))]
    losses = [max(0.0, vals[i - 1] - vals[i]) for i in range(1, len(vals))]
    ag, al = sum(gains[:n]) / n, sum(losses[:n]) / n
    for i in range(n, len(vals)):
        if i > n:
            ag = (ag * (n - 1) + gains[i - 1]) / n
            al = (al * (n - 1) + losses[i - 1]) / n
        out[i] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    return out


def atr(cs: list[dict], n: int = 14) -> list[float]:
    if not cs:
        return []
    trs = [cs[0]["h"] - cs[0]["l"]]
    for i in range(1, len(cs)):
        p = cs[i - 1]["c"]
        trs.append(max(cs[i]["h"] - cs[i]["l"], abs(cs[i]["h"] - p), abs(cs[i]["l"] - p)))
    out = [trs[0]]
    for v in trs[1:]:
        out.append((out[-1] * (n - 1) + v) / n)
    return out


def levels(cs: list[dict], look: int = 96, k: int = 3) -> dict:
    """Найближчі рівні: свінгові максимуми/мінімуми за останню добу."""
    part = cs[-look:]
    highs, lows = [], []
    for i in range(k, len(part) - k):
        if all(part[i]["h"] >= part[j]["h"] for j in range(i - k, i + k + 1)):
            highs.append(part[i]["h"])
        if all(part[i]["l"] <= part[j]["l"] for j in range(i - k, i + k + 1)):
            lows.append(part[i]["l"])
    price = cs[-1]["c"] if cs else 0
    res = sorted({round(h, 2) for h in highs if h > price})[:3]
    sup = sorted({round(l, 2) for l in lows if l < price}, reverse=True)[:3]
    return {"resistance": [round(x, 2) for x in res], "support": [round(x, 2) for x in sup]}


def analyze(cs: list[dict] | None = None) -> dict:
    cs = cs if cs is not None else closed()
    if len(cs) < 60:
        return {"ready": False, "bars": len(cs)}
    closes = [c["c"] for c in cs]
    e20, e50, r, a = ema(closes, 20), ema(closes, 50), rsi(closes), atr(cs)
    price = closes[-1]
    if e20[-1] > e50[-1] and price > e50[-1]:
        trend = "висхідний"
    elif e20[-1] < e50[-1] and price < e50[-1]:
        trend = "низхідний"
    else:
        trend = "боковий"
    day = cs[-96:]
    return {"ready": True, "price": round(price, 2), "ema20": round(e20[-1], 2), "ema50": round(e50[-1], 2),
            "rsi": round(r[-1], 1), "rsi_prev": round(r[-2], 1), "atr": round(a[-1], 2), "trend": trend,
            "day_high": round(max(c["h"] for c in day), 2), "day_low": round(min(c["l"] for c in day), 2),
            "change_day": round((price / day[0]["o"] - 1) * 100, 2), **levels(cs), "t": cs[-1]["t"]}


def signal_from(ind: dict, rr: float = 2.0, atr_mult: float = 1.5) -> dict | None:
    """Правило сигналу: відкат проти тренду завершився (RSI повертається), стоп за ATR, ціль = rr × ризик."""
    if not ind.get("ready"):
        return None
    p, a = ind["price"], ind["atr"]
    if a <= 0:
        return None
    if ind["trend"] == "висхідний" and ind["rsi_prev"] < 45 <= ind["rsi"]:
        stop = round(p - atr_mult * a, 2)
        return {"side": "long", "entry": p, "stop": stop, "target": round(p + rr * (p - stop), 2),
                "reason": f"Висхідний тренд (EMA20 {ind['ema20']} > EMA50 {ind['ema50']}), відкат завершився: RSI {ind['rsi_prev']}→{ind['rsi']}; стоп {atr_mult}×ATR"}
    if ind["trend"] == "низхідний" and ind["rsi_prev"] > 55 >= ind["rsi"]:
        stop = round(p + atr_mult * a, 2)
        return {"side": "short", "entry": p, "stop": stop, "target": round(p - rr * (stop - p), 2),
                "reason": f"Низхідний тренд (EMA20 {ind['ema20']} < EMA50 {ind['ema50']}), відкат завершився: RSI {ind['rsi_prev']}→{ind['rsi']}; стоп {atr_mult}×ATR"}
    return None


def check_signal(ind: dict) -> dict | None:
    """Новий сигнал — не частіше одного на закриту свічку."""
    if not ind.get("ready"):
        return None
    last = db.get_setting("last_signal_bar", 0)
    if ind["t"] == last:
        return None
    try:
        from . import trading

        rr, mult = trading.limits()["rr"], trading.limits()["atr_mult"]
    except ImportError:
        rr, mult = 2.0, 1.5
    sig = signal_from(ind, rr, mult)
    if not sig:
        return None
    db.set_setting("last_signal_bar", ind["t"])
    sid = db.insert("signals", ts=db.now(), **sig)
    audit("market", "signal", f"#{sid} {sig['side']} {sig['entry']} стоп {sig['stop']} ціль {sig['target']}")
    bus.publish("market", {"signal": sid})
    return {"id": sid, **sig}


def brief() -> str:
    ind = analyze()
    if not ind.get("ready"):
        return "Ринок золота: даних ще недостатньо."
    s = (f"Золото XAU/USDT 15M: {ind['price']} ({ind['change_day']:+}% за добу), тренд {ind['trend']}, EMA20 {ind['ema20']}, "
         f"EMA50 {ind['ema50']}, RSI {ind['rsi']}, ATR {ind['atr']}; опір {ind['resistance']}, підтримка {ind['support']}.")
    if _state.get("spot"):
        s += f" Спот XAU/USD {_state['spot']:.2f}."
    return s


def snapshot() -> dict:
    cs = candles(200)
    ind = analyze()
    out = {"price": cs[-1]["c"] if cs else ind.get("price"), "spot": _state.get("spot"),
           "source": _state.get("source"), "error": _state.get("error"), "updated": _state.get("updated"),
           "candles": cs[-120:], "ind": ind, "signals": db.q("SELECT * FROM signals ORDER BY id DESC LIMIT 15")}
    if out["spot"] and out["price"]:
        out["basis"] = round(out["spot"] - out["price"], 2)
    try:
        from . import trading

        out.update(trading.view())
    except ImportError:
        pass
    return out


@router.get("")
async def api_market():
    return snapshot()


@router.post("/refresh")
async def api_refresh():
    ok = await refresh()
    ind = analyze()
    check_signal(ind)
    return {"ok": ok, "error": _state.get("error")}


async def background(orch) -> None:
    """Кожні 30 с: оновити ціни, перевірити сигнал, супроводити демо-позиції (стопи/цілі)."""
    await asyncio.sleep(3)
    while True:
        try:
            if await refresh():
                ind = analyze()
                sig = check_signal(ind)
                try:
                    from . import trading

                    if sig:
                        trading.on_signal(sig)
                    trading.tick(candles(3))
                except ImportError:
                    pass
                bus.publish("market", {})
        except Exception as e:  # ринок не має валити панель
            _state["error"] = f"{type(e).__name__}: {e}"
        await asyncio.sleep(30)


__all__ = ["router", "background", "brief", "snapshot", "analyze", "signal_from", "math"]
