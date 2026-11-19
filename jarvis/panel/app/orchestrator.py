"""Оркестратор: черга задач, виконавці, Контролер, блокування файлів, кнопка «Стоп».

Потік задачі:
  власник → Джарвіс (задача agent=jarvis) → відповідь + дії delegate → підзадачі виконавцям
  → (важливі) перевірка Контролера → до 2 доопрацювань → підсумок Джарвіса в чаті.
Блокування: виконавець отримує свою робочу область (game/, video/, trading/) і папки з `paths`;
поки область зайнята, інша задача, що її змінює, чекає — так агенти не конфліктують через файли.
"""
from __future__ import annotations

import asyncio
import json
import re
import traceback

from . import agents, db, models, rules
from .brain import BrainError, BrainResult, split_actions
from .config import settings
from .core import audit, bus, redact

ACTIVE = ("running", "review_running")
WAITING = ("queued", "waiting", "review")
TERMINAL = ("done", "failed", "stopped", "needs_owner", "cancelled")
MAX_REWORK = 2
MAX_CHILDREN = 8


def post(role: str, text: str, source: str = "panel", task_id: int | None = None, meta: dict | None = None) -> int:
    mid = db.insert("messages", ts=db.now(), role=role, text=redact(text), source=source, task_id=task_id,
                    meta=meta or {})
    bus.publish("message", {"id": mid, "role": role})
    if role == "jarvis" and source == "telegram":
        from . import telegram

        telegram.send_owner(text)
    return mid


def task_row(tid: int) -> dict | None:
    return db.one("SELECT * FROM tasks WHERE id=?", (tid,))


def set_task(tid: int, **cols) -> None:
    cols["updated"] = db.now()
    db.update("tasks", tid, **cols)
    bus.publish("task", {"id": tid, **{k: v for k, v in cols.items() if k in ("status", "cost", "agent")}})


def _norm(p: str) -> str:
    p = re.sub(r"^/?(opt/data/)?workspace/?", "", str(p).strip()).strip("/")
    return re.sub(r"\.\.+", "", p)[:120]


def resources(t: dict) -> list[str]:
    res = set()
    a = agents.area(t["agent"])
    if a:
        res.add(a)
    for p in json.loads(t.get("paths") or "[]"):
        n = _norm(p)
        if n:
            res.add(n)
    return sorted(res)


def _overlap(a: str, b: str) -> bool:
    return a == b or a.startswith(b + "/") or b.startswith(a + "/")


class Orchestrator:
    def __init__(self, brain) -> None:
        self.brain = brain
        self.running: dict[int, asyncio.Task] = {}
        self.wake = asyncio.Event()
        self._loop_task: asyncio.Task | None = None

    # ---------- стан ----------
    @property
    def halted(self) -> bool:
        return bool(db.get_setting("halted", False))

    def start(self) -> None:
        agents.ensure_agents()
        # після перезапуску сервера «зависли» задачі в роботі — повертаємо в чергу
        for t in db.q("SELECT id FROM tasks WHERE status IN ('running','review_running')"):
            st = "review" if task_row(t["id"])["status"] == "review_running" else "queued"
            set_task(t["id"], status=st)
        db.run("DELETE FROM locks")
        self._loop_task = asyncio.create_task(self._loop())

    async def shutdown(self) -> None:
        if self._loop_task:
            self._loop_task.cancel()
        for t in list(self.running.values()):
            t.cancel()

    async def _loop(self) -> None:
        while True:
            try:
                self.tick()
            except Exception:  # оркестратор не має падати від однієї помилки
                audit("system", "orchestrator_error", traceback.format_exc()[-1500:], "error")
            try:
                await asyncio.wait_for(self.wake.wait(), timeout=2)
            except asyncio.TimeoutError:
                pass
            self.wake.clear()

    def poke(self) -> None:
        self.wake.set()

    # ---------- прийом задач ----------
    def submit(self, text: str, source: str = "panel", model_pref: str = "", meta: dict | None = None) -> int:
        text = text.strip()[:8000]
        tid = db.insert("tasks", agent="jarvis", title=text[:90] or "Задача", brief=text, source=source,
                        model_pref=model_pref, created=db.now(), updated=db.now())
        post("owner", text, source, tid, meta)
        audit("owner", "task_submitted", f"#{tid} ({source}): {text[:200]}")
        if self.halted:
            post("jarvis", "⏸ Агенти зупинені кнопкою «Стоп». Задачу записано в чергу — натисніть «Продовжити», щоб я почав.",
                 source, tid)
        bus.publish("task", {"id": tid, "status": "queued"})
        self.poke()
        return tid

    def add_child(self, parent: dict, agent: str, title: str, brief: str, important: bool, paths: list) -> int | None:
        n = db.one("SELECT COUNT(*) AS n FROM tasks WHERE parent_id=?", (parent["id"],))["n"]
        if n >= MAX_CHILDREN:
            return None
        tid = db.insert("tasks", parent_id=parent["id"], agent=agent, title=title[:120], brief=brief[:6000],
                        source=parent["source"], important=int(bool(important)),
                        paths=[_norm(p) for p in paths][:6], created=db.now(), updated=db.now())
        bus.publish("task", {"id": tid, "status": "queued", "agent": agent})
        return tid

    # ---------- планувальник ----------
    def tick(self) -> None:
        if self.halted:
            return
        free = max(1, settings.max_parallel) - len(self.running)
        if free <= 0:
            return
        held = {r["resource"]: r for r in db.q("SELECT * FROM locks")}
        for t in db.q("SELECT * FROM tasks WHERE status IN ('queued','waiting','review') ORDER BY id"):
            if free <= 0:
                break
            if t["id"] in self.running:
                continue
            if t["status"] == "review":
                self._spawn(t, review=True)
                free -= 1
                continue
            res = resources(t)
            clash = [h for h in held.values() if h["task_id"] != t["id"] and any(_overlap(r, h["resource"]) for r in res)]
            if clash:
                if t["status"] != "waiting":
                    set_task(t["id"], status="waiting", error=f"Чекає: область «{clash[0]['resource']}» зайнята задачею #{clash[0]['task_id']}")
                    audit("controller", "lock_wait", f"#{t['id']} чекає #{clash[0]['task_id']} ({clash[0]['resource']})")
                continue
            for r in res:
                db.run("INSERT OR REPLACE INTO locks (resource, task_id, agent, ts) VALUES (?,?,?,?)",
                       (r, t["id"], t["agent"], db.now()))
                held[r] = {"resource": r, "task_id": t["id"]}
            self._spawn(t)
            free -= 1

    def _spawn(self, t: dict, review: bool = False) -> None:
        set_task(t["id"], status="review_running" if review else "running", started=t["started"] or db.now(), error="")
        coro = self._review(t["id"]) if review else self._execute(t["id"])
        task = asyncio.create_task(coro)
        self.running[t["id"]] = task
        task.add_done_callback(lambda _f, tid=t["id"]: self._done(tid))

    def _done(self, tid: int) -> None:
        self.running.pop(tid, None)
        t = task_row(tid)
        if t and t["status"] not in ("review",):
            db.run("DELETE FROM locks WHERE task_id=?", (tid,))
        self.poke()

    # ---------- виконання ----------
    def _context(self, t: dict) -> str:
        lines = [f"Власник: {settings.owner_name}. Задача #{t['id']}."]
        left = models.daily_limit() - models.spent_today()
        lines.append(f"Бюджет на сьогодні: витрачено ${models.spent_today():.2f} з ${models.daily_limit():.2f} (лишилось ${left:.2f}).")
        act = db.q("SELECT id, agent, title, status FROM tasks WHERE status NOT IN ('done','failed','stopped','cancelled','needs_owner') AND id<>? ORDER BY id DESC LIMIT 8", (t["id"],))
        if act:
            lines.append("Активні задачі: " + "; ".join(f"#{a['id']} {a['agent']} «{a['title'][:50]}» ({a['status']})" for a in act))
        pr = db.q("SELECT name, area, progress FROM projects WHERE status='active' ORDER BY updated DESC LIMIT 8")
        if pr:
            lines.append("Проєкти: " + "; ".join(f"{p['name']} [{p['area']}] {p['progress']}%" for p in pr))
        try:
            from . import node_hub

            lines.append("ПК-вузол: " + ("онлайн" if node_hub.online() else "офлайн (задачі для ПК чекатимуть у черзі)"))
        except ImportError:
            pass
        if t["agent"] == "trading":
            try:
                from . import trading

                lines.append(trading.brief())
            except ImportError:
                pass
        if t["agent"] == "game":
            try:
                from . import game

                lines.append(game.brief())
            except ImportError:
                pass
        if t["rework"] and t["review"]:
            lines.append(f"ДООПРАЦЮВАННЯ #{t['rework']}: зауваження Контролера — {t['review'][:1500]}\nПопередній результат:\n{t['result'][:3000]}")
        return "\n".join(lines)

    def _history(self) -> list[dict]:
        rows = db.q("SELECT role, text FROM messages ORDER BY id DESC LIMIT 10")[::-1]
        return [{"role": "user" if r["role"] == "owner" else "assistant", "content": r["text"][:2000]} for r in rows
                if r["role"] in ("owner", "jarvis")]

    async def _call(self, t: dict, agent: str, prompt: str, instructions: str, tier_hint_text: str,
                    important: bool = False) -> tuple[BrainResult | None, str, str]:
        tier, why = models.choose(tier_hint_text, agent, t.get("model_pref", ""), important)
        fitted, note = models.fit_budget(tier)
        if fitted is None:
            return None, tier, note
        model = models.model_for(fitted)
        set_task(t["id"], tier=fitted, model=model)
        audit(agent, "choose_model", f"#{t['id']}: {models.TIER_NAMES[fitted]} ({model}) — {note or why}")
        hist = self._history() if agent == "jarvis" else None
        res = await self.brain.run(prompt, instructions=instructions, session=agents.session_id(agent),
                                   model=model, tier=fitted, history=hist)
        usd = models.book(agent, res.model or model, res.usage, t["id"])
        cur = task_row(t["id"])
        tin = int(res.usage.get("input_tokens") or res.usage.get("prompt_tokens") or 0)
        tout = int(res.usage.get("output_tokens") or res.usage.get("completion_tokens") or 0)
        set_task(t["id"], cost=round(cur["cost"] + usd, 6), tokens_in=cur["tokens_in"] + tin,
                 tokens_out=cur["tokens_out"] + tout, run_id=res.run_id, model=res.model or model)
        bus.publish("costs", {"spent": models.spent_today()})
        return res, fitted, note

    async def _execute(self, tid: int) -> None:
        t = task_row(tid)
        agent = t["agent"]
        try:
            if agent != "jarvis" and not agents.get(agent):
                set_task(tid, status="failed", error=f"Агента «{agent}» немає")
                return self._child_finished(t)
            instr = agents.instructions(agent, self._context(t))
            prompt = t["brief"] if agent == "jarvis" else f"ЗАДАЧА: {t['title']}\n\n{t['brief']}"
            res, tier, note = await self._call(t, agent, prompt, instr, t["brief"], bool(t["important"]))
            if res is None:
                set_task(tid, status="failed", error=note, finished=db.now())
                audit("system", "budget_block", f"#{tid}: {note}", "warn")
                if agent == "jarvis":
                    post("jarvis", f"⛔ {note} Задачу не запущено. Підніміть ліміт у Налаштуваннях або дочекайтеся завтра.",
                         t["source"], tid)
                return self._child_finished(task_row(tid))
            if res.status == "cancelled" or self.halted:
                set_task(tid, status="stopped", finished=db.now())
                return
            if res.status == "failed":
                raise BrainError(res.error or res.text.strip()[:600] or "Hermes повідомив про помилку")
            text, actions = split_actions(redact(res.text))
            notes = self.apply_actions(actions, agent, task_row(tid))
            set_task(tid, result=text[:20000])
            if agent == "jarvis":
                children = db.one("SELECT COUNT(*) AS n FROM tasks WHERE parent_id=?", (tid,))["n"]
                reply = text or "(порожня відповідь)"
                if notes:
                    reply += "\n\n" + "\n".join("• " + n for n in notes)
                meta = {"model": task_row(tid)["model"], "tier": tier, "cost": task_row(tid)["cost"]}
                if note:
                    meta["note"] = note
                post("jarvis", reply, t["source"], tid, meta)
                set_task(tid, status="delegated" if children else "done", finished=None if children else db.now())
            else:
                if notes:
                    set_task(tid, result=(text + "\n\n" + "\n".join("• " + n for n in notes))[:20000])
                if t["important"]:
                    set_task(tid, status="review")
                    audit("controller", "review_queued", f"#{tid} {agent}: «{t['title']}»")
                else:
                    set_task(tid, status="done", finished=db.now())
                    self._child_finished(task_row(tid))
        except asyncio.CancelledError:
            set_task(tid, status="stopped", finished=db.now())
            raise
        except BrainError as e:
            self._fail(tid, str(e))
        except Exception as e:  # чесно показуємо будь-яку помилку
            audit("system", "task_error", f"#{tid}: {traceback.format_exc()[-1500:]}", "error")
            self._fail(tid, f"Внутрішня помилка: {type(e).__name__}: {e}")

    def _fail(self, tid: int, err: str) -> None:
        t = task_row(tid)
        set_task(tid, status="failed", error=redact(err)[:1000], finished=db.now())
        audit(t["agent"], "task_failed", f"#{tid}: {err}", "error")
        if t["agent"] == "jarvis":
            post("jarvis", f"⚠ Не вдалося виконати задачу #{tid}: {err}", t["source"], tid)
        self._child_finished(task_row(tid))

    async def _review(self, tid: int) -> None:
        t = task_row(tid)
        try:
            instr = agents.instructions("controller")
            prompt = (f"Агент: {t['agent']}\nЗадача: {t['title']}\nОпис: {t['brief'][:3000]}\n\n"
                      f"РЕЗУЛЬТАТ:\n{t['result'][:12000]}")
            res, _tier, note = await self._call(t, "controller", prompt, instr, prompt, important=True)
            if res is None:
                set_task(tid, status="needs_owner", review=f"Перевірку не виконано: {note}", finished=db.now())
                return self._child_finished(task_row(tid))
            if res.status == "cancelled" or self.halted:
                set_task(tid, status="stopped")
                return
            verdict = parse_verdict(res.text)
            review = f"Оцінка {verdict['score']}/10. {verdict['notes']}"
            if verdict["ok"]:
                set_task(tid, status="done", review=review, finished=db.now())
                audit("controller", "review_ok", f"#{tid}: {review}")
            elif t["rework"] < MAX_REWORK:
                set_task(tid, status="queued", review=review, rework=t["rework"] + 1)
                audit("controller", "review_rework", f"#{tid} повернуто на доопрацювання: {review}", "warn")
                return
            else:
                set_task(tid, status="needs_owner", review=review, finished=db.now())
                audit("controller", "review_failed", f"#{tid} не пройшов перевірку після {MAX_REWORK} доопрацювань: {review}", "warn")
            self._child_finished(task_row(tid))
        except asyncio.CancelledError:
            set_task(tid, status="stopped")
            raise
        except BrainError as e:
            set_task(tid, status="needs_owner", review=f"Контролер не зміг перевірити: {e}", finished=db.now())
            self._child_finished(task_row(tid))

    def _child_finished(self, t: dict | None) -> None:
        if not t or not t["parent_id"]:
            return
        parent = task_row(t["parent_id"])
        kids = db.q("SELECT * FROM tasks WHERE parent_id=?", (parent["id"],))
        if any(k["status"] not in TERMINAL for k in kids):
            return
        if parent["status"] in TERMINAL:
            return
        icon = {"done": "✅", "failed": "❌", "stopped": "⏹", "needs_owner": "⚠", "cancelled": "✖"}
        lines = [f"Звіт по задачі #{parent['id']} «{parent['title'][:60]}»:"]
        for k in kids:
            name = (agents.get(k["agent"]) or {"title": k["agent"]})["title"]
            res = (k["result"] or k["error"] or "").strip().replace("\n", " ")
            lines.append(f"{icon.get(k['status'], '•')} {name}: {k['title']} — {res[:400]}"
                         + (f" [Контролер: {k['review'][:200]}]" if k["review"] else ""))
        total = sum(k["cost"] for k in kids) + parent["cost"]
        lines.append(f"Вартість: ${total:.3f}. Подробиці — у розділі «Задачі».")
        if any(k["status"] == "needs_owner" for k in kids):
            lines.append("Деякі результати не пройшли перевірку Контролера — потрібне ваше рішення.")
        set_task(parent["id"], status="done", finished=db.now())
        post("jarvis", "\n".join(lines), parent["source"], parent["id"], {"report": True, "cost": total})

    # ---------- дії агентів ----------
    def apply_actions(self, actions: list[dict], actor: str, task: dict) -> list[str]:
        notes: list[str] = []
        for a in actions:
            typ = str(a.get("type", ""))
            try:
                note = self._apply(typ, a, actor, task)
            except Exception as e:
                note = f"Дію «{typ}» не виконано: {type(e).__name__}: {e}"
                audit(actor, "action_error", note, "error")
            if note:
                notes.append(note)
        return notes

    def _apply(self, typ: str, a: dict, actor: str, task: dict) -> str:
        if typ == "approval":
            act = str(a.get("action", ""))
            v = rules.check(act)
            if v == rules.DENY:
                audit(actor, "denied:" + act, str(a.get("title", "")), "error")
                return f"⛔ Дію «{act}» заборонено правилами"
            aid = rules.request_approval(act if v == rules.CONFIRM else "other", str(a.get("title", act)),
                                         str(a.get("details", "")), {k: v2 for k, v2 in a.items() if k not in ("type",)},
                                         actor, task["id"])
            return f"Запит на підтвердження #{aid}: {a.get('title', act)}"
        verdict, aid = rules.gate(typ, actor, f"#{task['id']}: {str(a.get('title') or a.get('name') or a.get('action') or typ)[:120]}",
                                  json.dumps(a, ensure_ascii=False)[:2000], a, task["id"])
        if verdict == rules.DENY:
            return f"⛔ Дію «{typ}» заборонено правилами"
        if verdict == rules.CONFIRM:
            return f"Дія «{typ}» чекає вашого підтвердження (#{aid})"
        if typ == "delegate":
            ag = str(a.get("agent", ""))
            if ag not in agents.executors():
                return f"Невідомий виконавець «{ag}» — крок пропущено"
            cid = self.add_child(task, ag, str(a.get("title", "Крок")), str(a.get("brief", a.get("title", ""))),
                                 bool(a.get("important")), list(a.get("paths") or []))
            if cid is None:
                return "Забагато кроків в одній задачі — решту пропущено"
            return f"Доручено {(agents.get(ag) or {'title': ag})['title']}: «{a.get('title', '')}» (#{cid})"
        if typ == "idea":
            iid = db.insert("ideas", text=str(a.get("text", ""))[:1000], source=actor, created=db.now())
            bus.publish("ideas", {"id": iid})
            return f"Ідею додано (#{iid})"
        if typ == "project":
            name = str(a.get("name", "")).strip()[:80]
            if not name:
                return ""
            cur = db.one("SELECT id FROM projects WHERE name=?", (name,))
            prog = max(0, min(100, int(a.get("progress", 0) or 0)))
            if cur:
                db.update("projects", cur["id"], progress=prog, notes=str(a.get("notes", ""))[:1000], updated=db.now())
            else:
                db.insert("projects", name=name, area=str(a.get("area", "general"))[:20], progress=prog,
                          notes=str(a.get("notes", ""))[:1000], created=db.now(), updated=db.now())
            bus.publish("projects", {})
            return f"Проєкт «{name}»: {prog}%"
        if typ == "create_agent":
            ok = agents.create(str(a.get("name", "")), str(a.get("title", "")), str(a.get("role", "")))
            bus.publish("agents", {})
            return f"Створено агента «{a.get('title', a.get('name'))}»" if ok else "Агента не створено (ім'я зайняте або некоректне)"
        if typ == "restart_agent":
            ag = str(a.get("agent", ""))
            ok = agents.restart(ag)
            bus.publish("agents", {})
            return f"Агента «{ag}» перезапущено (нова сесія)" if ok else f"Агента «{ag}» не знайдено"
        if typ in ("node_job",):
            from . import node_hub

            return node_hub.enqueue_from_agent(a, actor, task["id"])
        if typ in ("art_request", "card"):
            from . import game

            return game.apply_action(typ, a, actor, task["id"])
        if typ == "trade_demo":
            from . import trading

            return trading.agent_trade(a, actor)
        return ""

    # ---------- «Стоп» ----------
    async def stop_all(self, actor: str = "owner", why: str = "") -> dict:
        db.set_setting("halted", True)
        n_runs = await self.brain.stop_all()
        n_tasks = len(self.running)
        for t in list(self.running.values()):
            t.cancel()
        await asyncio.sleep(0)
        db.run("UPDATE tasks SET status='stopped', updated=? WHERE status IN ('running','review_running')", (db.now(),))
        db.run("DELETE FROM locks")
        stopped_jobs = db.run("UPDATE node_jobs SET status='stopped', updated=? WHERE status IN ('queued','sent')", (db.now(),))
        try:
            from . import trading

            trading.set_enabled(False, actor)
        except ImportError:
            pass
        audit(actor, "STOP", f"Усіх агентів зупинено. {why} Задач перервано: {n_tasks}, запусків Hermes: {n_runs}, задач ПК: {stopped_jobs}", "error")
        bus.publish("halted", {"halted": True})
        from . import telegram

        telegram.send_owner(f"⏹ СТОП: усі агенти зупинені ({why or actor}). Продовжити — /resume або кнопка в панелі.")
        return {"halted": True, "tasks": n_tasks, "runs": n_runs, "node_jobs": stopped_jobs}

    def resume(self, actor: str = "owner") -> None:
        db.set_setting("halted", False)
        audit(actor, "RESUME", "Роботу агентів відновлено (зупинені задачі можна перезапустити вручну)", "warn")
        bus.publish("halted", {"halted": False})
        self.poke()

    def retry(self, tid: int) -> bool:
        t = task_row(tid)
        if not t or t["status"] not in ("failed", "stopped", "needs_owner", "cancelled"):
            return False
        set_task(tid, status="queued", error="", finished=None)
        if t["parent_id"]:
            p = task_row(t["parent_id"])
            if p and p["status"] == "done":
                set_task(p["id"], status="delegated")
        audit("owner", "task_retry", f"#{tid}")
        self.poke()
        return True

    def cancel(self, tid: int) -> bool:
        t = task_row(tid)
        if not t or t["status"] in TERMINAL:
            return False
        run = self.running.get(tid)
        if run:
            run.cancel()
        set_task(tid, status="cancelled", finished=db.now())
        db.run("DELETE FROM locks WHERE task_id=?", (tid,))
        audit("owner", "task_cancel", f"#{tid}")
        self._child_finished(task_row(tid))
        return True

    # ---------- рішення власника ----------
    def on_decision(self, ap: dict) -> str:
        """Виконує схвалену дію або повідомляє агента про відмову."""
        p = ap.get("payload") or {}
        act = ap["action"]
        if ap["status"] != "approved":
            if ap.get("task_id"):
                post("jarvis", f"Запит #{ap['id']} «{ap['title']}» відхилено власником. {ap.get('note') or ''}".strip(),
                     "panel", ap["task_id"])
            if act == "cloud_fallback":
                from . import node_hub

                node_hub.cloud_declined(p)
            return "відхилено"
        if act == "cloud_fallback":
            from . import node_hub

            asyncio.create_task(node_hub.run_cloud(p.get("job_id")))
            return "запускаю через платний API"
        if act == "risk_limits":
            from . import trading

            return trading.apply_limits(p.get("limits") or {}, "owner")
        if act == "real_trade":
            from . import trading

            return trading.real_trade(p)
        if act == "node_new_action":
            from . import node_hub

            return node_hub.enqueue_approved(p, ap.get("task_id"))
        if act == "spend" and "daily_budget_usd" in p:
            v = float(p["daily_budget_usd"])
            if 0 < v <= 100:
                db.set_setting("daily_budget_usd", v)
                audit("owner", "budget_changed", f"Денний ліміт ${v:.2f} (схвалено запит #{ap['id']})", "warn")
                return f"денний ліміт ${v:.2f}"
        if act == "delete":
            return self._delete(p)
        # publish / main_branch / server / spend та інше: повідомляємо агента, що можна виконувати
        req = ap.get("requested_by") or "jarvis"
        if req in agents.executors() or req == "jarvis":
            parent = task_row(ap["task_id"]) if ap.get("task_id") else None
            brief = (f"Власник ПІДТВЕРДИВ запит #{ap['id']}: {ap['title']}\n{ap['details']}\n"
                     f"Виконай саме цю дію і звітуй. Нічого понад підтверджене.")
            if req == "jarvis" or not parent:
                self.submit_internal(brief)
            else:
                self.add_child(parent, req, f"Підтверджено: {ap['title']}", brief, True, [])
                if parent["status"] == "done":
                    set_task(parent["id"], status="delegated")
            self.poke()
        return "агента повідомлено"

    def submit_internal(self, text: str) -> int:
        tid = db.insert("tasks", agent="jarvis", title=text[:90], brief=text, source="system",
                        created=db.now(), updated=db.now())
        self.poke()
        return tid

    def _delete(self, p: dict) -> str:
        what, ident = p.get("what"), p.get("id") or p.get("name")
        if what == "project":
            db.run("DELETE FROM projects WHERE id=? OR name=?", (ident, ident))
        elif what == "idea":
            db.run("DELETE FROM ideas WHERE id=?", (ident,))
        elif what == "agent":
            r = db.one("SELECT kind FROM agents WHERE name=?", (ident,))
            if not r or r["kind"] == "base":
                return "базових агентів не видаляємо"
            db.run("UPDATE agents SET enabled=0 WHERE name=?", (ident,))
        else:
            return "видалення файлів виконує агент після підтвердження"
        audit("owner", "deleted", f"{what} {ident}", "warn")
        bus.publish(f"{what}s", {})
        return f"видалено {what} {ident}"


def parse_verdict(text: str) -> dict:
    m = re.search(r"\{.*\}", text or "", re.S)
    try:
        d = json.loads(m.group(0)) if m else {}
    except ValueError:
        d = {}
    ok = d.get("ok")
    if ok is None:
        ok = not re.search(r"\b(ні|false|не пройшло|помилк)", text or "", re.I)
    try:
        score = int(d.get("score", 7 if ok else 3))
    except (TypeError, ValueError):
        score = 7 if ok else 3
    return {"ok": bool(ok), "score": max(0, min(10, score)), "notes": str(d.get("notes") or text or "")[:1000]}
