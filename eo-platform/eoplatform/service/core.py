"""Application core: wires data, engines, agents and learning together, and runs
the background services under a supervisor that restarts crashed tasks."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import resource
import shutil
import time
from concurrent.futures import ThreadPoolExecutor

from ..agents.graph import AgentSystem
from ..agents.llm import LocalLLM
from ..config import DURATIONS, Settings
from ..data.hub import DataHub
from ..data.providers.binance import BinanceProvider
from ..data.providers.news import NewsCalendar
from ..execution.engine import ExecutionEngine
from .alerts import Alerter
from ..db import DB
from ..engine.fast import analyze
from ..engine.model import Registry, binom_p_greater, wilson_lb
from ..learning import evaluator, trainer
from ..markets import ensure_catalog, get_market, list_markets

log = logging.getLogger("eo.core")

DEFAULT_MONITOR = {"enabled": False, "markets": [], "durations": [60], "interval": 15, "agents": False}


class Supervisor:
    """Runs named coroutines forever; restarts them with backoff when they crash."""

    def __init__(self, db: DB, alert=None):
        self.db = db
        self.alert = alert
        self.tasks: dict[str, asyncio.Task] = {}
        self.status: dict[str, dict] = {}
        self.stop = asyncio.Event()

    def spawn(self, name: str, factory) -> None:
        self.status[name] = {"state": "starting", "restarts": 0, "last_error": None, "since": time.time()}
        self.tasks[name] = asyncio.create_task(self._guard(name, factory), name=name)

    async def _guard(self, name: str, factory) -> None:
        delay = 1.0
        while not self.stop.is_set():
            st = self.status[name]
            st.update(state="running", since=time.time())
            try:
                await factory()
                if self.stop.is_set():
                    break
                raise RuntimeError("task exited unexpectedly")
            except asyncio.CancelledError:
                break
            except Exception as e:
                st.update(state="restarting", last_error=f"{type(e).__name__}: {e}"[:300])
                st["restarts"] += 1
                log.exception("service %s crashed; restarting in %.0fs", name, delay)
                self.db.event("error", "service", f"توقفت الخدمة {name} وستُعاد: {e}"[:300])
                if self.alert:
                    self.alert("alert", "service", f"توقفت الخدمة {name} وأُعيد تشغيلها تلقائيًا")
                try:
                    await asyncio.wait_for(self.stop.wait(), timeout=delay)
                except asyncio.TimeoutError:
                    pass
                delay = min(delay * 2, 60)
        self.status[name]["state"] = "stopped"

    async def shutdown(self, timeout: float = 10) -> None:
        self.stop.set()
        for t in self.tasks.values():
            t.cancel()
        await asyncio.wait(list(self.tasks.values()), timeout=timeout)


class Core:
    def __init__(self, settings: Settings):
        self.s = settings
        self.db = DB(settings.db_path)
        ensure_catalog(self.db)
        self.hub = DataHub(self.db, settings.live_max_age, settings.delayed_max_age, settings.stale_max_age)
        self.registry = Registry(self.db, settings.model_dir)
        self.llm = LocalLLM(settings)
        self.agents = AgentSystem(self.llm, settings.llm_debate_rounds, settings.llm_risk_rounds)
        self.pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="eo")
        # Dedicated signal lane: real-time analysis never queues behind training, agents or DB jobs,
        # and runs serially (no GIL contention between concurrent analyses — measured 12.4→ ms p50).
        self.signal_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="eo-signal")
        self.agent_lock = asyncio.Semaphore(1)  # one LLM team at a time: protects CPU/RAM
        self.sup: Supervisor | None = None
        self.started = time.time()
        self.agent_activity: list[dict] = []
        self.binance: BinanceProvider | None = None
        self._bg: set[asyncio.Task] = set()  # keep references so background runs aren't GC'd
        from .metrics import Metrics
        self.metrics = Metrics()
        self.alert = Alerter(self.db, settings.alert_webhook)
        self.news = NewsCalendar(settings.news_url) if settings.news_enabled else None
        self.execution = ExecutionEngine(self.db, self.hub, settings, self.alert)
        from .auto import AutoScanner
        self.auto = AutoScanner(self)
        self._down_since: dict[str, float] = {}
        self._last_auto_sig: dict[tuple, int] = {}
        # Agent runs that were in progress when the process stopped can never finish: say so.
        self.db.execute("UPDATE agent_runs SET finished_at=?, error=? WHERE finished_at IS NULL",
                        (time.time(), "انقطع: أُعيد تشغيل الخادم أثناء التشغيل"))

    # ------------------------------------------------------------------ settings
    def monitor_cfg(self) -> dict:
        return {**DEFAULT_MONITOR, **(self.db.kv_get("monitor", {}) or {})}

    def set_monitor_cfg(self, cfg: dict) -> dict:
        cur = self.monitor_cfg()
        valid_ids = {m["id"] for m in list_markets(self.db)}
        if "markets" in cfg:
            cur["markets"] = [m for m in cfg["markets"] if m in valid_ids][:20]
        if "durations" in cfg:
            cur["durations"] = [int(d) for d in cfg["durations"] if int(d) in DURATIONS]
        if "interval" in cfg:
            cur["interval"] = max(5, min(600, int(cfg["interval"])))
        for k in ("enabled", "agents"):
            if k in cfg:
                cur[k] = bool(cfg[k])
        self.db.kv_set("monitor", cur)
        self.db.event("info", "monitor", "تم تحديث إعدادات المراقبة التلقائية", cur)
        return cur

    # ------------------------------------------------------------------ analysis
    def record_for(self, market: str, duration: int, source: str) -> dict:
        rows = self.db.all("SELECT status FROM signals WHERE market=? AND duration=? AND source=? AND decision!='WAIT' "
                           "AND status IN ('win','loss') ORDER BY created_at DESC LIMIT 500", (market, duration, source))
        n = len(rows)
        w = sum(1 for r in rows if r["status"] == "win")
        return {"n": n, "wins": w, "accuracy": w / n if n else None, "wilson_lb": wilson_lb(w, n) if n else None}

    def _candidate_record(self, market: str, duration: int, source: str) -> dict:
        rows = self.db.all("SELECT status FROM signals WHERE market=? AND duration=? AND source=? "
                           "AND status IN ('win','loss') ORDER BY created_at DESC LIMIT 1000", (market, duration, source))
        n = len(rows)
        w = sum(1 for r in rows if r["status"] == "win")
        return {"n": n, "wins": w, "accuracy": w / n if n else None, "wilson_lb": wilson_lb(w, n) if n else None,
                "p_value": binom_p_greater(w, n) if n else None}

    def analyze_fast(self, market_id: str, duration: int, trigger: str = "manual") -> dict:
        m = get_market(self.db, market_id)
        if m is None:
            raise KeyError(market_id)
        if duration not in DURATIONS:
            raise ValueError("duration must be one of 30, 60, 120, 300")
        t0 = time.perf_counter()
        sig = analyze(m, duration, self.hub, self.registry, self.s, news=self.news)
        self.metrics.observe("fast_analysis_ms", (time.perf_counter() - t0) * 1000)
        # Duplicate prevention for automatic triggers: one recorded signal per market × duration ×
        # source × analysis candle. (Manual requests are always recorded — the user asked.)
        if trigger != "manual" and sig.get("entry_ts"):
            key = (sig["market"], duration, sig["source"], int(sig["entry_ts"]) // sig["analysis_period"])
            prev = self._last_auto_sig.get(key)
            if prev is not None:
                self.metrics.inc("duplicate_signals_suppressed")
                return {**sig, "id": prev, "duplicate_of": prev}
        sig["id"] = evaluator.record_signal(self.db, sig, trigger)
        if trigger != "manual" and sig.get("entry_ts"):
            self._last_auto_sig[key] = sig["id"]
            if len(self._last_auto_sig) > 5000:
                self._last_auto_sig.clear()
        return sig

    async def analyze(self, market_id: str, duration: int, trigger: str = "manual", deep: bool = True) -> dict:
        loop = asyncio.get_running_loop()
        sig = await loop.run_in_executor(self.signal_pool, self.analyze_fast, market_id, duration, trigger)
        if deep and sig.get("evidence"):
            sig["agents_status"] = "queued"
            task = asyncio.create_task(self._run_agents(dict(sig), trigger))
            self._bg.add(task)
            task.add_done_callback(self._bg.discard)
        return sig

    async def _run_agents(self, sig: dict, trigger: str) -> None:
        async with self.agent_lock:
            started = time.time()
            run_id = self.db.execute("INSERT INTO agent_runs(signal_id,market,duration,started_at) VALUES(?,?,?,?)",
                                     (sig["id"], sig["market"], sig["duration"], started)).lastrowid
            self._activity({"run_id": run_id, "signal_id": sig["id"], "market": sig["market"],
                            "duration": sig["duration"], "state": "running", "started_at": started})
            try:
                rec = self.record_for(sig["market"], sig["duration"], "agents")
                out = await asyncio.get_running_loop().run_in_executor(self.pool, self.agents.run, sig, rec)
                final = out["final"]
                cand = final.get("candidate")
                # Same policy as the fast engine: a direction is only published when the
                # agent team has a validated live record for this market and duration.
                crec = self._candidate_record(sig["market"], sig["duration"], "agents")
                # single test: the 95% lower bound of the live record must exceed break-even
                validated = bool(crec["n"] >= self.s.min_validation_samples and crec["wilson_lb"] > self.s.breakeven)
                decision = final["decision"]
                notes = []
                if decision != "WAIT" and not validated and self.s.require_validated_model:
                    notes.append(f"سجل فريق الوكلاء غير مُتحقق منه بعد ({crec['n']} نتيجة) — الاتجاه مرشح فقط")
                    decision = "WAIT"
                agent_sig = {**{k: sig.get(k) for k in ("market", "market_name", "kind", "duration", "data_source",
                                                    "data_state", "data_age", "entry_price", "entry_ts", "trend",
                                                    "evidence", "features")},
                             "timestamp": sig["timestamp"], "source": "agents", "decision": decision,
                             "candidate": cand, "validated": validated,
                             "confidence": crec["accuracy"] if validated else None,
                             "reasons": notes + [final.get("reason", "")] + [r["summary"] for r in out.get("reports", {}).values()],
                             "agents": {"research": out.get("research"), "risk": out.get("risk"), "final": final,
                                        "llm_used": out.get("llm_used"), "elapsed": out.get("elapsed")}}
                agent_sig_id = evaluator.record_signal(self.db, agent_sig, trigger)
                transcript = {k: out.get(k) for k in ("reports", "investment_debate_state", "research",
                                                       "risk_debate_state", "risk", "final", "log")}
                self.db.execute("UPDATE agent_runs SET finished_at=?, llm_used=?, llm_model=?, decision=?, transcript=? "
                                "WHERE id=?", (time.time(), int(out.get("llm_used", False)), out.get("llm_model"),
                                               decision, json.dumps(transcript, ensure_ascii=False, default=str), run_id))
                self._activity({"run_id": run_id, "signal_id": sig["id"], "agent_signal_id": agent_sig_id,
                                "market": sig["market"], "duration": sig["duration"], "state": "done",
                                "decision": decision, "candidate": cand, "llm_used": out.get("llm_used"),
                                "llm_partial": out.get("llm_partial"),
                                "elapsed": out.get("elapsed"), "started_at": started})
            except Exception as e:
                log.exception("agent run failed")
                self.db.execute("UPDATE agent_runs SET finished_at=?, error=? WHERE id=?",
                                (time.time(), f"{type(e).__name__}: {e}"[:500], run_id))
                self._activity({"run_id": run_id, "signal_id": sig["id"], "market": sig["market"], "state": "error",
                                "error": str(e)[:200], "started_at": started})

    def _activity(self, item: dict) -> None:
        self.agent_activity = [a for a in self.agent_activity if a["run_id"] != item["run_id"]]
        self.agent_activity.insert(0, item)
        del self.agent_activity[30:]

    # ------------------------------------------------------------------ services
    async def svc_hub(self) -> None:
        while True:
            self.hub.tick()
            await asyncio.sleep(1)

    async def svc_evaluator(self) -> None:
        while True:
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(self.pool, evaluator.resolve_pending, self.db)
            await loop.run_in_executor(self.pool, self.execution.settle)
            await asyncio.sleep(2)

    async def svc_monitor(self) -> None:
        while True:
            cfg = self.monitor_cfg()
            if cfg["enabled"]:
                for mid in cfg["markets"]:
                    for d in cfg["durations"]:
                        try:
                            await self.analyze(mid, d, trigger="monitor", deep=cfg["agents"])
                        except Exception:
                            log.exception("monitor analysis failed for %s %s", mid, d)
            self.db.kv_set("monitor_heartbeat", time.time())
            await asyncio.sleep(cfg["interval"])

    async def svc_learning(self) -> None:
        await asyncio.sleep(60)
        while True:
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(self.pool, trainer.check_live_degradation, self.db, self.registry, self.s)
            await loop.run_in_executor(self.pool, trainer.retrain_all, self.db, self.registry, self.s)
            await asyncio.sleep(self.s.retrain_interval_min * 60)

    async def svc_maintenance(self) -> None:
        while True:
            removed = self.db.prune(self.s.retention_days)
            if removed:
                log.info("pruned %d old bars", removed)
            self.db.execute("PRAGMA wal_checkpoint(PASSIVE)")
            await asyncio.sleep(3600)

    async def svc_binance(self) -> None:
        mk = [m for m in list_markets(self.db, enabled_only=True) if m["kind"] == "regular" and m["reference_symbol"]]
        self.binance = BinanceProvider(self.hub, mk, self.s.binance_rest, self.s.binance_ws,
                                       backfill_seconds=int(self.s.binance_backfill_hours * 3600))
        await self.binance.run(self.sup.stop)

    async def svc_watchdog(self) -> None:
        while True:
            h = self.health()
            if h["resources"]["disk_free_mb"] < 500:
                self.alert("alert", "resources", "مساحة القرص منخفضة")
            now = time.time()
            for src, st in h["providers"].items():
                if st["proven"]:
                    self._down_since.pop(src, None)
                    continue
                since = self._down_since.setdefault(src, now)
                if now - since > 60:
                    self.alert("alert", "provider", f"مصدر البيانات {src} لا يرسل بيانات حقيقية منذ أكثر من دقيقة")
            log.info("health", extra={"health": {k: h[k] for k in ("status", "resources")}})
            await asyncio.sleep(60)

    async def svc_news(self) -> None:
        while True:
            await asyncio.get_running_loop().run_in_executor(self.pool, self.news.refresh)
            await asyncio.sleep(60)

    async def start(self) -> None:
        self.sup = Supervisor(self.db, self.alert)
        self.sup.spawn("data_hub", self.svc_hub)
        self.sup.spawn("evaluator", self.svc_evaluator)
        self.sup.spawn("monitor", self.svc_monitor)
        self.sup.spawn("learning", self.svc_learning)
        self.sup.spawn("maintenance", self.svc_maintenance)
        self.sup.spawn("watchdog", self.svc_watchdog)
        if self.s.enable_binance:
            self.sup.spawn("binance_feed", self.svc_binance)
        if self.news is not None:
            self.sup.spawn("news_calendar", self.svc_news)
        self.sup.spawn("auto_scanner", self.auto.run)
        self.db.event("info", "service", "بدأ تشغيل المنصة")

    async def stop(self) -> None:
        if self.sup:
            await self.sup.shutdown()
        self.hub.tick()  # flush pending bars
        self.pool.shutdown(wait=True, cancel_futures=True)
        self.signal_pool.shutdown(wait=True, cancel_futures=True)
        self.db.event("info", "service", "إيقاف آمن للمنصة")
        self.db.close()

    # ------------------------------------------------------------------ health
    def health(self) -> dict:
        usage = resource.getrusage(resource.RUSAGE_SELF)
        db_size = sum(os.path.getsize(p) for p in (self.s.db_path, f"{self.s.db_path}-wal") if os.path.exists(p))
        services = self.sup.status if self.sup else {}
        bad = [n for n, st in services.items() if st["state"] != "running"]
        return {
            "status": "ok" if not bad else "degraded", "uptime": round(time.time() - self.started),
            "services": services, "providers": self.hub.provider_view(),
            "news": self.news.status() if self.news else {"ok": False, "error": "disabled"},
            "alerts": self.alert.status(), "quality": self.hub.quality,
            "execution": {**self.execution.state(), "mode": self.execution.config()["mode"],
                          "auto_enabled": self.execution.config()["auto_enabled"]},
            "llm": {k: v for k, v in self.llm.health().items() if k != "models"} | {"model": self.s.llm_model},
            "monitor_heartbeat": self.db.kv_get("monitor_heartbeat"),
            "resources": {"max_rss_mb": round(usage.ru_maxrss / 1024, 1), "db_mb": round(db_size / 2**20, 2),
                          "disk_free_mb": round(shutil.disk_usage(self.s.home).free / 2**20)},
        }
