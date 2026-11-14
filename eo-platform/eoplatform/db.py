"""SQLite persistence (WAL mode). One connection guarded by a lock: the workload is
small writes at ~1/s per market, which SQLite handles comfortably."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Iterable

SCHEMA = """
CREATE TABLE IF NOT EXISTS bars1s (
  market TEXT NOT NULL, source TEXT NOT NULL, ts INTEGER NOT NULL,
  o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, n INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (market, source, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS markets (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, name_ar TEXT, kind TEXT NOT NULL CHECK(kind IN ('regular','otc')),
  category TEXT NOT NULL, reference_symbol TEXT, enabled INTEGER NOT NULL DEFAULT 1,
  catalog_verified INTEGER NOT NULL DEFAULT 0, bridge_asset_id TEXT
);

CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at REAL NOT NULL, market TEXT NOT NULL, kind TEXT NOT NULL, duration INTEGER NOT NULL,
  source TEXT NOT NULL, decision TEXT NOT NULL CHECK(decision IN ('BUY','SELL','WAIT')),
  candidate TEXT CHECK(candidate IN ('BUY','SELL') OR candidate IS NULL),
  prob REAL, confidence REAL, validated INTEGER NOT NULL DEFAULT 0, model_id INTEGER,
  entry_ts INTEGER, entry_price REAL, data_source TEXT, data_age REAL, data_state TEXT, trend TEXT,
  reasons TEXT, payload TEXT,
  status TEXT NOT NULL DEFAULT 'pending', exit_price REAL, resolved_at REAL, void_reason TEXT,
  trigger TEXT NOT NULL DEFAULT 'manual'
);
CREATE INDEX IF NOT EXISTS ix_signals_status ON signals(status, created_at);
CREATE INDEX IF NOT EXISTS ix_signals_mkt ON signals(market, duration, source);

CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT, market TEXT NOT NULL, duration INTEGER NOT NULL,
  created_at REAL NOT NULL, algo TEXT NOT NULL, path TEXT, metrics TEXT,
  status TEXT NOT NULL CHECK(status IN ('candidate','champion','rejected','retired')),
  promoted_at REAL, note TEXT
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, signal_id INTEGER, market TEXT, duration INTEGER,
  started_at REAL NOT NULL, finished_at REAL, llm_used INTEGER NOT NULL DEFAULT 0, llm_model TEXT,
  decision TEXT, transcript TEXT, error TEXT
);

CREATE TABLE IF NOT EXISTS strategy_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at REAL NOT NULL, market TEXT NOT NULL,
  duration INTEGER NOT NULL, strategy TEXT NOT NULL, n INTEGER NOT NULL, wins INTEGER NOT NULL,
  accuracy REAL, wilson_lb REAL, details TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, level TEXT NOT NULL, kind TEXT NOT NULL,
  message TEXT NOT NULL, data TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, pw_hash TEXT NOT NULL,
  created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS bridge_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT UNIQUE NOT NULL, label TEXT,
  created_at REAL NOT NULL, last_used REAL, revoked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


class DB:
    def __init__(self, path: Path | str):
        self.path = str(path)
        self._lock = threading.RLock()
        self.conn = sqlite3.connect(self.path, check_same_thread=False, timeout=30, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        with self._lock:
            self.conn.executescript(SCHEMA)

    # ---------- generic helpers
    def execute(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
        with self._lock:
            return self.conn.execute(sql, tuple(params))

    def executemany(self, sql: str, rows: Iterable[Iterable[Any]]) -> None:
        with self._lock:
            self.conn.execute("BEGIN")
            try:
                self.conn.executemany(sql, rows)
                self.conn.execute("COMMIT")
            except Exception:
                self.conn.execute("ROLLBACK")
                raise

    def all(self, sql: str, params: Iterable[Any] = ()) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self.conn.execute(sql, tuple(params)).fetchall()]

    def one(self, sql: str, params: Iterable[Any] = ()) -> dict | None:
        with self._lock:
            r = self.conn.execute(sql, tuple(params)).fetchone()
            return dict(r) if r else None

    def close(self) -> None:
        with self._lock:
            try:
                self.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            finally:
                self.conn.close()

    # ---------- kv
    def kv_get(self, key: str, default: Any = None) -> Any:
        r = self.one("SELECT value FROM kv WHERE key=?", (key,))
        return json.loads(r["value"]) if r else default

    def kv_set(self, key: str, value: Any) -> None:
        self.execute("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                     (key, json.dumps(value)))

    # ---------- events (persistent, shown in the dashboard)
    def event(self, level: str, kind: str, message: str, data: Any = None) -> None:
        self.execute("INSERT INTO events(ts,level,kind,message,data) VALUES(?,?,?,?,?)",
                     (time.time(), level, kind, message, json.dumps(data, default=str) if data is not None else None))

    # ---------- bars
    def upsert_bars(self, market: str, source: str, bars: list[tuple]) -> None:
        """bars: (ts, o, h, l, c, n). Later data for the same second merges high/low/close."""
        if not bars:
            return
        self.executemany(
            "INSERT INTO bars1s(market,source,ts,o,h,l,c,n) VALUES(?,?,?,?,?,?,?,?) "
            "ON CONFLICT(market,source,ts) DO UPDATE SET h=max(h,excluded.h), l=min(l,excluded.l), "
            "c=excluded.c, n=excluded.n",
            [(market, source, *b) for b in bars])

    def bars(self, market: str, source: str, since: int, until: int | None = None) -> list[tuple]:
        q = "SELECT ts,o,h,l,c,n FROM bars1s WHERE market=? AND source=? AND ts>=?"
        p: list[Any] = [market, source, since]
        if until is not None:
            q += " AND ts<=?"
            p.append(until)
        q += " ORDER BY ts"
        with self._lock:
            return [tuple(r) for r in self.conn.execute(q, p).fetchall()]

    def bar_sources(self, market: str) -> list[dict]:
        return self.all("SELECT source, count(*) n, min(ts) first, max(ts) last FROM bars1s "
                        "WHERE market=? GROUP BY source", (market,))

    def prune(self, retention_days: int) -> int:
        cutoff = int(time.time()) - retention_days * 86400
        cur = self.execute("DELETE FROM bars1s WHERE ts<?", (cutoff,))
        self.execute("DELETE FROM events WHERE ts<?", (cutoff,))
        return cur.rowcount
