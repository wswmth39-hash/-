"""Deterministic specialist evidence, shared by the fast engine (as its reasons) and
by the multi-agent system (as each agent's factual brief).

Scores are in [-1, 1], positive = bullish. They are *hypotheses* based on standard
technical-analysis readings; whether any of them predicts ExpertOption outcomes is
measured by the learning system, not assumed.
"""
from __future__ import annotations

import math

import numpy as np

AGENTS = {
    "technical": "وكيل التحليل الفني",
    "trend": "وكيل اتجاه السوق",
    "candles": "وكيل الشموع اليابانية",
    "price_action": "وكيل حركة السعر",
    "momentum": "وكيل الزخم",
    "liquidity": "وكيل السيولة",
}


def _v(row: dict, k: str, default: float = 0.0) -> float:
    x = row.get(k)
    return default if x is None or (isinstance(x, float) and math.isnan(x)) else float(x)


def _clip(x: float) -> float:
    return max(-1.0, min(1.0, x))


def technical(r: dict) -> dict:
    facts, s = [], 0.0
    rsi = _v(r, "rsi14") + 0.5
    if rsi > 0.7:
        facts.append(f"RSI(14)={rsi*100:.0f} تشبع شرائي"); s -= 0.4
    elif rsi < 0.3:
        facts.append(f"RSI(14)={rsi*100:.0f} تشبع بيعي"); s += 0.4
    else:
        facts.append(f"RSI(14)={rsi*100:.0f} محايد"); s += (rsi - 0.5)
    mh = _v(r, "macd_hist")
    facts.append(f"هيستوغرام MACD {'موجب' if mh > 0 else 'سالب'} ({mh:+.2f} ATR)"); s += _clip(mh * 2) * 0.4
    pb = _v(r, "bb_pctb") + 0.5
    if pb > 1:
        facts.append("السعر فوق نطاق بولينجر العلوي"); s -= 0.2
    elif pb < 0:
        facts.append("السعر تحت نطاق بولينجر السفلي"); s += 0.2
    k, d = _v(r, "stoch_k"), _v(r, "stoch_d")
    facts.append(f"ستوكاستك %K {'فوق' if k > d else 'تحت'} %D"); s += 0.2 if k > d else -0.2
    return {"score": _clip(s), "facts": facts}


def trend(r: dict) -> dict:
    efs, slope, adx, di = _v(r, "ema_fast_slow"), _v(r, "ema_slope"), _v(r, "adx"), _v(r, "di_diff")
    s = _clip(0.5 * _clip(efs) + 0.3 * _clip(slope) + 0.2 * _clip(di * 4))
    strength = "قوي" if adx > 0.25 else "ضعيف"
    label = "صاعد" if s > 0.15 else "هابط" if s < -0.15 else "عرضي"
    facts = [f"EMA9 {'فوق' if efs > 0 else 'تحت'} EMA21 ({efs:+.2f} ATR)",
             f"ميل EMA21 {slope:+.2f} ATR/5 شموع", f"ADX={adx*100:.0f} اتجاه {strength}"]
    if adx <= 0.2:
        s *= 0.5
    return {"score": s, "facts": facts, "label": label, "adx": adx}


def candles(r: dict) -> dict:
    facts, s = [], 0.0
    if _v(r, "engulf") > 0:
        facts.append("ابتلاع شرائي"); s += 0.5
    elif _v(r, "engulf") < 0:
        facts.append("ابتلاع بيعي"); s -= 0.5
    if _v(r, "hammer"):
        facts.append("شمعة مطرقة (ذيل سفلي طويل)"); s += 0.3
    if _v(r, "star"):
        facts.append("شهاب/نجمة (ذيل علوي طويل)"); s -= 0.3
    if _v(r, "doji"):
        facts.append("دوجي — تردد"); s *= 0.5
    if _v(r, "three") > 0:
        facts.append("ثلاث شموع صاعدة متتالية"); s += 0.3
    elif _v(r, "three") < 0:
        facts.append("ثلاث شموع هابطة متتالية"); s -= 0.3
    b = _v(r, "body")
    facts.append(f"جسم الشمعة الأخيرة {b:+.2f} من مداها")
    s += 0.2 * b
    return {"score": _clip(s), "facts": facts}


def price_action(r: dict) -> dict:
    facts, s = [], 0.0
    bo = _v(r, "breakout")
    if bo > 0:
        facts.append("اختراق قمة آخر 20 شمعة"); s += 0.5
    elif bo < 0:
        facts.append("كسر قاع آخر 20 شمعة"); s -= 0.5
    dh, dl = _v(r, "dist_hi20"), _v(r, "dist_lo20")
    facts.append(f"المسافة إلى المقاومة {dh:.1f} ATR وإلى الدعم {dl:.1f} ATR")
    if 0 <= dh < 0.5:
        s -= 0.2; facts.append("قريب من مقاومة")
    if 0 <= dl < 0.5:
        s += 0.2; facts.append("قريب من دعم")
    hh = _v(r, "hh_hl")
    if abs(hh) >= 2:
        facts.append("قمم وقيعان صاعدة" if hh > 0 else "قمم وقيعان هابطة"); s += 0.1 * hh
    return {"score": _clip(s), "facts": facts}


def momentum(r: dict) -> dict:
    r3, r6, st = _v(r, "ret3"), _v(r, "ret6"), _v(r, "streak")
    s = _clip(0.4 * _clip(r3 / 2) + 0.4 * _clip(r6 / 3) + 0.2 * _clip(st / 4))
    facts = [f"عائد 3 شموع {r3:+.2f} ATR", f"عائد 6 شموع {r6:+.2f} ATR", f"تتابع الشموع {st:+.0f}"]
    return {"score": s, "facts": facts}


def liquidity(r: dict) -> dict:
    facts, s = [], 0.0
    sw = _v(r, "sweep")
    if sw > 0:
        facts.append("سحب سيولة أسفل القاع ثم عودة (إشارة شرائية محتملة)"); s += 0.5
    elif sw < 0:
        facts.append("سحب سيولة أعلى القمة ثم عودة (إشارة بيعية محتملة)"); s -= 0.5
    eq = _v(r, "equal_levels")
    if eq > 0:
        facts.append("قمم متساوية — سيولة متجمعة فوق السعر")
    elif eq < 0:
        facts.append("قيعان متساوية — سيولة متجمعة تحت السعر")
    ar, atr_ratio = _v(r, "activity_ratio", 1.0), _v(r, "atr_ratio", 1.0)
    facts.append(f"نشاط التحديثات {ar:.2f}× المتوسط، التقلب {atr_ratio:.2f}× المتوسط")
    risk = atr_ratio > 2.0 or ar < 0.4
    if risk:
        facts.append("ظروف سيولة/تقلب غير طبيعية")
    return {"score": _clip(s), "facts": facts, "abnormal": bool(risk)}


FUNCS = {"technical": technical, "trend": trend, "candles": candles,
         "price_action": price_action, "momentum": momentum, "liquidity": liquidity}

# Equal weights until the learning system measures each specialist (see learning/strategies.py).
DEFAULT_WEIGHTS = {k: 1.0 for k in FUNCS}


def evidence(row: dict) -> dict[str, dict]:
    out = {}
    for k, fn in FUNCS.items():
        e = fn(row)
        e["agent"] = k
        e["name_ar"] = AGENTS[k]
        out[k] = e
    return out


def ensemble(ev: dict[str, dict], weights: dict | None = None) -> float:
    w = weights or DEFAULT_WEIGHTS
    tot = sum(w.get(k, 0) for k in ev) or 1.0
    return float(np.clip(sum(ev[k]["score"] * w.get(k, 0) for k in ev) / tot, -1, 1))
