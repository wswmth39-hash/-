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


class AutoScanner:
    def __init__(self, core):
        self.core = core
        self.board: dict = {"at": None, "rows": [], "chosen": None, "why": "لم يبدأ المسح بعد"}

    def scan_once(self, now: float | None = None) -> dict:
        c = self.core
        now = now or time.time()
        cfg = c.execution.config()
        sec = int(now)
        rows = []
        for m in list_markets(c.db, enabled_only=True):
            if cfg["markets"] and m["id"] not in cfg["markets"]:
                continue
            src, state = c.hub.best_source(m, now)
            if src is None or state != "LIVE":
                continue
            for d in cfg["durations"]:
                P = ANALYSIS_PERIOD[d]
                if sec % P > 1:     # only right after this duration's candle closed
                    continue
                sig = analyze(m, d, c.hub, c.registry, c.s, now=now, news=c.news)
                cd = sig.get("confidence_detail") or {}
                lb = cd.get("wilson_lb")
                edge = (lb * (1 + c.s.payout) - 1) if (lb is not None and sig["validated"]) else None
                rows.append({"sig": sig, "edge": edge})
        qualified = [r for r in rows if r["sig"]["decision"] in ("BUY", "SELL") and r["edge"] is not None
                     and r["edge"] > cfg["min_edge"]]
        qualified.sort(key=lambda r: r["edge"], reverse=True)
        board_rows = [{"market": r["sig"]["market"], "market_name_ar": r["sig"]["market_name_ar"],
                       "kind": r["sig"]["kind"], "duration": r["sig"]["duration"], "decision": r["sig"]["decision"],
                       "candidate": r["sig"]["candidate"], "prob": r["sig"]["prob"],
                       "confidence": r["sig"]["confidence"], "edge_lb": r["edge"],
                       "data_source": r["sig"]["data_source"], "why": (r["sig"]["reasons"] or [""])[0]}
                      for r in sorted(rows, key=lambda r: (r["edge"] is None, -(r["edge"] or 0)))]
        result = {"at": now, "rows": board_rows, "evaluated": len(rows), "chosen": None}
        if not rows:
            result["why"] = "لا توجد أسواق ببيانات حية الآن، أو لم تُغلق شمعة تحليل في هذه الثانية"
        elif not qualified:
            result["why"] = (f"امتناع: لا توجد فرصة مُتحقق منها من بين {len(rows)} تقييمًا "
                             "(لا نموذج يتجاوز نقطة التعادل بثقة كافية، أو موانع مخاطر)")
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
        while True:
            now = time.time()
            await asyncio.sleep(5 - now % 5 + 0.4)  # just after each 5-second candle boundary
            if not self.core.execution.config()["auto_enabled"]:
                self.board = {**self.board, "why": "وضع AUTO متوقف", "at": time.time()}
                continue
            try:
                await asyncio.get_running_loop().run_in_executor(self.core.pool, self.scan_once)
            except Exception:
                log.exception("auto scan failed")
