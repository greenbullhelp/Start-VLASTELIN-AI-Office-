"""Telegram — додатковий канал зв'язку з Джарвісом.

* Бот слухає ЛИШЕ власника (TELEGRAM_OWNER_ID); повідомлення від інших ігноруються й пишуться в журнал.
* Текст і голосові → задача Джарвісу; відповідь приходить у Telegram.
* Команди: stop / /stop — миттєво зупинити всіх агентів; /resume — продовжити;
  /status — стан; /report — звіт зараз; /approve N, /reject N — рішення щодо запитів.
"""
from __future__ import annotations

import asyncio
import re

import httpx

from . import db
from .config import settings
from .core import audit, redact

API = "https://api.telegram.org"
_queue: asyncio.Queue | None = None
_orch = None


def enabled() -> bool:
    return bool(settings.telegram_token and settings.telegram_owner_id)


def send_owner(text: str) -> None:
    """Неблокуюче надсилання власнику (через чергу)."""
    if not enabled() or _queue is None:
        return
    try:
        _queue.put_nowait(redact(text)[:3900])
    except asyncio.QueueFull:
        pass


def notify_approval(aid: int) -> None:
    r = db.one("SELECT * FROM approvals WHERE id=?", (aid,))
    if r:
        send_owner(f"🔐 Потрібне підтвердження #{aid}\n{r['title']}\n{r['details'][:600]}\n\n"
                   f"/approve {aid} — дозволити\n/reject {aid} — відхилити")


async def _sender(client: httpx.AsyncClient) -> None:
    assert _queue is not None
    while True:
        text = await _queue.get()
        try:
            await client.post(f"{API}/bot{settings.telegram_token}/sendMessage",
                              json={"chat_id": settings.telegram_owner_id, "text": text})
        except httpx.HTTPError:
            await asyncio.sleep(5)
        await asyncio.sleep(0.4)


async def _download_voice(client: httpx.AsyncClient, file_id: str) -> bytes | None:
    r = await client.get(f"{API}/bot{settings.telegram_token}/getFile", params={"file_id": file_id})
    path = (r.json().get("result") or {}).get("file_path")
    if not path:
        return None
    f = await client.get(f"{API}/file/bot{settings.telegram_token}/{path}")
    return f.content if f.status_code == 200 else None


async def handle(client: httpx.AsyncClient, msg: dict) -> None:
    from . import rules, voice

    chat_id = str((msg.get("chat") or {}).get("id", ""))
    if chat_id != str(settings.telegram_owner_id):
        audit("system", "telegram_foreign", f"Повідомлення від стороннього чату {chat_id} проігноровано", "warn")
        return
    text = (msg.get("text") or "").strip()
    low = text.lower()
    if low in ("stop", "/stop", "стоп", "/стоп"):
        await _orch.stop_all("owner", "команда stop у Telegram")
        return
    if low in ("/resume", "resume", "продовжити"):
        _orch.resume("owner")
        send_owner("▶ Роботу агентів відновлено.")
        return
    if low in ("/status", "статус"):
        from .reports import status_text

        send_owner(status_text())
        return
    if low in ("/report", "звіт"):
        from .reports import make_report

        send_owner(make_report(save=False)["text"])
        return
    m = re.match(r"^/(approve|reject)\s+(\d+)\s*(.*)$", text)
    if m:
        ap = rules.decide(int(m.group(2)), m.group(1) == "approve", m.group(3), "owner(telegram)")
        if not ap:
            send_owner("Запит не знайдено або вже вирішено.")
            return
        out = _orch.on_decision(ap)
        send_owner(f"Запит #{ap['id']}: {'схвалено' if ap['status'] == 'approved' else 'відхилено'} — {out}")
        return
    if text.startswith("/start"):
        send_owner("Джарвіс на зв'язку. Пишіть задачу текстом або голосом. stop — зупинити всіх агентів.")
        return
    voice_obj = msg.get("voice") or msg.get("audio")
    if voice_obj:
        data = await _download_voice(client, voice_obj["file_id"])
        if not data:
            send_owner("Не вдалося завантажити голосове.")
            return
        path = voice.save_audio(data, "ogg")
        text = await voice.transcribe(path)
        if not text:
            send_owner("Голосове отримано, але розпізнати мову не вдалося. Напишіть, будь ласка, текстом.")
            return
        _orch.submit(text, "telegram", meta={"voice": path.name})
        return
    if text:
        _orch.submit(text, "telegram")


async def run(orch) -> None:
    """Довге опитування Telegram (без вебхука — не треба відкривати порт)."""
    global _queue, _orch
    _orch = orch
    if not enabled():
        return
    _queue = asyncio.Queue(maxsize=100)
    offset = int(db.get_setting("tg_offset", 0))
    async with httpx.AsyncClient(timeout=40) as client:
        sender = asyncio.create_task(_sender(client))
        audit("system", "telegram_on", "Telegram-бот запущено")
        try:
            while True:
                try:
                    r = await client.get(f"{API}/bot{settings.telegram_token}/getUpdates",
                                         params={"timeout": 30, "offset": offset, "allowed_updates": '["message"]'})
                    for upd in r.json().get("result", []):
                        offset = upd["update_id"] + 1
                        db.set_setting("tg_offset", offset)
                        if upd.get("message"):
                            try:
                                await handle(client, upd["message"])
                            except Exception as e:
                                audit("system", "telegram_error", f"{type(e).__name__}: {e}", "error")
                except (httpx.HTTPError, ValueError):
                    await asyncio.sleep(10)
        finally:
            sender.cancel()
