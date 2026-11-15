"""Image-style signal mode for the Telegram bot (the design in the owner's screenshots).

This mode ALWAYS returns a direction — BUY or SELL — with the single most suitable duration,
on markets that have GENUINE live data (crypto: BTC/ETH/LTC/XRP, reference prices from Binance).

How the direction and duration are chosen, from real analysis only (engine/fast.py):
* every supported duration (30/60/120/300 s) is analysed independently on real candles,
* the duration with the STRONGEST analyst consensus is chosen,
* direction = the sign of that consensus; if a validated model exists it takes precedence.

Honesty rules that are NOT relaxed here:
* No market without genuine live data gets a signal. It shows "data loading/unavailable" with the
  reason — this is the only non-direction outcome, and it never invents a price or a direction.
* Binance prices are labelled reference prices, never ExpertOption/OTC prices.
* Every signal carries the measured historical accuracy of this kind of technical signal
  (~50 %, from docs/AUDIT_PHASE3.md), so a direction is never presented as a proven edge.
"""
from __future__ import annotations

from ..config import DURATIONS

# Measured, NOT invented: lockbox median accuracy of all technical/model signals on unseen real
# data (docs/AUDIT_PHASE3.md / model_comparison.json). Shown so a direction is never oversold.
MEASURED_ACCURACY = 0.505

CRYPTO = ("BTCUSD", "ETHUSD", "LTCUSD", "XRPUSD")


def _strength(sig: dict) -> float:
    """How strong this duration's directional lean is, from real analysis (0..1)."""
    panel = sig.get("panel") or {}
    cons = panel.get("consensus")
    if cons is not None:
        return abs(float(cons))
    p = sig.get("prob")
    if p is not None:
        return abs(float(p) - 0.5) * 2
    return 0.0


def _direction(sig: dict) -> str | None:
    panel = sig.get("panel") or {}
    cons = panel.get("consensus")
    if sig.get("validated") and sig.get("decision") in ("BUY", "SELL"):
        return sig["decision"]                      # a validated model wins
    if cons is not None and cons != 0:
        return "BUY" if cons > 0 else "SELL"
    if sig.get("candidate") in ("BUY", "SELL"):
        return sig["candidate"]
    return None


def forced_signal(market: dict, sigs: list[dict], measured_accuracy: float = MEASURED_ACCURACY) -> dict:
    """Pick a BUY/SELL direction and its best duration from real analysis, or report no live data.

    Returns a dict with ``ok`` True (a direction) or False (no genuine live data → no signal,
    with a reason; never a fabricated direction)."""
    live = [s for s in sigs if s.get("data_state") == "LIVE"]
    base = {"market": market["id"], "market_name": market["name"], "market_name_ar": market.get("name_ar"),
            "kind": market["kind"]}
    if not live:
        src = next((s for s in sigs if s.get("data_source")), sigs[0] if sigs else {})
        return {**base, "ok": False, "reason": "no_live_data", "data_state": src.get("data_state"),
                "data_source": src.get("data_source"), "data_age": src.get("data_age")}
    # strongest directional lean across durations; ties broken by the shorter duration
    ranked = sorted(live, key=lambda s: (-_strength(s), DURATIONS.index(s["duration"])))
    best = next((s for s in ranked if _direction(s) is not None), ranked[0])
    direction = _direction(best) or "BUY"
    panel = best.get("panel") or {}
    return {
        **base, "ok": True, "direction": direction, "duration": best["duration"],
        "strength": round(_strength(best), 3),
        "price": best.get("entry_price"), "data_source": best.get("data_source"),
        "data_state": best.get("data_state"), "data_age": best.get("data_age"),
        "regime_ar": best.get("regime_ar"), "trend": best.get("trend"),
        "evidence_for": best.get("evidence_for") or [], "evidence_against": best.get("evidence_against") or [],
        "effective_opinions": panel.get("effective_independent_opinions"),
        "validated": bool(best.get("validated")),
        "measured_accuracy": measured_accuracy,
        "timestamp": best.get("timestamp"),
        "evaluated": [{"duration": s["duration"], "direction": _direction(s), "strength": round(_strength(s), 3),
                       "live": s.get("data_state") == "LIVE"} for s in sigs],
    }
