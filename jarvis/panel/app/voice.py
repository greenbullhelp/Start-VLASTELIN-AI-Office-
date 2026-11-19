"""Голос: збереження аудіо й розпізнавання мови.

У панелі мова розпізнається прямо в браузері (Web Speech API), а аудіо зберігається для історії.
Якщо браузер тексту не дав (або голосове прийшло з Telegram), сервер розпізнає сам:
  STT_PROVIDER=local — faster-whisper на сервері (модель STT_MODEL, за замовчуванням base);
  STT_PROVIDER=node  — Whisper на домашньому ПК (якщо він онлайн);
  STT_PROVIDER=none  — без розпізнавання.
"""
from __future__ import annotations

import asyncio
import secrets
import time
from pathlib import Path

from .config import settings

_model = None


def save_audio(data: bytes, ext: str = "webm") -> Path:
    ext = ext if ext in ("webm", "ogg", "mp4", "m4a", "wav", "mp3") else "webm"
    name = f"{time.strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(4)}.{ext}"
    path = settings.data_dir / "voice" / name
    path.write_bytes(data[: 25 * 1024 * 1024])
    return path


def _local(path: Path) -> str:
    global _model
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return ""
    if _model is None:
        _model = WhisperModel(settings.stt_model, device="cpu", compute_type="int8",
                              download_root=str(settings.data_dir / "whisper"))
    segments, _info = _model.transcribe(str(path), language="uk", vad_filter=True, beam_size=1)
    return " ".join(s.text.strip() for s in segments).strip()


async def transcribe(path: Path) -> str:
    if settings.stt == "local":
        try:
            return await asyncio.to_thread(_local, path)
        except Exception:
            return ""
    if settings.stt == "node":
        from . import node_hub

        return await node_hub.transcribe_via_node(path)
    return ""


def available() -> str:
    if settings.stt == "local":
        try:
            import faster_whisper  # noqa: F401

            return "сервер (Whisper)"
        except ImportError:
            return "лише браузер"
    return {"node": "ПК-вузол (Whisper)", "none": "лише браузер"}.get(settings.stt, "лише браузер")
