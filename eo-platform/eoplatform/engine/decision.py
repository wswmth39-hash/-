"""Final decision engine (V4 phases 6 and 9).

Input: the fast-engine signals of ONE market for every supported duration (30/60/120/300 s), each
analysed independently with its own candles, model and gates.
Output: ONE decision — BUY, SELL or WAIT — with every field the user needs to judge it:

market, direction, duration, calibrated confidence (or an explicit "not available"), model status,
data source and age, supporting / conflicting evidence, the reason, the state of every gate, and a
per-duration table saying why each duration was chosen or excluded.

Selection rule (unchanged, shared with AUTO): a duration qualifies only if its signal passed every
gate (validated model, threshold, data, risk) AND its conservative expected return
``lb × (1 + payout) − 1`` (lb = 95 % lower bound of the validated accuracy) is positive. Among
qualifying durations the highest conservative EV wins. A duration is never chosen because of a
high historical hit rate alone. If nothing qualifies the answer is WAIT, with the reason.
"""
from __future__ import annotations

import time

from .fast import calibration_ok

DUR_AR = {30: "30 ثانية", 60: "60 ثانية", 120: "120 ثانية", 300: "300 ثانية"}
REASON_AR = {
    "no_data": "لا توجد بيانات حقيقية لهذا السوق",
    "insufficient_continuous_data": "بيانات متصلة غير كافية",
    "data_not_live": "البيانات غير حية",
    "data_anomaly": "قفزة سعرية غير طبيعية حديثة",
    "abnormal_volatility": "تقلب/سيولة غير طبيعية",
    "quiet_market": "السوق هادئ جدًا",
    "frozen_data": "السعر مجمّد",
    "news_risk": "خبر عالي التأثير قريب",
    "no_validated_model": "لا يوجد نموذج اجتاز التحقق المطلوب",
    "model_not_validated": "النموذج لم يتجاوز نقطة التعادل خارج العينة",
    "regime_blocked": "النموذج غير مربح تاريخيًا في نظام السوق الحالي",
    "out_of_distribution": "حالة السوق خارج نطاق بيانات تدريب النموذج",
    "below_validated_threshold": "قوة التوقع أقل من العتبة المتحقق منها",
    "non_positive_edge": "العائد المتوقع المتحفظ بعد نسبة العائد ليس موجبًا",
    "other": "سبب آخر",
}


def _edge(sig: dict, payout: float) -> float | None:
    lb = (sig.get("confidence_detail") or {}).get("wilson_lb")
    if sig.get("decision") in ("BUY", "SELL") and sig.get("validated") and lb is not None:
        return lb * (1 + payout) - 1
    return None


def horizon_row(sig: dict, payout: float, meta_for) -> dict:
    """Independent result for one duration."""
    edge = _edge(sig, payout)
    code = (sig.get("abstain_reason") or {}).get("code")
    if sig.get("decision") in ("BUY", "SELL") and (edge is None or edge <= 0):
        code = "non_positive_edge"
    ok_cal, cal_note = calibration_ok(meta_for(sig))
    cd = sig.get("confidence_detail") or {}
    return {
        "duration": sig["duration"], "duration_ar": DUR_AR.get(sig["duration"], f"{sig['duration']} ث"),
        "decision": sig["decision"], "candidate_unvalidated": sig.get("candidate"),
        "data_state": sig.get("data_state"), "data_age_s": sig.get("data_age"),
        "trend": sig.get("trend"), "regime_ar": sig.get("regime_ar"),
        "model_state": (sig.get("model_status") or {}).get("state", "none"),
        "model_id": sig.get("model_id"),
        "calibrated_probability": sig.get("probability_display") if ok_cal else None,
        "calibration_note": None if ok_cal else cal_note,
        "validated_accuracy": cd.get("oos_accuracy") if sig.get("validated") else None,
        "validated_lower_bound": cd.get("wilson_lb") if sig.get("validated") else None,
        "edge_lb": edge, "payout": payout,
        "gates": sig.get("gates") or [], "stop_code": code,
        "reason_ar": REASON_AR.get(code, (sig.get("abstain_reason") or {}).get("text") or "—") if code else
                     "اجتاز كل الشروط",
        "qualified": bool(edge is not None and edge > 0),
        "signal_id": sig.get("id"),
    }


def decide(market: dict, sigs: list[dict], payout: float, meta_for=lambda s: None) -> dict:
    rows = [horizon_row(s, payout, meta_for) for s in sigs]
    qualified = sorted([r for r in rows if r["qualified"]], key=lambda r: -r["edge_lb"])
    best_row = qualified[0] if qualified else None
    if best_row:
        best = next(s for s in sigs if s["duration"] == best_row["duration"])
        decision, horizon = best["decision"], best["duration"]
        for r in rows:
            r["choice"] = "chosen" if r is best_row else (
                "excluded: أقل عائدًا متوقعًا متحفظًا من المدة المختارة" if r["qualified"] else f"excluded: {r['reason_ar']}")
        reason = (f"أعلى عائد متوقع متحفظ ({best_row['edge_lb']:+.3f} لكل وحدة) بين {len(qualified)} مدة اجتازت "
                  "كل الشروط")
    else:
        best = sigs[0]                         # WAIT: describe the market with the shortest duration
        decision, horizon = "WAIT", None
        for r in rows:
            r["choice"] = f"excluded: {r['reason_ar']}"
        codes = [r["stop_code"] for r in rows]
        common = max(set(codes), key=codes.count) if codes else "other"
        reason = REASON_AR.get(common, "—")
        if len(set(codes)) > 1:
            reason += " (" + "؛ ".join(f"{r['duration_ar']}: {r['reason_ar']}" for r in rows) + ")"
    br = next(r for r in rows if r["duration"] == best["duration"])
    conf = None
    if decision != "WAIT":
        conf = {"validated_accuracy": br["validated_accuracy"], "lower_bound_95": br["validated_lower_bound"],
                "independent_oos_trades": (best.get("confidence_detail") or {}).get("oos_samples"),
                "calibrated_probability": br["calibrated_probability"]}
    return {
        "market": market["id"], "market_name": market["name"], "market_name_ar": market.get("name_ar"),
        "kind": market["kind"], "decision": decision, "direction": decision if decision != "WAIT" else None,
        "candidate_unvalidated": best.get("candidate"), "horizon": horizon,
        "confidence": conf,
        "confidence_note": None if conf and conf.get("calibrated_probability") is not None else
        "الثقة المعايرة غير متوفرة: لا يُعرض احتمال إلا من نموذج متحقق منه ومعايرته مُثبتة",
        "model_state": br["model_state"], "data_source": best.get("data_source"),
        "data_state": best.get("data_state"), "data_age": best.get("data_age"),
        "last_bar_utc": (best.get("data_health") or {}).get("last_bar_utc"),
        "price": best.get("entry_price"), "regime_ar": best.get("regime_ar"), "trend": best.get("trend"),
        "evidence_for": best.get("evidence_for") or [], "evidence_against": best.get("evidence_against") or [],
        "panel": best.get("panel"), "reason": reason, "gates": br["gates"], "horizons": rows,
        "edge_lb": best_row["edge_lb"] if best_row else None, "payout": payout,
        "warnings": best.get("warnings") or [], "timestamp": best.get("timestamp") or time.time(),
        "signal_id": best.get("id"),
        "disclaimer": "تحليل فقط — لا تنفيذ لأي صفقة، ولا ضمان لأي نتيجة",
    }
