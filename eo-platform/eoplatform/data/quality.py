"""Per-market data health and availability (V4 phase 2).

Everything here is computed from genuine stored 1-second bars; nothing is generated or filled.

* ``health(hub, market, source)``: last update (data time and receive time, UTC unix seconds),
  age in seconds, freshness state, gaps and duplicates, statistically abnormal price jumps,
  and a single ``usable`` verdict with the reasons it is false.
* ``availability(core, market)``: whether a market can be analysed RIGHT NOW, and if not, why
  (machine code + Arabic text). Drives the "available" vs "unavailable" market lists.

Spike rule (robust, scale-free): a 1-second log return is abnormal when it exceeds
``SPIKE_K`` × the 1-second robust sigma (1.4826 × MAD over the last hour) AND an absolute floor.
For a Gaussian this is a > 12σ event (practically never); fat-tailed crypto data produces real
ones only on genuine shocks or bad prints, and either way analysis should wait.
"""
from __future__ import annotations

import time

import numpy as np

WINDOW_S = 3600            # health window
SPIKE_K = 12.0             # robust sigmas
SPIKE_MIN_ABS = 0.002      # 0.2 % in one second, regardless of sigma
SPIKE_BLOCK_S = 120        # a spike within this many seconds blocks analysis
MAX_GAP_FRACTION = 0.05    # > 5 % missing seconds in the last hour → degraded

REASONS_AR = {
    "ok": "بيانات حقيقية حية",
    "otc_requires_bridge": "أسواق OTC لا تتوفر أسعارها إلا من ExpertOption عبر الجسر، والجسر معطّل "
                           "(شروط ExpertOption البند 6.2)",
    "no_allowed_source": "لا يوجد مصدر بيانات حقيقي مسموح لهذا السوق (لا مصدر مرجعي للفوركس/السلع، والجسر معطّل)",
    "provider_disabled": "مصدر البيانات المرجعي لهذا السوق معطّل في الإعدادات",
    "loading": "البيانات قيد التحميل بعد بدء التشغيل",
    "not_live": "مصدر البيانات متصل لكن آخر تحديث قديم — لا تحليل على بيانات غير حية",
    "no_data_yet": "لم تصل أي بيانات حقيقية لهذا السوق بعد",
    "data_anomaly": "قفزة سعرية غير طبيعية حديثة (حركة عنيفة أو خطأ بيانات) — انتظار حتى تستقر",
    "frozen": "السعر ثابت تمامًا منذ دقيقتين — بيانات مجمدة محتملة",
    "disabled": "السوق معطّل في الإعدادات",
}



def _spikes(close: np.ndarray, ts: np.ndarray) -> tuple[list[int], float | None]:
    """Timestamps of abnormal 1-second moves (consecutive seconds only) and the robust sigma."""
    if len(close) < 120:
        return [], None
    consecutive = np.diff(ts) == 1
    r = np.diff(np.log(close))[consecutive]
    t = ts[1:][consecutive]
    if len(r) < 60:
        return [], None
    med = float(np.median(r))
    sigma = 1.4826 * float(np.median(np.abs(r - med)))
    if sigma <= 0:            # flat series: any move would be "infinite sigma"; rely on the floor only
        sigma = 0.0
    thr = max(SPIKE_K * sigma, SPIKE_MIN_ABS)
    return [int(x) for x in t[np.abs(r - med) > thr]], (sigma or None)


def health(hub, market: str, source: str, now: float | None = None) -> dict:
    now = now or time.time()
    s = hub.series.get((market, source))
    if s is None:
        return {"market": market, "source": source, "exists": False, "usable": False, "reasons": ["no_data_yet"]}
    with hub._lock:
        last_bar = s.bars[-1][0] if s.bars else None
        state = hub._state(s, now)
        last_rx, rejected, frozen = s.last_rx, dict(s.rejected), hub.quality.get(market, {}).get(f"frozen_{source}")
        # cache lives on the series object itself (a key by market name could be shared by two hubs)
        stamp = (last_bar, len(s.bars))
        cached = getattr(s, "_health_cache", None)
        if cached and cached[0] == stamp:
            core = cached[1]
        else:
            tail = np.asarray([b[:5] for b in list(s.bars)[-WINDOW_S:]], dtype=float) if s.bars else np.zeros((0, 5))
            core = _window_stats(tail, last_bar)
            s._health_cache = (stamp, core)
    age = round(now - last_rx, 2) if last_rx else None
    reasons = []
    if state != "LIVE":
        reasons.append("not_live" if last_rx else "no_data_yet")
    if frozen:
        reasons.append("frozen")
    recent = [t for t in core["spike_ts"] if last_bar is not None and last_bar - t <= SPIKE_BLOCK_S]
    if recent:
        reasons.append("data_anomaly")
    return {"market": market, "source": source, "exists": True, "state": state, "age_s": age,
            "last_bar_ts": last_bar, "last_bar_utc": _utc(last_bar), "last_received_utc": _utc(last_rx),
            "gaps_last_hour": core["missing"], "gap_fraction": core["gap_fraction"],
            "longest_gap_s": core["longest_gap"], "duplicates_rejected": rejected.get("duplicate", 0),
            "rejected": rejected, "spikes_last_hour": len(core["spike_ts"]), "recent_spike": bool(recent),
            "robust_sigma_1s": core["sigma"], "frozen": bool(frozen),
            "degraded": core["gap_fraction"] is not None and core["gap_fraction"] > MAX_GAP_FRACTION,
            "usable": not reasons, "reasons": reasons}


def _window_stats(tail: np.ndarray, last_bar) -> dict:
    if len(tail) == 0:
        return {"missing": None, "gap_fraction": None, "longest_gap": None, "spike_ts": [], "sigma": None}
    ts = tail[:, 0].astype(np.int64)
    span = int(ts[-1] - ts[0]) + 1
    missing = span - len(ts)
    d = np.diff(ts)
    spike_ts, sigma = _spikes(tail[:, 4], ts)
    return {"missing": int(missing), "gap_fraction": round(missing / span, 4) if span else None,
            "longest_gap": int(d.max() - 1) if len(d) and d.max() > 1 else 0, "spike_ts": spike_ts,
            "sigma": round(sigma, 8) if sigma else None}


def _utc(ts) -> str | None:
    return time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(ts)) if ts else None


def availability(core, market: dict, now: float | None = None) -> dict:
    """Can this market be analysed right now? Never True without fresh genuine data."""
    from ..markets import allowed_sources
    now = now or time.time()
    base = {"market": market["id"], "name": market["name"], "name_ar": market.get("name_ar"),
            "kind": market["kind"], "category": market.get("category")}
    if not market.get("enabled", 1):
        return {**base, "available": False, "code": "disabled", "reason_ar": REASONS_AR["disabled"]}
    srcs = allowed_sources(market)
    # genuine fresh data from an ALLOWED source is what makes a market available; settings only
    # explain why data is missing
    for src in srcs:
        h = health(core.hub, market["id"], src, now)
        if h.get("usable"):
            return {**base, "available": True, "code": "ok", "reason_ar": REASONS_AR["ok"], "source": src,
                    "health": h}
    configured = [s for s in srcs if (s == "expertoption" and core.s.bridge_enabled)
                  or (s == "binance" and core.s.enable_binance)]
    if not configured:
        code = ("otc_requires_bridge" if market["kind"] == "otc"
                else "provider_disabled" if "binance" in srcs else "no_allowed_source")
        return {**base, "available": False, "code": code, "reason_ar": REASONS_AR[code], "sources": srcs}
    best = None
    for src in configured:
        best = best or health(core.hub, market["id"], src, now)
    code = best["reasons"][0] if best and best.get("reasons") else "no_data_yet"
    if code in ("not_live", "no_data_yet") and now - core.started < 120:
        code = "loading"
    return {**base, "available": False, "code": code, "reason_ar": REASONS_AR[code], "source": best.get("source"),
            "health": best}


def split_markets(core, markets: list[dict], now: float | None = None) -> tuple[list[dict], list[dict]]:
    rows = [availability(core, m, now) for m in markets]
    return [r for r in rows if r["available"]], [r for r in rows if not r["available"]]
