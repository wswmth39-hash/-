"""Performance statistics computed only from resolved, genuine outcomes."""
from __future__ import annotations

import json
from collections import defaultdict

from ..db import DB
from ..engine.model import binom_p_greater, wilson_lb


def _summ(rows: list[dict]) -> dict:
    w = sum(1 for r in rows if r["status"] == "win")
    l = sum(1 for r in rows if r["status"] == "loss")
    d = sum(1 for r in rows if r["status"] == "draw")
    n = w + l
    return {"n": n, "wins": w, "losses": l, "draws": d, "accuracy": (w / n) if n else None,
            "wilson_lb": wilson_lb(w, n) if n else None, "p_value_vs_50": binom_p_greater(w, n) if n else None}


def performance(db: DB, breakeven: float, since: float = 0) -> dict:
    rows = db.all("SELECT id,market,kind,duration,source,decision,candidate,status,trend,data_source,confidence,"
                  "created_at,payload FROM signals WHERE status IN ('win','loss','draw') AND created_at>=?", (since,))
    acted = [r for r in rows if r["decision"] != "WAIT"]
    payout = 1 / breakeven - 1

    def ev(summary: dict) -> dict:
        a = summary.get("accuracy")
        lb = summary.get("wilson_lb")
        # expected return per 1 unit staked after payout: win → +payout, loss → −1
        summary["ev_per_unit"] = round(a * payout - (1 - a), 4) if a is not None else None
        summary["ev_per_unit_lb"] = round(lb * payout - (1 - lb), 4) if lb is not None else None
        return summary

    out = {"breakeven": breakeven, "payout": payout, "overall_signals": ev(_summ(acted)), "overall_candidates": _summ(rows),
           "by_market_duration": [], "by_source": [], "void": db.one(
               "SELECT count(*) n FROM signals WHERE status='void' AND created_at>=?", (since,))["n"],
           "pending": db.one("SELECT count(*) n FROM signals WHERE status='pending'")["n"]}
    groups = defaultdict(list)
    for r in rows:
        groups[(r["market"], r["duration"], r["source"])].append(r)
    for (m, d, src), rs in sorted(groups.items()):
        a = [r for r in rs if r["decision"] != "WAIT"]
        out["by_market_duration"].append({"market": m, "duration": d, "engine": src,
                                          "signals": ev(_summ(a)), "candidates": ev(_summ(rs))})
    sg = defaultdict(list)
    for r in rows:
        sg[r["source"]].append(r)
    out["by_source"] = [{"engine": k, "signals": _summ([r for r in v if r["decision"] != "WAIT"]),
                         "candidates": _summ(v)} for k, v in sorted(sg.items())]
    out["failure_patterns"] = failure_patterns(rows)
    out["by_quality"], out["by_class"], out["by_regime"] = _by_payload(rows, min_n=30)
    return out


def _by_payload(rows: list[dict], min_n: int) -> tuple[list, list, list]:
    """Outcome accuracy by quality bucket / signal class / regime. A group is 'verified' only
    with >= min_n resolved outcomes; smaller groups are flagged experimental."""
    q, c, r = defaultdict(list), defaultdict(list), defaultdict(list)
    for row in rows:
        try:
            p = json.loads(row["payload"] or "{}")
        except ValueError:
            continue
        if p.get("quality_score") is not None:
            b = int(p["quality_score"]) // 20 * 20
            q[f"{b}-{b + 19}"].append(row)
        if p.get("signal_class"):
            c[p["signal_class"]].append(row)
        if p.get("regime"):
            r[p["regime"]].append(row)

    def table(d):
        out = []
        for k, rs in sorted(d.items()):
            s = _summ(rs)
            out.append({"group": k, **s, "verified": s["n"] >= min_n})
        return out
    return table(q), table(c), table(r)


def failure_patterns(rows: list[dict], min_n: int = 30) -> list[dict]:
    """Conditions under which candidate accuracy is clearly worse than overall."""
    if not rows:
        return []
    base = _summ(rows)
    if not base["n"]:
        return []
    buckets = defaultdict(list)
    for r in rows:
        buckets[("الاتجاه", r["trend"] or "?")].append(r)
        buckets[("المصدر", r["data_source"] or "?")].append(r)
        try:
            ev = (json.loads(r["payload"] or "{}").get("evidence") or {})
        except ValueError:
            ev = {}
        d = 1 if r["candidate"] == "BUY" else -1
        for k, e in ev.items():
            agree = "يوافق" if e.get("score", 0) * d > 0.05 else "يعارض" if e.get("score", 0) * d < -0.05 else "محايد"
            buckets[(e.get("name_ar", k), agree)].append(r)
    out = []
    for (dim, val), rs in buckets.items():
        s = _summ(rs)
        if s["n"] >= min_n and s["accuracy"] is not None and s["accuracy"] < base["accuracy"] - 0.03:
            out.append({"dimension": dim, "value": val, **s, "baseline": base["accuracy"]})
    return sorted(out, key=lambda x: x["accuracy"])[:20]


class PerfCache:
    """Live outcome statistics by market × duration (× regime) for decision explanations.
    Recomputed at most every ``ttl`` seconds with one query, so the fast path stays fast."""

    def __init__(self, db: DB, ttl: float = 60.0, min_n: int = 30):
        self.db, self.ttl, self.min_n = db, ttl, min_n
        self._at, self._data = 0.0, {}

    def _refresh(self) -> None:
        import time as _t
        rows = self.db.all("SELECT market, duration, source, decision, status, payload FROM signals "
                           "WHERE status IN ('win','loss') AND created_at > ?", (_t.time() - 30 * 86400,))
        groups = defaultdict(list)
        for r in rows:
            try:
                reg = json.loads(r["payload"] or "{}").get("regime")
            except ValueError:
                reg = None
            acted = r["decision"] != "WAIT"
            for key in ((r["market"], r["duration"], r["source"], None, acted), (r["market"], r["duration"], r["source"], reg, acted)):
                groups[key].append(r)
        self._data = {k: _summ(v) for k, v in groups.items()}
        self._at = _t.time()

    def get(self, market: str, duration: int, regime: str | None, source: str = "fast") -> dict:
        import time as _t
        if _t.time() - self._at > self.ttl:
            self._refresh()

        def pack(key):
            s_ = self._data.get(key)
            if not s_ or not s_["n"]:
                return {"n": 0, "verified": False}
            return {**s_, "verified": s_["n"] >= self.min_n}
        return {"published_signals": pack((market, duration, source, None, True)),
                "published_signals_this_regime": pack((market, duration, source, regime, True)),
                "all_candidates": pack((market, duration, source, None, False)),
                "all_candidates_this_regime": pack((market, duration, source, regime, False))}
