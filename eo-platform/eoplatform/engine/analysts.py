"""The eight-analyst panel (V4 phases 3 and 8).

Each analyst has ONE job and its own inputs:

| key          | role         | job                                                                    |
|--------------|--------------|------------------------------------------------------------------------|
| trend        | directional  | EMA 9/21, SMA 20/50, EMA slope, ADX/DI, higher time frame               |
| momentum     | directional  | 3/6-candle returns, ROC, candle streak                                  |
| technical    | directional  | oscillators: RSI, MACD histogram, Bollinger %B, Stochastic              |
| price_action | directional  | structure (BOS/CHoCH/FVG), candle patterns, support/resistance,          |
|              |              | breakouts, bounces/rejections                                           |
| volatility   | risk         | ATR level and ratio, Bollinger width/squeeze, abnormal liquidity        |
| regime       | context      | trend / range / quiet / volatile — which kind of signal fits now        |
| model        | directional  | the validated statistical model ONLY (abstains when none exists)       |
| data_risk    | risk         | data freshness/health, recent jumps, high-impact news                   |

Redundancy control: directional analysts that repeat each other must not count as independent
evidence. Their weights are ``1 / Σ_j max(0, ρ_ij)`` over the correlation matrix of their scores,
MEASURED on real data (``tests/bench/analyst_redundancy.py`` → ``docs/analyst_redundancy.json``).
The panel reports the effective number of independent opinions.

Agreement between analysts is NOT evidence that a signal is correct: only a model that passed
statistical validation can turn a direction into BUY/SELL (engine/fast.py). The panel explains;
it never decides on its own.

VWAP is not computed: the stored 1-second bars carry no traded volume (only an update count),
and a VWAP built on update counts would be a different, misleading indicator.
"""
from __future__ import annotations

import math

import numpy as np

from . import analysis as A

NAMES_AR = {
    "trend": "محلل الاتجاه", "momentum": "محلل الزخم", "technical": "محلل المؤشرات الفنية",
    "price_action": "محلل حركة السعر", "volatility": "محلل التقلب", "regime": "محلل نظام السوق",
    "model": "محلل النموذج الإحصائي", "data_risk": "محلل جودة البيانات والمخاطر",
}
ROLE = {"trend": "directional", "momentum": "directional", "technical": "directional",
        "price_action": "directional", "model": "directional",
        "volatility": "risk", "data_risk": "risk", "regime": "context"}

# Pearson correlations of the four rule-based directional analysts' scores, measured on
# 17,156 real 10-second candles (BTC/ETH/LTC/XRP, Binance, 36 h). Regenerate with
# tests/bench/analyst_redundancy.py; the test suite checks this matrix is symmetric and sane.
MEASURED_CORR = {
    ("trend", "momentum"): 0.40, ("trend", "technical"): 0.27, ("trend", "price_action"): 0.34,
    ("momentum", "technical"): 0.56, ("momentum", "price_action"): 0.72, ("technical", "price_action"): 0.43,
}
RULE_BASED = ("trend", "momentum", "technical", "price_action")


def _corr(a: str, b: str) -> float:
    if a == b:
        return 1.0
    return MEASURED_CORR.get((a, b), MEASURED_CORR.get((b, a), 0.0))


def redundancy_weights(keys=RULE_BASED) -> dict[str, float]:
    """w_i = 1 / Σ_j max(0, ρ_ij): an analyst that mostly repeats others gets a small weight."""
    return {k: 1.0 / sum(max(0.0, _corr(k, j)) for j in keys) for k in keys}


WEIGHTS = redundancy_weights()


def effective_n(keys=RULE_BASED) -> float:
    """Effective number of independent opinions among ``keys`` (1 = all identical, len = independent)."""
    C = np.array([[_corr(a, b) for b in keys] for a in keys])
    ev = np.clip(np.linalg.eigvalsh(C), 0, None)
    return float(ev.sum() ** 2 / (ev ** 2).sum())


def _v(row, k, d=0.0):
    x = row.get(k)
    return d if x is None or (isinstance(x, float) and math.isnan(x)) else float(x)


def _stance(score: float, eps: float = 0.1) -> str:
    return "BUY" if score > eps else "SELL" if score < -eps else "neutral"


# ---------------------------------------------------------------------- directional analysts
def trend(row: dict, c: np.ndarray | None) -> dict:
    e = A.trend(row)
    s, facts = e["score"], list(e["facts"])
    if c is not None and len(c) >= 50:
        cl = c[:, 4]
        sma20, sma50 = float(cl[-20:].mean()), float(cl[-50:].mean())
        px = float(cl[-1])
        above20, above50 = px > sma20, px > sma50
        facts.append(f"السعر {'فوق' if above20 else 'تحت'} SMA20 و{'فوق' if above50 else 'تحت'} SMA50؛ "
                     f"SMA20 {'فوق' if sma20 > sma50 else 'تحت'} SMA50")
        s = float(np.clip(s + 0.1 * ((1 if above20 else -1) + (1 if sma20 > sma50 else -1)) / 2, -1, 1))
    return {"score": s, "facts": facts, "label": e.get("label")}


def momentum(row: dict, c=None) -> dict:
    e = A.momentum(row)
    roc = _v(row, "roc6")
    return {"score": e["score"], "facts": e["facts"] + [f"ROC(6)={roc:+.2f}"]}


def technical(row: dict, c=None) -> dict:
    return A.technical(row)


def price_action(row: dict, c: np.ndarray | None) -> dict:
    pa, cd = A.price_action(row), A.candles(row)
    parts = [pa["score"], 0.5 * cd["score"]]
    facts = pa["facts"][:4] + cd["facts"][:2]
    sr = A.support_resistance(c) if c is not None else None
    if sr:
        parts.append(0.5 * sr["score"])
        facts += sr["facts"][:2]
    # bounce / rejection: at a level with a long wick against the approach
    dl, dh = _v(row, "dist_lo20", 9), _v(row, "dist_hi20", 9)
    lw, uw = _v(row, "lower_wick"), _v(row, "upper_wick")
    if 0 <= dl < 0.5 and (lw > 0.5 or _v(row, "hammer")):
        facts.append("ارتداد محتمل من دعم (ذيل سفلي طويل عند القاع)"); parts.append(0.2)
    if 0 <= dh < 0.5 and (uw > 0.5 or _v(row, "star")):
        facts.append("رفض محتمل عند مقاومة (ذيل علوي طويل عند القمة)"); parts.append(-0.2)
    return {"score": float(np.clip(sum(parts) / max(1.0, len(parts) - 1), -1, 1)), "facts": facts}


# ---------------------------------------------------------------------- risk / context analysts
def volatility(row: dict, ev_liq: dict) -> dict:
    ratio, atr_rel, bbw = _v(row, "atr_ratio", 1.0), _v(row, "atr_rel"), _v(row, "bb_width")
    level = "high" if ratio > 1.8 else "low" if ratio < 0.4 else "normal"
    facts = [f"ATR = {atr_rel:.2f} نقطة أساس من السعر، {ratio:.2f}× متوسطه", f"عرض بولينجر {bbw:.3f}%"]
    if ratio < 0.7 and bbw > 0:
        facts.append("انضغاط في التقلب (قد يسبق حركة قوية، دون اتجاه محدد)")
    block = bool(ev_liq.get("abnormal")) or level in ("high", "low")
    if ev_liq.get("abnormal"):
        facts.append("ظروف سيولة/تقلب غير طبيعية")
    return {"score": 0.0, "facts": facts, "level": level, "verdict": "block" if block else "allow"}


def regime_view(reg: str, row: dict) -> dict:
    from .structure import REGIME_AR
    adx = _v(row, "adx")
    fit = {"trend_up": "إشارات متابعة الاتجاه أنسب", "trend_down": "إشارات متابعة الاتجاه أنسب",
           "range": "حركة عرضية: إشارات الاختراق أضعف، والارتداد من الحدود أنسب",
           "volatile": "تقلب مرتفع: مخاطرة عالية", "quiet": "هدوء شديد: احتمال التعادل مرتفع"}[reg]
    return {"score": 0.0, "facts": [f"النظام: {REGIME_AR[reg]} (ADX={adx * 100:.0f})", fit], "regime": reg,
            "verdict": "block" if reg in ("volatile", "quiet") else "allow"}


def model_view(model: dict | None) -> dict:
    """Directional ONLY when a validated model is in place; otherwise it abstains (score 0)."""
    if not model:
        return {"score": 0.0, "facts": ["لا يوجد نموذج اجتاز التحقق الإحصائي لهذا السوق والمدة — يمتنع عن الرأي"],
                "verdict": "abstain"}
    p, thr = model.get("p_up"), model.get("threshold")
    strength = abs(p - 0.5) if p is not None else 0.0
    facts = [f"نموذج #{model['id']} ({model.get('algo')}) متحقق منه: دقة {model['oos_acc'] * 100:.1f}% "
             f"على {model['oos_n']} صفقة مستقلة خارج العينة"]
    if thr is not None:
        facts.append(f"قوة التوقع {strength:.3f} {'≥' if strength >= thr else '<'} العتبة المتحقق منها {thr:.3f}")
    s = 0.0 if p is None else float(np.clip((p - 0.5) * 4, -1, 1))
    return {"score": s, "facts": facts, "verdict": "agree" if thr is not None and strength >= thr else "weak"}


def data_risk(health: dict | None, state: str, news: dict | None) -> dict:
    facts, block = [], False
    if state != "LIVE":
        facts.append(f"البيانات غير حية ({state})"); block = True
    if health:
        facts.append(f"آخر شمعة {health.get('last_bar_utc') or '—'}، عمر البيانات {health.get('age_s')} ث، "
                     f"فجوات آخر ساعة {health.get('gaps_last_hour')}")
        if health.get("recent_spike"):
            facts.append("قفزة سعرية غير طبيعية حديثة"); block = True
        if health.get("frozen"):
            facts.append("السعر مجمّد"); block = True
    if news:
        facts += news.get("facts", [])[:2]
        if news.get("high_impact_soon"):
            block = True
    return {"score": 0.0, "facts": facts or ["لا ملاحظات"], "verdict": "block" if block else "allow"}


# ---------------------------------------------------------------------- panel
def panel(row: dict | None, candles: np.ndarray | None, ev: dict | None, reg: str | None, state: str,
          health: dict | None, model: dict | None) -> dict:
    out: dict[str, dict] = {}
    if row is not None:
        for k, fn in (("trend", trend), ("momentum", momentum), ("technical", technical),
                      ("price_action", price_action)):
            out[k] = fn(row, candles)
        out["volatility"] = volatility(row, (ev or {}).get("liquidity", {}))
        if reg:
            out["regime"] = regime_view(reg, row)
    out["model"] = model_view(model)
    out["data_risk"] = data_risk(health, state, (ev or {}).get("news"))

    directional = [k for k in RULE_BASED if k in out]
    w = {k: WEIGHTS[k] for k in directional}
    tot_w = sum(w.values()) or 1.0
    consensus = sum(out[k]["score"] * w[k] for k in directional) / tot_w if directional else 0.0
    abs_tot = sum(abs(out[k]["score"]) * w[k] for k in directional) or 1.0
    for k, a in out.items():
        a.update(key=k, name_ar=NAMES_AR[k], role=ROLE[k])
        if k in w:
            a["weight"] = round(w[k] / tot_w, 3)
            a["influence"] = round(out[k]["score"] * w[k] / abs_tot, 3)   # signed share of the consensus
            a["stance"] = _stance(a["score"])
        else:
            a["weight"], a["influence"] = 0.0, 0.0
            a["stance"] = a.get("verdict", "neutral")
        a["score"] = round(float(a["score"]), 3)
    d = _stance(consensus, 0.05)
    agree = [k for k in directional if out[k]["stance"] == d and d != "neutral"]
    oppose = [k for k in directional if out[k]["stance"] not in (d, "neutral") and d != "neutral"]
    blocks = [k for k in ("volatility", "regime", "data_risk") if out.get(k, {}).get("verdict") == "block"]
    return {"analysts": out, "consensus": round(float(consensus), 3), "direction": d, "agree": agree,
            "oppose": oppose, "blocks": blocks, "effective_independent_opinions": round(effective_n(directional), 2)
            if len(directional) > 1 else float(len(directional)),
            "note": "توافق المحللين ليس إثباتًا لصحة الإشارة؛ القرار يتطلب نموذجًا اجتاز التحقق الإحصائي"}
