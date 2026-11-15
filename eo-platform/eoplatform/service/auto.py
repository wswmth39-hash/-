"""AUTO MODE: scan every enabled market with LIVE genuine data, every allowed duration,
right after each analysis candle closes; rank only VALIDATED BUY/SELL decisions by their
conservative expected return; trade the single best one (paper) or abstain, and
explain why.

Ranking metric (per unit staked, using the 95% lower bound of held-out accuracy):
    edge_lb = wilson_lb * (1 + payout) - 1
A shape-only setup (unvalidated, weak, stale, frozen, news-blocked) never qualifies.

Timing: features are computed on CLOSED candles, so the freshest — and therefore best
— moment to act on a candle is immediately after it closes. The scanner wakes at
each 5-second boundary (+0.4 s for the last ticks to arrive) and only evaluates the
durations whose analysis candle has just closed.
"""
from __future__ import annotations

import asyncio
import logging
import time

from ..config import ANALYSIS_PERIOD
from ..engine.fast import analyze
from ..learning import evaluator
from ..markets import list_markets

log = logging.getLogger("eo.auto")


COLLECT_S = 0.15   # wait for the other symbols' bars of the same second (tuned from measured spread)


class AutoScanner:
    def __init__(self, core):
        self.core = core
        self.board: dict = {"at": None, "rows": [], "chosen": None, "why": "لم يبدأ المسح بعد"}
        self._loop = None
        self._pending: dict[int, dict] = {}   # candle-end second -> bucket
        self._tasks: set = set()

    # ------------------------------------------------------------------ event path
    def _due(self, end: int, cfg: dict) -> list[int]:
        return [d for d in cfg["durations"] if end % ANALYSIS_PERIOD[d] == 0]

    def on_bar(self, market: str, source: str, bar_ts: int, rx: float) -> None:
        """Hub listener (event loop). Each market is analysed the moment ITS bar arrives; the
        cross-market ranking runs as soon as every live market has reported (or at the deadline)."""
        if self._loop is None or self._loop.is_closed():
            return
        end = int(bar_ts) + 1
        cfg = self.core.execution.config()
        if not self._due(end, cfg):
            return                       # no analysis candle closes at this second
        b = self._pending.get(end)
        if b is None:
            live = {m["id"] for m in list_markets(self.core.db, enabled_only=True)
                    if (not cfg["markets"] or m["id"] in cfg["markets"])
                    and self.core.hub.best_source(m)[1] in ("LIVE", "DELAYED")}   # DELAYED may report any moment
            b = self._pending[end] = {"rows": [], "done": set(), "started": set(), "expected": live,
                                      "first_rx": rx, "ranked": False, "cfg": cfg}
            self._loop.call_later(COLLECT_S, lambda e=end: self._spawn(self._rank(e)))
        if market in b["started"]:
            return
        b["started"].add(market)
        self._spawn(self._handle(end, market, rx))

    def _spawn(self, coro) -> None:
        if self._loop is None:              # stopped: drop the event cleanly
            coro.close()
            return
        t = self._loop.create_task(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)

    async def _handle(self, end: int, market: str, rx: float) -> None:
        b = self._pending.get(end)
        if b is None:
            return
        pairs = [(market, d) for d in self._due(end, b["cfg"])]
        try:
            rows = await asyncio.get_running_loop().run_in_executor(
                self.core.signal_pool, self._analyze_pairs, pairs, time.time(), b["cfg"])
        except Exception:
            log.exception("analysis failed for %s", market)
            rows = []
        self.core.metrics.observe("data_to_signal_ms", (time.time() - rx) * 1000)
        b["rows"].extend(rows)
        b["done"].add(market)
        if b["expected"] and b["expected"] <= b["done"]:
            await self._rank(end)

    async def _rank(self, end: int) -> None:
        b = self._pending.get(end)
        if b is None or b["ranked"]:
            return
        b["ranked"] = True
        self._pending.pop(end, None)
        cfg = b["cfg"]
        try:
            await asyncio.get_running_loop().run_in_executor(
                self.core.pool, self._choose, b["rows"], time.time(), cfg, cfg["auto_enabled"], None)
        except Exception:
            log.exception("ranking failed")
        now = time.time()
        self.core.metrics.observe("auto_decision_ms", (now - b["first_rx"]) * 1000)
        self.core.metrics.observe("candle_close_to_decision_ms", (now - end) * 1000)

    # ------------------------------------------------------------------ clock path (tests / fallback)
    def scan_once(self, now: float | None = None) -> dict:
        now = now or time.time()
        cfg = self.core.execution.config()
        sec = int(now)
        pairs = [(m["id"], d) for m in list_markets(self.core.db, enabled_only=True) for d in cfg["durations"]
                 if sec % ANALYSIS_PERIOD[d] <= 1]
        t = time.perf_counter()
        rows = self._analyze_pairs(pairs, now, cfg)
        return self._choose(rows, now, cfg, True, t)

    def _analyze_pairs(self, pairs: list, now: float, cfg: dict) -> list[dict]:
        c = self.core
        rows = []
        markets = {m["id"]: m for m in list_markets(c.db, enabled_only=True)}
        for mid, d in pairs:
            m = markets.get(mid)
            if m is None or (cfg["markets"] and mid not in cfg["markets"]):
                continue
            src, state = c.hub.best_source(m, now)
            if src is None or state != "LIVE":
                continue
            t0 = time.perf_counter()
            sig = analyze(m, d, c.hub, c.registry, c.s, now=now, news=c.news, perf=getattr(c, "perf", None))
            c.metrics.observe("fast_analysis_ms", (time.perf_counter() - t0) * 1000)
            c.metrics.inc(f"decision_{sig['decision']}")
            if sig.get("signal_class"):
                c.metrics.inc(f"class_{sig['signal_class']}")
            cd = sig.get("confidence_detail") or {}
            lb = cd.get("wilson_lb")
            edge = (lb * (1 + c.s.payout) - 1) if (lb is not None and sig["validated"]) else None
            rows.append({"sig": sig, "edge": edge})
        return rows

    def _choose(self, rows: list, now: float, cfg: dict, execute: bool, t_scan: float | None) -> dict:
        c = self.core
        qualified = [r for r in rows if r["sig"]["decision"] in ("BUY", "SELL") and r["edge"] is not None
                     and r["edge"] > cfg["min_edge"]]
        qualified.sort(key=lambda r: r["edge"], reverse=True)
        board_rows = [{"market": r["sig"]["market"], "market_name_ar": r["sig"]["market_name_ar"],
                       "kind": r["sig"]["kind"], "duration": r["sig"]["duration"], "decision": r["sig"]["decision"],
                       "candidate": r["sig"]["candidate"], "prob": r["sig"]["prob"],
                       "confidence": r["sig"]["confidence"], "edge_lb": r["edge"],
                       "data_source": r["sig"]["data_source"], "why": (r["sig"]["reasons"] or [""])[0]}
                      for r in sorted(rows, key=lambda r: (r["edge"] is None, -(r["edge"] or 0)))]
        result = {"at": now, "rows": board_rows, "evaluated": len(rows), "chosen": None,
                  "auto_enabled": cfg["auto_enabled"]}
        if t_scan is not None:
            result["scan_ms"] = round((time.perf_counter() - t_scan) * 1000, 2)
        if not rows:
            result["why"] = "لا توجد أسواق ببيانات حية الآن، أو لم تُغلق شمعة تحليل في هذه الثانية"
        elif not qualified:
            result["why"] = (f"امتناع: لا توجد فرصة مُتحقق منها من بين {len(rows)} تقييمًا "
                             "(لا نموذج يتجاوز نقطة التعادل بثقة كافية، أو موانع مخاطر)")
        elif not execute:
            best = qualified[0]["sig"]
            result["why"] = (f"أفضل فرصة الآن: {best['market_name_ar']} {best['decision']} {best['duration']} ث "
                             "(وضع AUTO متوقف — لا تنفيذ)")
            result["best"] = {k: best.get(k) for k in ("market", "duration", "decision", "confidence")}
        else:
            best = qualified[0]
            sig = best["sig"]
            sig["id"] = evaluator.record_signal(c.db, sig, "auto")
            sig["auto_choice"] = {
                "edge_lb": best["edge"], "compared": len(rows), "qualified": len(qualified),
                "timing": f"الدخول فور إغلاق شمعة {sig['analysis_period']} ث (المؤشرات محسوبة على شمعة مكتملة)",
                "why": (f"أعلى عائد متوقع متحفظ {best['edge']:+.3f} لكل وحدة من بين {len(qualified)} فرصة مؤهلة "
                        f"و{len(rows)} تقييمًا؛ دقة مُتحققة {sig['confidence']*100:.1f}% "
                        f"(حد أدنى {sig['confidence_detail']['wilson_lb']*100:.1f}%)")}
            ex = c.execution.submit_from_signal(sig, trigger="auto", now=now)
            result.update(chosen={k: sig.get(k) for k in ("id", "market", "market_name_ar", "duration", "decision",
                                                          "confidence", "auto_choice", "data_source")},
                          execution=ex, why=sig["auto_choice"]["why"])
        if rows:
            self.board = result
        return result

    async def run(self) -> None:
        """Event-driven: scans are triggered by hub bar-close events (see on_bar). This loop only
        registers the listener and keeps the service supervised."""
        self._loop = asyncio.get_running_loop()
        if self.on_bar not in self.core.hub.listeners:
            self.core.hub.listeners.append(self.on_bar)
        try:
            while True:
                await asyncio.sleep(3600)
        finally:
            if self.on_bar in self.core.hub.listeners:
                self.core.hub.listeners.remove(self.on_bar)
            self._loop = None
            for t in list(self._tasks):
                t.cancel()
