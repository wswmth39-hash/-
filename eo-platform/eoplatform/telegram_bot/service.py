"""Telegram ↔ existing platform bridge (no separate engine).

Analysis = the platform's own fast engine (``Core.analyze_fast``) run for every supported
duration on the dedicated signal lane, then the SAME ranking rule as the AUTO scanner:
only validated BUY/SELL decisions qualify, ranked by the conservative expected return
``lb × (1 + payout) − 1``. If none qualifies the answer is WAIT — never a forced direction.

Safety for concurrent users: global concurrency cap, per-user rate limit, duplicate-request
protection (identical in-flight requests share one analysis; repeats within a short window
return the cached result), and a hard timeout so an unavailable engine yields a clear error.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from collections import defaultdict, deque

from ..config import DURATIONS
from ..markets import allowed_sources, get_market, list_markets

log = logging.getLogger("eo.telegram")

# After a (re)start the Binance provider first backfills 24 h of history (~1 min on a fresh
# install). Inside this window a market whose live provider is enabled but not yet delivering
# is shown as "loading", not "unavailable". Markets with no enabled provider (e.g. OTC while
# the bridge is disabled) are never "loading": they stay "unavailable".
STARTUP_GRACE_S = 120.0

SCHEMA = """
CREATE TABLE IF NOT EXISTS telegram_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at REAL NOT NULL, user_hash TEXT NOT NULL, market TEXT NOT NULL,
  decision TEXT, horizon INTEGER, signal_ids TEXT, status TEXT NOT NULL, latency_ms REAL
);
CREATE INDEX IF NOT EXISTS ix_tg_user ON telegram_requests(user_hash, id);
"""


class RateLimited(Exception):
    pass


class EngineUnavailable(Exception):
    pass


def user_hash(user_id: int, secret: str) -> str:
    """Users are stored as salted hashes, never as raw Telegram IDs."""
    return hashlib.sha256(f"{secret}:{user_id}".encode()).hexdigest()[:24]


class TelegramService:
    def __init__(self, core, per_minute: int = 6, dedupe_s: float = 20.0, max_concurrent: int = 4,
                 timeout_s: float = 10.0):
        self.core = core
        with core.db._lock:
            core.db.conn.executescript(SCHEMA)
        self.per_minute, self.dedupe_s, self.timeout_s = per_minute, dedupe_s, timeout_s
        self._sem = asyncio.Semaphore(max_concurrent)
        self._hits: dict[str, deque] = defaultdict(deque)
        self._inflight: dict[tuple, asyncio.Future] = {}
        self._recent: dict[tuple, tuple[float, dict]] = {}

    # ------------------------------------------------------------------ markets
    def markets(self, kind: str | None = None, query: str | None = None) -> list[dict]:
        out = []
        q = (query or "").strip().lower().replace("/", "").replace(" ", "")
        for m in list_markets(self.core.db, enabled_only=True):
            if kind and m["kind"] != kind:
                continue
            if q and not any(q in str(x).lower().replace("/", "").replace(" ", "")
                             for x in (m["id"], m["name"], m["name_ar"])):
                continue
            src, state = self.core.hub.best_source(m)
            if state != "LIVE" and self.data_loading(m):
                state = "LOADING"
            out.append({**m, "source": src, "state": state})
        # markets with live data first, then those still loading after startup, then alphabetical
        rank = {"LIVE": 0, "LOADING": 1}
        return sorted(out, key=lambda x: (rank.get(x["state"], 2), x["source"] is None, x["kind"], x["name"]))

    def uptime(self) -> float:
        return max(0.0, time.time() - self.core.started)

    def _live_sources(self) -> set[str]:
        """Sources this process is actually configured to receive live data from."""
        out = set()
        if self.core.s.enable_binance:
            out.add("binance")
        if self.core.s.bridge_enabled:
            out.add("expertoption")
        return out

    def data_loading(self, m: dict) -> bool:
        """True only during the startup window AND when an enabled live provider may back the market."""
        if self.uptime() >= STARTUP_GRACE_S:
            return False
        return bool(self._live_sources() & set(allowed_sources(m)))

    # ------------------------------------------------------------------ limits
    def _check_rate(self, uh: str) -> None:
        now = time.time()
        q = self._hits[uh]
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= self.per_minute:
            raise RateLimited(int(60 - (now - q[0])) + 1)
        q.append(now)

    # ------------------------------------------------------------------ analysis
    async def analyze(self, user_id: int, market_id: str) -> dict:
        uh = user_hash(user_id, self.core.s.session_secret)
        m = get_market(self.core.db, market_id)
        if m is None or not m["enabled"]:
            raise KeyError(market_id)
        key = (uh, market_id)
        cached = self._recent.get(key)
        if cached and time.time() - cached[0] < self.dedupe_s:
            return {**cached[1], "duplicate": True}
        if key in self._inflight:                       # same user, same market, already running
            return {**(await asyncio.shield(self._inflight[key])), "duplicate": True}
        self._check_rate(uh)
        fut = asyncio.get_running_loop().create_future()
        self._inflight[key] = fut
        try:
            res = await self._analyze(uh, m)
            self._recent[key] = (time.time(), res)
            fut.set_result(res)
            return res
        except BaseException as e:
            if not fut.done():
                fut.set_exception(e)
            fut.exception()                              # mark retrieved
            raise
        finally:
            self._inflight.pop(key, None)

    async def _analyze(self, uh: str, m: dict) -> dict:
        t0 = time.perf_counter()
        loop = asyncio.get_running_loop()
        async with self._sem:
            try:
                sigs = await asyncio.wait_for(
                    loop.run_in_executor(self.core.signal_pool, self._run_all, m["id"]), self.timeout_s)
            except asyncio.TimeoutError as e:
                self._log(uh, m["id"], None, None, [], "timeout", t0)
                raise EngineUnavailable("analysis timed out") from e
            except Exception as e:
                log.exception("telegram analysis failed")
                self._log(uh, m["id"], None, None, [], "error", t0)
                raise EngineUnavailable(type(e).__name__) from e
        res = self.choose(m, sigs)
        res["latency_ms"] = round((time.perf_counter() - t0) * 1000, 1)
        self._log(uh, m["id"], res["decision"], res["horizon"], [s.get("id") for s in sigs], "ok", t0)
        return res

    def _run_all(self, market_id: str) -> list[dict]:
        return [self.core.analyze_fast(market_id, d, trigger="telegram") for d in DURATIONS]

    def choose(self, m: dict, sigs: list[dict]) -> dict:
        """Delegates to the shared final decision engine (engine/decision.py) and adds the
        Telegram-specific fields (startup loading state) plus legacy keys used by older views."""
        from ..engine.decision import decide
        d = decide(m, sigs, self.core.s.payout_for(m["id"]), self._meta)
        best = next((s for s in sigs if s["duration"] == d["horizon"]), sigs[0])
        conf = None
        if d["confidence"]:
            conf = {"oos_accuracy": d["confidence"]["validated_accuracy"],
                    "oos_trades": d["confidence"]["independent_oos_trades"],
                    "wilson_lb": d["confidence"]["lower_bound_95"],
                    "probability": d["confidence"]["calibrated_probability"]}
        d.update({
            "confidence_v4": d["confidence"], "confidence": conf,
            "reasons": best.get("reasons") or [], "abstain": best.get("abstain_reason"),
            "calibration_note": best.get("probability_note") or d["confidence_note"],
            "evaluated": [{"duration": s["duration"], "decision": s["decision"], "candidate": s.get("candidate"),
                           "validated": bool(s.get("validated"))} for s in sigs],
            "supported_horizons": [s["duration"] for s in sigs
                                   if (s.get("model_status") or {}).get("state") == "validated"],
            # loading never changes the decision (still WAIT); it only explains why data is missing
            "data_loading": d["decision"] == "WAIT" and best.get("data_state") != "LIVE" and self.data_loading(m),
            "uptime_s": round(self.uptime()),
        })
        return d

    def _meta(self, sig: dict) -> dict | None:
        mid = sig.get("model_id")
        if not mid:
            return None
        row = self.core.db.one("SELECT metrics FROM models WHERE id=?", (mid,))
        return json.loads(row["metrics"]) if row else None

    def _log(self, uh, market, decision, horizon, ids, status, t0) -> None:
        self.core.db.execute(
            "INSERT INTO telegram_requests(created_at,user_hash,market,decision,horizon,signal_ids,status,latency_ms) "
            "VALUES(?,?,?,?,?,?,?,?)", (time.time(), uh, market, decision, horizon, json.dumps(ids), status,
                                        round((time.perf_counter() - t0) * 1000, 1)))

    # ------------------------------------------------------------------ history / status
    def history(self, user_id: int, limit: int = 10) -> list[dict]:
        uh = user_hash(user_id, self.core.s.session_secret)
        rows = self.core.db.all("SELECT * FROM telegram_requests WHERE user_hash=? AND status='ok' "
                                "ORDER BY id DESC LIMIT ?", (uh, limit))
        for r in rows:
            r["outcome"] = None
            ids = [i for i in json.loads(r["signal_ids"] or "[]") if i]
            if r["horizon"] and ids:
                s = self.core.db.one(f"SELECT status FROM signals WHERE id IN ({','.join('?' * len(ids))}) "
                                     "AND duration=?", (*ids, r["horizon"]))
                r["outcome"] = s["status"] if s else None
        return rows

    def status(self) -> dict:
        h = self.core.health()
        champs = self.core.db.all("SELECT market, duration FROM models WHERE status='champion'")
        fwd = self.core.db.all("SELECT market, duration, spec, status, n, target_n FROM forward_tests ORDER BY id DESC LIMIT 5")
        return {"providers": h["providers"], "llm": h["llm"], "services": h["services"], "status": h["status"],
                "champions": champs, "forward_tests": fwd,
                "live_markets": [m["id"] for m in self.markets() if m["state"] == "LIVE"],
                "bridge_enabled": self.core.s.bridge_enabled,
                "uptime_s": round(self.uptime()),
                "data_loading": self.uptime() < STARTUP_GRACE_S and bool(self._live_sources())
                and not any(v.get("proven") for v in (h["providers"] or {}).values()),
                "telegram": h.get("telegram") or {}}
