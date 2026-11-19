"""Спільні дрібниці: журнал дій, шина подій для живого оновлення панелі, приховування секретів."""
from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime
from zoneinfo import ZoneInfo

from . import db
from .config import settings

TZ = ZoneInfo(settings.timezone)

_SECRET_PATTERNS = [
    re.compile(r"sk-ant-[A-Za-z0-9_\-]{10,}"),
    re.compile(r"sk-[A-Za-z0-9]{20,}"),
    re.compile(r"\b\d{8,10}:[A-Za-z0-9_\-]{30,}\b"),          # токен Telegram-бота
    re.compile(r"\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{20,}\b"),   # токени GitHub
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"(?i)\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*=\s*\S+"),
]


def redact(text: str) -> str:
    """Вирізає ключі та паролі з тексту. Джарвіс ніколи не показує й не записує їх."""
    if not text:
        return text
    for v in settings.secret_values():
        text = text.replace(v, "[приховано]")
    for p in _SECRET_PATTERNS:
        text = p.sub(lambda m: (m.group(1) + "=[приховано]") if m.re.groups else "[приховано]", text)
    return text


def local_now() -> datetime:
    return datetime.now(TZ)


def today() -> str:
    return local_now().strftime("%Y-%m-%d")


class Bus:
    """Розсилає події всім відкритим вкладкам панелі (SSE)."""

    def __init__(self) -> None:
        self.subs: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=200)
        self.subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self.subs.discard(q)

    def publish(self, kind: str, data: dict | None = None) -> None:
        msg = json.dumps({"type": kind, "data": data or {}}, ensure_ascii=False, default=str)
        for q in list(self.subs):
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                pass


bus = Bus()


def audit(actor: str, action: str, details: str = "", level: str = "info") -> None:
    """Журнал усіх дій. Записи не видаляються з панелі."""
    db.insert("audit", ts=db.now(), actor=actor, action=action, details=redact(details)[:4000], level=level)
    bus.publish("audit", {"actor": actor, "action": action, "level": level})
