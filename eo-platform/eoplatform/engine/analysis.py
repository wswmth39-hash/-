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
    "support_resistance": "وكيل الدعم والمقاومة",
    "news": "وكيل الأخبار والعوامل المؤثرة",
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
    mtf = _v(r, "mtf_align")
    if r.get("htf_trend") is not None and r.get("htf_trend") == r.get("htf_trend"):
        htf = _v(r, "htf_trend")
        facts.append(f"الإطار الأعلى (6×) {'صاعد' if htf > 0 else 'هابط' if htf < 0 else 'مستوٍ'}"
                     + (" — متوافق مع الإطار الحالي" if mtf != 0 else " — غير متوافق"))
        s = _clip(s + 0.15 * mtf)
    return {"score": s, "facts": facts, "label": label, "adx": adx, "mtf_align": mtf}


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
    if _v(r, "choch") > 0:
        facts.append("تغيّر طابع السوق إلى صاعد (CHoCH)"); s += 0.3
    elif _v(r, "choch") < 0:
        facts.append("تغيّر طابع السوق إلى هابط (CHoCH)"); s -= 0.3
    elif _v(r, "bos") > 0:
        facts.append("كسر هيكل صاعد (BOS)"); s += 0.2
    elif _v(r, "bos") < 0:
        facts.append("كسر هيكل هابط (BOS)"); s -= 0.2
    st = _v(r, "structure")
    if st:
        facts.append(f"الهيكل الحالي {'صاعد' if st > 0 else 'هابط'}")
    fi, fn = _v(r, "fvg_into"), _v(r, "fvg_net10")
    if fi > 0:
        facts.append("إعادة اختبار فجوة قيمة عادلة صاعدة (FVG)"); s += 0.2
    elif fi < 0:
        facts.append("إعادة اختبار فجوة قيمة عادلة هابطة (FVG)"); s -= 0.2
    elif fn:
        facts.append(f"صافي فجوات القيمة العادلة في آخر 10 شموع {fn:+.0f}")
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


def support_resistance(c) -> dict:
    """Levels from clustered swing highs/lows of the last 150 analysis candles.
    A level's strength = number of distinct touches. Uses only closed candles."""
    if c is None or len(c) < 30:
        return {"score": 0.0, "facts": ["بيانات غير كافية لتحديد الدعم والمقاومة"], "levels": []}
    c = np.asarray(c)[-150:]
    h, l, cl = c[:, 2], c[:, 3], c[:, 4]
    atr = float(np.mean(h[-14:] - l[-14:])) or 1e-12
    swings = [h[i] for i in range(2, len(c) - 2) if h[i] == h[i - 2:i + 3].max()] + \
             [l[i] for i in range(2, len(c) - 2) if l[i] == l[i - 2:i + 3].min()]
    levels: list[list[float]] = []
    for p in sorted(swings):
        if levels and p - levels[-1][-1] <= 0.3 * atr:
            levels[-1].append(p)
        else:
            levels.append([p])
    lv = [(float(np.mean(g)), len(g)) for g in levels if len(g) >= 2]
    price = float(cl[-1])
    sup = max(((p, n) for p, n in lv if p < price), default=None)
    res = min(((p, n) for p, n in lv if p > price), default=None)
    facts, s = [], 0.0
    if sup:
        d = (price - sup[0]) / atr
        facts.append(f"أقرب دعم {sup[0]:.6g} ({sup[1]} لمسات) على بعد {d:.1f} ATR")
        if d < 0.6:
            s += 0.15 * min(sup[1], 4)
    else:
        facts.append("لا دعم مؤكد تحت السعر")
    if res:
        d = (res[0] - price) / atr
        facts.append(f"أقرب مقاومة {res[0]:.6g} ({res[1]} لمسات) على بعد {d:.1f} ATR")
        if d < 0.6:
            s -= 0.15 * min(res[1], 4)
    else:
        facts.append("لا مقاومة مؤكدة فوق السعر")
    prev = float(cl[-2])
    for p, n in lv:
        if prev <= p < price:
            facts.append(f"اختراق مقاومة {p:.6g}"); s += 0.3
        elif prev >= p > price:
            facts.append(f"كسر دعم {p:.6g}"); s -= 0.3
    return {"score": _clip(s), "facts": facts, "levels": [round(p, 8) for p, _ in lv][:12]}


def news(market: dict | None, events: list[dict] | None, status: dict | None, now: float) -> dict:
    """Risk-only: never produces a direction (score is always 0)."""
    if market is not None and market.get("kind") == "otc":
        return {"score": 0.0, "facts": ["أسعار OTC تصدرها المنصة ولا تتأثر مباشرة بالأخبار الاقتصادية"],
                "high_impact_soon": False, "applicable": False}
    if not status or not status.get("ok"):
        return {"score": 0.0, "facts": ["تقويم الأخبار غير متاح الآن — لا يمكن استبعاد أخبار قريبة"],
                "high_impact_soon": False, "applicable": True, "unavailable": True}
    evs = events or []
    facts = [f"{e['currency']} {e['title']} ({'عالي' if e['impact']=='High' else 'متوسط'} التأثير) "
             f"{'بعد' if e['ts']>now else 'قبل'} {abs(e['ts']-now)/60:.0f} د" for e in evs[:4]]
    high = any(e["impact"] == "High" for e in evs)
    return {"score": 0.0, "facts": facts or ["لا أخبار متوسطة/عالية التأثير قريبة"], "high_impact_soon": high,
            "applicable": True}


FUNCS = {"technical": technical, "trend": trend, "candles": candles,
         "price_action": price_action, "momentum": momentum, "liquidity": liquidity}

# Equal weights until the learning system measures each specialist (see learning/strategies.py).
DEFAULT_WEIGHTS = {**{k: 1.0 for k in FUNCS}, "support_resistance": 1.0, "news": 0.0}


def evidence(row: dict, candles=None, market: dict | None = None, news_events: list | None = None,
             news_status: dict | None = None, now: float | None = None) -> dict[str, dict]:
    out = {}
    for k, fn in FUNCS.items():
        e = fn(row)
        e["agent"] = k
        e["name_ar"] = AGENTS[k]
        out[k] = e
    if candles is not None:
        out["support_resistance"] = {**support_resistance(candles), "agent": "support_resistance",
                                     "name_ar": AGENTS["support_resistance"]}
    if market is not None:
        import time as _t
        out["news"] = {**news(market, news_events, news_status, now or _t.time()), "agent": "news",
                       "name_ar": AGENTS["news"]}
    return out


def ensemble(ev: dict[str, dict], weights: dict | None = None) -> float:
    w = weights or DEFAULT_WEIGHTS
    tot = sum(w.get(k, 0) for k in ev) or 1.0  # news has weight 0: it is risk-only
    return float(np.clip(sum(ev[k]["score"] * w.get(k, 0) for k in ev) / tot, -1, 1))
