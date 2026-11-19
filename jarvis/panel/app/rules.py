"""Правила Джарвіса. Текст правил іде в інструкції моделі, але головне — їх перевіряє код.

Кожна дія агентів проходить `check(action)`:
  * ALLOW   — виконується одразу (і пишеться в журнал);
  * CONFIRM — створюється запит на підтвердження власника (панель / Telegram);
  * DENY    — заборонено завжди, з попередженням у журналі.
Невідома дія вважається такою, що потребує підтвердження.
"""
from __future__ import annotations

import json

from . import db
from .core import audit, bus, redact

ALLOW, CONFIRM, DENY = "allow", "confirm", "deny"

# Що Джарвіс може робити сам
AUTO_ACTIONS = {
    "delegate": "планувати й роздавати задачі агентам",
    "create_agent": "створювати агентів",
    "restart_agent": "перезапускати агентів",
    "write_workspace": "писати код, тексти, графіку й відео в робочих папках",
    "research": "шукати інформацію й аналізувати ринок",
    "choose_model": "вибирати модель у межах денного ліміту",
    "trade_demo": "торгувати на демо-рахунку",
    "git_branch": "зберігати роботу в окремих гілках GitHub",
    "idea": "пропонувати покращення",
    "project": "вести проєкти",
    "node_job": "запускати на ПК дії з білого списку",
    "art_request": "замовляти графіку для гри на ПК",
    "card": "додавати картки до каталогу гри",
}

# Лише з підтвердження власника
CONFIRM_ACTIONS = {
    "spend": "витрачати гроші (платні API, підняття ліміту)",
    "real_trade": "відкривати реальні угоди",
    "risk_limits": "змінювати ліміти ризику",
    "publish": "публікувати щось від імені власника",
    "delete": "видаляти файли, проєкти чи агентів",
    "main_branch": "змінювати свій код у головній гілці",
    "server": "змінювати налаштування сервера",
    "node_new_action": "виконувати на ПК нові дії поза білим списком",
    "cloud_fallback": "виконати задачу ПК через платний API",
}

# Ніколи
DENY_ACTIONS = {
    "bypass_rules": "обходити правила",
    "reveal_secret": "показувати чи записувати в код ключі й паролі",
    "grant_access": "відкривати доступ стороннім",
    "illegal": "робити щось незаконне",
    "hide_errors": "приховувати помилки чи збитки",
}

RULES_TEXT = (
    "ПРАВИЛА (обов'язкові, перевіряються кодом панелі):\n"
    "Сам можеш: " + "; ".join(AUTO_ACTIONS.values()) + ".\n"
    "Лише з підтвердження власника (створи дію approval): " + "; ".join(CONFIRM_ACTIONS.values()) + ".\n"
    "Ніколи: " + "; ".join(DENY_ACTIONS.values()) + ".\n"
    "Діє денний ліміт витрат, журнал усіх дій і кнопка «Стоп». Про помилки й збитки звітуй чесно."
)


def check(action: str) -> str:
    if action in AUTO_ACTIONS:
        return ALLOW
    if action in DENY_ACTIONS:
        return DENY
    return CONFIRM


def request_approval(action: str, title: str, details: str = "", payload: dict | None = None,
                     requested_by: str = "jarvis", task_id: int | None = None) -> int:
    """Створює запит на підтвердження. Виконання — лише після рішення власника."""
    aid = db.insert("approvals", ts=db.now(), action=action, title=redact(title)[:200],
                    details=redact(details)[:3000], payload=payload or {}, requested_by=requested_by,
                    task_id=task_id)
    audit(requested_by, "approval_requested", f"#{aid} {action}: {title}", "warn")
    bus.publish("approvals", {"id": aid})
    from . import telegram  # пізній імпорт: Telegram необов'язковий

    telegram.notify_approval(aid)
    return aid


def gate(action: str, actor: str, title: str, details: str = "", payload: dict | None = None,
         task_id: int | None = None) -> tuple[str, int | None]:
    """Перевіряє дію. Повертає (рішення, id запиту на підтвердження або None)."""
    verdict = check(action)
    if verdict == ALLOW:
        audit(actor, action, title)
        return ALLOW, None
    if verdict == DENY:
        audit(actor, "denied:" + action, f"Заборонена дія відхилена: {title}", "error")
        return DENY, None
    return CONFIRM, request_approval(action, title, details, payload, actor, task_id)


def pending() -> list[dict]:
    rows = db.q("SELECT * FROM approvals WHERE status='pending' ORDER BY id DESC")
    for r in rows:
        r["payload"] = json.loads(r["payload"] or "{}")
    return rows


def decide(aid: int, approve: bool, note: str = "", actor: str = "owner") -> dict | None:
    r = db.one("SELECT * FROM approvals WHERE id=?", (aid,))
    if not r or r["status"] != "pending":
        return None
    status = "approved" if approve else "rejected"
    db.run("UPDATE approvals SET status=?, decided=?, note=? WHERE id=?", (status, db.now(), note[:500], aid))
    audit(actor, "approval_" + status, f"#{aid} {r['action']}: {r['title']}", "warn")
    bus.publish("approvals", {"id": aid, "status": status})
    r["status"] = status
    r["payload"] = json.loads(r["payload"] or "{}")
    return r
