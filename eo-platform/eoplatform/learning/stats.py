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
    out = {"breakeven": breakeven, "overall_signals": _summ(acted), "overall_candidates": _summ(rows),
           "by_market_duration": [], "by_source": [], "void": db.one(
               "SELECT count(*) n FROM signals WHERE status='void' AND created_at>=?", (since,))["n"],
           "pending": db.one("SELECT count(*) n FROM signals WHERE status='pending'")["n"]}
    groups = defaultdict(list)
    for r in rows:
        groups[(r["market"], r["duration"], r["source"])].append(r)
    for (m, d, src), rs in sorted(groups.items()):
        a = [r for r in rs if r["decision"] != "WAIT"]
        out["by_market_duration"].append({"market": m, "duration": d, "engine": src,
                                          "signals": _summ(a), "candidates": _summ(rs)})
    sg = defaultdict(list)
    for r in rows:
        sg[r["source"]].append(r)
    out["by_source"] = [{"engine": k, "signals": _summ([r for r in v if r["decision"] != "WAIT"]),
                         "candidates": _summ(v)} for k, v in sorted(sg.items())]
    out["failure_patterns"] = failure_patterns(rows)
    return out


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
