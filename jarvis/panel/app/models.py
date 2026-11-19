"""Вибір моделі, ціна задачі й денний ліміт витрат.

За замовчуванням працює СЕРЕДНЯ модель. Автоматично:
  * дешева — короткі прості повідомлення, перевірки Контролера, службові підсумки;
  * сильна — архітектура, стратегія, глибокий аналіз, дуже довгі задачі.
У Налаштуваннях можна вибрати модель вручну (діє на всі нові задачі).
"""
from __future__ import annotations

import re

from . import db
from .config import settings
from .core import today

TIERS = ("cheap", "medium", "strong")
TIER_NAMES = {"cheap": "дешева", "medium": "середня", "strong": "сильна"}
# Орієнтовна вартість одного кроку агента — для перевірки ліміту ДО запуску
ESTIMATE = {"cheap": 0.005, "medium": 0.08, "strong": 0.25}
EFFORT = {"cheap": "low", "medium": "medium", "strong": "high"}

STRONG_RE = re.compile(
    r"архітектур|стратегі|глибок|складн|детальн\w* аналіз|бізнес-план|рефактор|баланс|"
    r"дослідж\w* ринк|спроєктуй|спроектуй|design doc|architecture|strategy", re.I)
TASK_RE = re.compile(
    r"зроби|створи|напиши|проаналіз|знайди|змонтуй|порахуй|підготуй|намалюй|розроби|перевір|"
    r"склади|запусти|оптиміз|онови|додай|план|звіт|код|\?", re.I)


def model_for(tier: str) -> str:
    return {"cheap": settings.model_cheap, "strong": settings.model_strong}.get(tier, settings.model_medium)


def mode() -> str:
    """auto | cheap | medium | strong — вибір з Налаштувань."""
    m = db.get_setting("model_mode", "auto")
    return m if m in ("auto", *TIERS) else "auto"


def daily_limit() -> float:
    return float(db.get_setting("daily_budget_usd", settings.daily_budget_usd))


def spent_today() -> float:
    r = db.one("SELECT COALESCE(SUM(usd), 0) AS s FROM costs WHERE day=?", (today(),))
    return round(float(r["s"] if r else 0), 6)


def choose(text: str, agent: str = "jarvis", pref: str = "", important: bool = False) -> tuple[str, str]:
    """Повертає (рівень, причина). pref — ручний вибір для конкретної задачі."""
    if pref in TIERS:
        return pref, "вибрано вручну для задачі"
    m = mode()
    if m != "auto":
        return m, "ручний режим у Налаштуваннях"
    t = text or ""
    if agent == "controller":
        return ("medium", "важлива перевірка") if important else ("cheap", "перевірка Контролера")
    if STRONG_RE.search(t) or len(t) > 2000:
        return "strong", "складна задача"
    if agent == "jarvis" and len(t) <= 80 and not TASK_RE.search(t):
        return "cheap", "коротке просте повідомлення"
    return "medium", "звичайна задача (за замовчуванням)"


def fit_budget(tier: str) -> tuple[str | None, str]:
    """Перевіряє денний ліміт перед запуском. Повертає (рівень або None, пояснення)."""
    left = daily_limit() - spent_today()
    if left <= 0:
        return None, f"Денний ліміт ${daily_limit():.2f} вичерпано (витрачено ${spent_today():.2f})."
    order = list(TIERS)
    i = order.index(tier)
    while i >= 0 and ESTIMATE[order[i]] > left:
        i -= 1
    if i < 0:
        return None, f"До ліміту лишилось ${left:.3f} — замало навіть для дешевої моделі."
    if order[i] != tier:
        return order[i], f"знижено до «{TIER_NAMES[order[i]]}»: до ліміту лишилось ${left:.2f}"
    return tier, ""


def price(model: str) -> tuple[float, float, float, float]:
    if model in settings.prices:
        return settings.prices[model]
    for k, v in settings.prices.items():  # напр. «anthropic/claude-sonnet-5-5»
        if k in model:
            return v
    return settings.prices.get(settings.model_strong, (4.0, 20.0, 0.2, 5.0))


def cost(model: str, usage: dict) -> float:
    p_in, p_out, p_cr, p_cw = price(model)
    tin = int(usage.get("input_tokens") or usage.get("prompt_tokens") or 0)
    tout = int(usage.get("output_tokens") or usage.get("completion_tokens") or 0)
    cr = int(usage.get("cache_read_tokens") or usage.get("cache_read_input_tokens") or 0)
    cw = int(usage.get("cache_write_tokens") or usage.get("cache_creation_input_tokens") or 0)
    return round((tin * p_in + tout * p_out + cr * p_cr + cw * p_cw) / 1e6, 6)


def book(agent: str, model: str, usage: dict, task_id: int | None = None, note: str = "") -> float:
    usd = cost(model, usage)
    tin = int(usage.get("input_tokens") or usage.get("prompt_tokens") or 0)
    tout = int(usage.get("output_tokens") or usage.get("completion_tokens") or 0)
    db.insert("costs", ts=db.now(), day=today(), task_id=task_id, agent=agent, model=model,
              tokens_in=tin, tokens_out=tout, usd=usd, note=note)
    return usd


def book_usd(agent: str, usd: float, note: str, task_id: int | None = None) -> None:
    """Витрати поза моделями (напр. платний API графіки)."""
    db.insert("costs", ts=db.now(), day=today(), task_id=task_id, agent=agent, model="external",
              tokens_in=0, tokens_out=0, usd=round(usd, 6), note=note)


def summary(day: str | None = None) -> dict:
    d = day or today()
    rows = db.q("SELECT agent, model, SUM(usd) AS usd, SUM(tokens_in) AS tin, SUM(tokens_out) AS tout, COUNT(*) AS n "
                "FROM costs WHERE day=? GROUP BY agent, model", (d,))
    return {"day": d, "total": round(sum(r["usd"] for r in rows), 4), "limit": daily_limit(), "rows": rows}
