"""SQLite-сховище панелі. Одна база в DATA_DIR/jarvis.db (WAL), доступ через блокування."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from typing import Any, Iterable

from .config import settings

SCHEMA = """
CREATE TABLE IF NOT EXISTS owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pw_hash TEXT NOT NULL,
  totp_secret TEXT NOT NULL DEFAULT '',
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  updated REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, created REAL NOT NULL, expires REAL NOT NULL, ip TEXT, ua TEXT
);
CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT NOT NULL, ts REAL NOT NULL, ok INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '', level TEXT NOT NULL DEFAULT 'info'
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'panel', task_id INTEGER, meta TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER, agent TEXT NOT NULL, title TEXT NOT NULL,
  brief TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', source TEXT NOT NULL DEFAULT 'panel',
  tier TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', model_pref TEXT NOT NULL DEFAULT '',
  cost REAL NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
  result TEXT NOT NULL DEFAULT '', review TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
  important INTEGER NOT NULL DEFAULT 0, rework INTEGER NOT NULL DEFAULT 0, paths TEXT NOT NULL DEFAULT '[]',
  run_id TEXT NOT NULL DEFAULT '', created REAL NOT NULL, updated REAL NOT NULL, started REAL, finished REAL
);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
CREATE TABLE IF NOT EXISTS costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, day TEXT NOT NULL, task_id INTEGER,
  agent TEXT NOT NULL, model TEXT NOT NULL, tokens_in INTEGER NOT NULL, tokens_out INTEGER NOT NULL,
  usd REAL NOT NULL, note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS costs_day ON costs(day);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, action TEXT NOT NULL, title TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL DEFAULT '{}', requested_by TEXT NOT NULL,
  task_id INTEGER, status TEXT NOT NULL DEFAULT 'pending', decided REAL, note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS locks (resource TEXT PRIMARY KEY, task_id INTEGER NOT NULL, agent TEXT NOT NULL, ts REAL NOT NULL);
CREATE TABLE IF NOT EXISTS agents (
  name TEXT PRIMARY KEY, title TEXT NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'base',
  generation INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1, created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, area TEXT NOT NULL DEFAULT 'general',
  status TEXT NOT NULL DEFAULT 'active', progress INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '',
  created REAL NOT NULL, updated REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS ideas (
  id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'owner',
  status TEXT NOT NULL DEFAULT 'new', created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, text TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS nodes (
  name TEXT PRIMARY KEY, last_seen REAL NOT NULL, info TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS node_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, action TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued', urgent INTEGER NOT NULL DEFAULT 0, result TEXT NOT NULL DEFAULT '{}',
  error TEXT NOT NULL DEFAULT '', node TEXT NOT NULL DEFAULT '', ref TEXT NOT NULL DEFAULT '',
  created REAL NOT NULL, updated REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS candles (
  tf TEXT NOT NULL, t INTEGER NOT NULL, o REAL, h REAL, l REAL, c REAL, v REAL, PRIMARY KEY (tf, t)
);
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, side TEXT NOT NULL, entry REAL NOT NULL,
  stop REAL NOT NULL, target REAL NOT NULL, reason TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'engine',
  status TEXT NOT NULL DEFAULT 'new'
);
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT, mode TEXT NOT NULL DEFAULT 'demo', side TEXT NOT NULL,
  size REAL NOT NULL, entry REAL NOT NULL, stop REAL NOT NULL, target REAL NOT NULL,
  opened REAL NOT NULL, closed REAL, exit REAL, pnl REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open',
  reason TEXT NOT NULL DEFAULT '', close_reason TEXT NOT NULL DEFAULT '', signal_id INTEGER
);
CREATE TABLE IF NOT EXISTS game_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'owner',
  created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'unit',
  faction TEXT NOT NULL DEFAULT '', rarity TEXT NOT NULL DEFAULT 'common', cost INTEGER NOT NULL DEFAULT 1,
  attack INTEGER NOT NULL DEFAULT 0, health INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL DEFAULT '',
  art_prompt TEXT NOT NULL DEFAULT '', art TEXT NOT NULL DEFAULT '', art_status TEXT NOT NULL DEFAULT 'none',
  created REAL NOT NULL
);
"""

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None


def conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        c = sqlite3.connect(settings.db_path, check_same_thread=False, isolation_level=None)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA busy_timeout=5000")
        c.executescript(SCHEMA)
        _conn = c
    return _conn


def close() -> None:
    global _conn
    with _lock:
        if _conn is not None:
            _conn.close()
            _conn = None


def q(sql: str, args: Iterable[Any] = ()) -> list[dict]:
    with _lock:
        return [dict(r) for r in conn().execute(sql, tuple(args)).fetchall()]


def one(sql: str, args: Iterable[Any] = ()) -> dict | None:
    with _lock:
        r = conn().execute(sql, tuple(args)).fetchone()
        return dict(r) if r else None


def run(sql: str, args: Iterable[Any] = ()) -> int:
    """Виконує запит і повертає lastrowid (для INSERT) або кількість змінених рядків."""
    with _lock:
        cur = conn().execute(sql, tuple(args))
        return cur.lastrowid if sql.lstrip().upper().startswith("INSERT") else cur.rowcount


def insert(table: str, **cols: Any) -> int:
    keys = list(cols)
    vals = [json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v for v in cols.values()]
    return run(f"INSERT INTO {table} ({', '.join(keys)}) VALUES ({', '.join('?' * len(keys))})", vals)


def update(table: str, where_id: int, key: str = "id", **cols: Any) -> None:
    if not cols:
        return
    vals = [json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v for v in cols.values()]
    run(f"UPDATE {table} SET {', '.join(k + '=?' for k in cols)} WHERE {key}=?", [*vals, where_id])


def get_setting(k: str, default: Any = None) -> Any:
    r = one("SELECT v FROM settings WHERE k=?", (k,))
    if not r:
        return default
    try:
        return json.loads(r["v"])
    except ValueError:
        return default


def set_setting(k: str, v: Any) -> None:
    run("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
        (k, json.dumps(v, ensure_ascii=False)))


def now() -> float:
    return time.time()
