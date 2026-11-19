"""Налаштування панелі. Усі секрети — тільки зі змінних середовища (.env на сервері).

У коді немає жодного справжнього ключа. Якщо змінна не задана, відповідна функція
вимикається й панель чесно показує це в статусах.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _float(name: str, default: float) -> float:
    try:
        return float(_env(name, str(default)))
    except ValueError:
        return default


def _int(name: str, default: int) -> int:
    try:
        return int(_env(name, str(default)))
    except ValueError:
        return default


# Ціни Claude API, $ за 1 млн токенів: (вхід, вихід, читання кешу, запис кешу).
DEFAULT_PRICES = {
    "claude-haiku-5-5": (0.10, 0.50, 0.01, 0.125),
    "claude-sonnet-5-5": (2.00, 10.00, 0.10, 2.50),
    "claude-opus-5-5": (4.00, 20.00, 0.20, 5.00),
}


@dataclass
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(_env("DATA_DIR", "./data")))
    timezone: str = field(default_factory=lambda: _env("TZ", "Europe/Kyiv"))
    public_url: str = field(default_factory=lambda: _env("PUBLIC_URL", "http://localhost:8000"))
    owner_name: str = field(default_factory=lambda: _env("OWNER_NAME", "власник") or "власник")

    # «Мозок»: hermes (основний режим) | anthropic (прямий виклик Claude, запасний) | mock (тести)
    brain: str = field(default_factory=lambda: _env("BRAIN", "hermes"))
    hermes_url: str = field(default_factory=lambda: _env("HERMES_URL", "http://hermes:8642"))
    hermes_key: str = field(default_factory=lambda: _env("API_SERVER_KEY"))
    hermes_provider: str = field(default_factory=lambda: _env("HERMES_PROVIDER", "anthropic"))
    hermes_run_timeout: int = field(default_factory=lambda: _int("HERMES_RUN_TIMEOUT", 900))
    anthropic_key: str = field(default_factory=lambda: _env("ANTHROPIC_API_KEY"))

    # Моделі: дешева / середня (за замовчуванням) / сильна
    model_cheap: str = field(default_factory=lambda: _env("MODEL_CHEAP", "claude-haiku-5-5"))
    model_medium: str = field(default_factory=lambda: _env("MODEL_MEDIUM", "claude-sonnet-5-5"))
    model_strong: str = field(default_factory=lambda: _env("MODEL_STRONG", "claude-opus-5-5"))
    daily_budget_usd: float = field(default_factory=lambda: _float("DAILY_BUDGET_USD", 3.0))
    max_parallel: int = field(default_factory=lambda: _int("MAX_PARALLEL_AGENTS", 2))

    # Telegram (необов'язково)
    telegram_token: str = field(default_factory=lambda: _env("TELEGRAM_BOT_TOKEN"))
    telegram_owner_id: str = field(default_factory=lambda: _env("TELEGRAM_OWNER_ID"))

    # Вузол на домашньому ПК
    node_token: str = field(default_factory=lambda: _env("NODE_TOKEN"))

    # Платний запасний API для графіки (лише з підтвердження власника)
    stability_key: str = field(default_factory=lambda: _env("STABILITY_API_KEY"))

    # Розпізнавання мови на сервері: local (faster-whisper) | node | none
    stt: str = field(default_factory=lambda: _env("STT_PROVIDER", "local"))
    stt_model: str = field(default_factory=lambda: _env("STT_MODEL", "base"))

    report_hour: int = field(default_factory=lambda: _int("REPORT_HOUR", 21))
    cookie_secure: bool = field(default_factory=lambda: _env("COOKIE_SECURE", "1") != "0")
    session_days: int = field(default_factory=lambda: _int("SESSION_DAYS", 14))

    prices: dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.prices = dict(DEFAULT_PRICES)
        extra = _env("MODEL_PRICES_JSON")
        if extra:
            try:
                for k, v in json.loads(extra).items():
                    self.prices[k] = tuple(float(x) for x in v)
            except (ValueError, TypeError):
                pass
        self.data_dir.mkdir(parents=True, exist_ok=True)
        for sub in ("workspace", "workspace/node_out", "workspace/game/art", "workspace/video", "voice", "backups"):
            (self.data_dir / sub).mkdir(parents=True, exist_ok=True)

    @property
    def db_path(self) -> Path:
        return self.data_dir / "jarvis.db"

    @property
    def workspace(self) -> Path:
        return self.data_dir / "workspace"

    def secret_values(self) -> list[str]:
        """Значення секретів — щоб вирізати їх із будь-якого тексту перед показом."""
        vals = [self.hermes_key, self.anthropic_key, self.telegram_token, self.node_token, self.stability_key,
                _env("GH_TOKEN"), _env("GITHUB_TOKEN")]
        return [v for v in vals if v and len(v) >= 8]


settings = Settings()
