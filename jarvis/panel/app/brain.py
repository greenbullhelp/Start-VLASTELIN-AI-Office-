"""«Мозок» Джарвіса — як панель обмінюється даними з Hermes Agent.

Основний режим `HermesBrain` (BRAIN=hermes):
  панель → Hermes:  POST {HERMES_URL}/v1/runs  {input, instructions, session_id, model, provider}
                    з заголовком Authorization: Bearer API_SERVER_KEY (мережа Docker, назовні не відкрито);
  стан і результат: GET /v1/runs/{run_id}  → status, output, usage (токени), runtime (яка модель відповіла);
  кнопка «Стоп»:    POST /v1/runs/{run_id}/stop.
  Hermes виконує задачу своїми інструментами (термінал, файли, веб-пошук, пам'ять) у робочій папці.
  Назад до панелі Hermes «говорить» блоком ```actions [...]``` у відповіді — панель розбирає його
  і пропускає кожну дію через правила (rules.gate).

Запасні режими: `AnthropicBrain` (BRAIN=anthropic — пряма розмова з Claude без інструментів Hermes)
і `MockBrain` (BRAIN=mock — для тестів, без мережі й витрат).
"""
from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass, field

import httpx

from .config import settings
from .models import EFFORT


@dataclass
class BrainResult:
    text: str
    usage: dict = field(default_factory=dict)
    model: str = ""
    run_id: str = ""
    status: str = "completed"   # completed | failed | cancelled | incomplete
    error: str = ""


class BrainError(Exception):
    pass


TERMINAL = {"completed", "failed", "cancelled", "interrupted", "incomplete", "expired"}


class HermesBrain:
    name = "hermes"

    def __init__(self) -> None:
        self.active: dict[str, str] = {}  # run_id → session
        self.client = httpx.AsyncClient(base_url=settings.hermes_url, timeout=30,
                                         headers={"Authorization": f"Bearer {settings.hermes_key}"})

    async def health(self) -> dict:
        try:
            r = await self.client.get("/health", timeout=5)
            return {"ok": r.status_code == 200, "detail": "Hermes на зв'язку" if r.status_code == 200 else f"HTTP {r.status_code}"}
        except httpx.HTTPError as e:
            return {"ok": False, "detail": f"Hermes недоступний: {type(e).__name__}"}

    async def run(self, prompt: str, *, instructions: str, session: str, model: str, tier: str,
                  history: list[dict] | None = None) -> BrainResult:
        body = {"input": prompt, "instructions": instructions, "session_id": session,
                "model": model, "provider": settings.hermes_provider,
                "model_options": {"reasoning_effort": EFFORT.get(tier, "medium")}}
        try:
            r = await self.client.post("/v1/runs", json=body)
        except httpx.HTTPError as e:
            raise BrainError(f"Hermes недоступний: {type(e).__name__}") from e
        if r.status_code == 429:
            raise BrainError("Hermes зайнятий (забагато одночасних задач) — спробую пізніше")
        if r.status_code >= 400:
            raise BrainError(f"Hermes відхилив запит: HTTP {r.status_code} {r.text[:300]}")
        run_id = r.json().get("run_id", "")
        if not run_id:
            raise BrainError("Hermes не повернув run_id")
        self.active[run_id] = session
        try:
            return await self._wait(run_id, model)
        finally:
            self.active.pop(run_id, None)

    async def _wait(self, run_id: str, model: str) -> BrainResult:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + settings.hermes_run_timeout
        delay = 1.0
        while True:
            await asyncio.sleep(delay)
            delay = min(delay * 1.3, 4.0)
            try:
                r = await self.client.get(f"/v1/runs/{run_id}")
            except httpx.HTTPError:
                if loop.time() > deadline:
                    raise BrainError("Hermes не відповідає")
                continue
            if r.status_code == 404:
                raise BrainError("Hermes втратив задачу (перезапуск?)")
            d = r.json()
            status = d.get("status", "")
            if status in TERMINAL:
                runtime = d.get("runtime") or {}
                text = d.get("output") or ""
                if isinstance(text, list):
                    text = "\n".join(str(x.get("text", x)) if isinstance(x, dict) else str(x) for x in text)
                return BrainResult(text=str(text), usage=d.get("usage") or {}, run_id=run_id,
                                   model=runtime.get("model") or model, status=status,
                                   error=str(d.get("error") or ""))
            if loop.time() > deadline:
                await self.stop(run_id)
                raise BrainError(f"Задача перевищила ліміт часу {settings.hermes_run_timeout} с і зупинена")

    async def stop(self, run_id: str) -> None:
        try:
            await self.client.post(f"/v1/runs/{run_id}/stop", timeout=5)
        except httpx.HTTPError:
            pass

    async def stop_all(self) -> int:
        ids = list(self.active)
        await asyncio.gather(*(self.stop(i) for i in ids))
        return len(ids)


class AnthropicBrain:
    """Запасний режим: напряму Claude API (без інструментів Hermes)."""
    name = "anthropic"

    def __init__(self) -> None:
        import anthropic

        self.anthropic = anthropic
        self.client = anthropic.AsyncAnthropic(api_key=settings.anthropic_key or None)
        self.tasks: set[asyncio.Task] = set()

    async def health(self) -> dict:
        ok = bool(settings.anthropic_key)
        return {"ok": ok, "detail": "Пряме з'єднання з Claude API" if ok else "Немає ANTHROPIC_API_KEY"}

    async def run(self, prompt: str, *, instructions: str, session: str, model: str, tier: str,
                  history: list[dict] | None = None) -> BrainResult:
        msgs = [m for m in (history or []) if m.get("role") in ("user", "assistant") and m.get("content")]
        while msgs and msgs[0]["role"] != "user":
            msgs.pop(0)
        msgs.append({"role": "user", "content": prompt})
        merged: list[dict] = []
        for m in msgs:  # ролі мають чергуватися
            if merged and merged[-1]["role"] == m["role"]:
                merged[-1]["content"] += "\n\n" + m["content"]
            else:
                merged.append(dict(m))
        coro = self.client.messages.create(
            model=model, max_tokens=8000, system=instructions, messages=merged,
            output_config={"effort": EFFORT.get(tier, "medium")})
        task = asyncio.ensure_future(coro)
        self.tasks.add(task)
        try:
            resp = await task
        except asyncio.CancelledError:
            return BrainResult(text="", status="cancelled", model=model)
        except self.anthropic.RateLimitError as e:
            raise BrainError("Claude API: забагато запитів, спробую пізніше") from e
        except self.anthropic.APIStatusError as e:
            raise BrainError(f"Claude API: помилка {e.status_code}") from e
        except self.anthropic.APIConnectionError as e:
            raise BrainError("Claude API недоступний") from e
        finally:
            self.tasks.discard(task)
        if resp.stop_reason == "refusal":
            return BrainResult(text="Модель відмовилась виконувати цей запит.", status="failed", model=model,
                               usage=resp.usage.model_dump())
        text = "".join(b.text for b in resp.content if b.type == "text")
        return BrainResult(text=text, usage=resp.usage.model_dump(), model=resp.model or model)

    async def stop_all(self) -> int:
        n = len(self.tasks)
        for t in list(self.tasks):
            t.cancel()
        return n


class MockBrain:
    """Тестовий мозок: відповідає за простими правилами, рахує «токени» як довжину тексту."""
    name = "mock"

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.script: list[str] = []      # заготовлені відповіді (для тестів)
        self.delay = 0.0
        self.stopped = 0

    async def health(self) -> dict:
        return {"ok": True, "detail": "Тестовий режим (без мережі)"}

    async def run(self, prompt: str, *, instructions: str, session: str, model: str, tier: str,
                  history: list[dict] | None = None) -> BrainResult:
        self.calls.append({"prompt": prompt, "instructions": instructions, "session": session, "model": model, "tier": tier})
        if self.delay:
            try:
                await asyncio.sleep(self.delay)
            except asyncio.CancelledError:
                return BrainResult(text="", status="cancelled", model=model)
        if self.script:
            text = self.script.pop(0)
        elif "ВЕРДИКТ" in instructions:
            text = '{"ok": true, "score": 8, "notes": "Перевірено, все гаразд"}'
        else:
            text = f"Готово: {prompt[:120]}"
        return BrainResult(text=text, model=model,
                           usage={"input_tokens": len(prompt) + len(instructions), "output_tokens": len(text)})

    async def stop_all(self) -> int:
        self.stopped += 1
        return 0


def make_brain():
    if settings.brain == "mock":
        return MockBrain()
    if settings.brain == "anthropic":
        return AnthropicBrain()
    return HermesBrain()


ACTIONS_RE = re.compile(r"```(?:actions|json\s+actions)\s*\n(.*?)```", re.S | re.I)


def split_actions(text: str) -> tuple[str, list[dict]]:
    """Відокремлює блок ```actions [...]``` від тексту відповіді."""
    actions: list[dict] = []
    for m in ACTIONS_RE.finditer(text or ""):
        try:
            data = json.loads(m.group(1))
        except ValueError:
            continue
        if isinstance(data, dict):
            data = data.get("actions", [data])
        if isinstance(data, list):
            actions.extend(a for a in data if isinstance(a, dict) and a.get("type"))
    clean = ACTIONS_RE.sub("", text or "").strip()
    return clean, actions[:20]
