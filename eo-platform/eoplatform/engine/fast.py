"""Fast BUY/SELL/WAIT engine. Pure Python/NumPy + XGBoost, typically < 50 ms.
It never waits for the LLM agents; they run afterwards and are recorded separately.

Decision order (any failing gate → WAIT with the reason):
 1. genuine data exists for this market from an allowed source (OTC: ExpertOption only)
 2. data is LIVE (fresh within EO_LIVE_MAX_AGE seconds)
 3. enough continuous recent candles to compute features
 4. a validated champion model exists (unless EO_REQUIRE_VALIDATED_MODEL=false)
 5. the prediction is at least as strong as the model's validated trading threshold
 6. no abnormal liquidity/volatility condition
A "candidate" direction is always recorded so outcomes can be measured even on WAIT.
"""
from __future__ import annotations

import time

from ..config import ANALYSIS_PERIOD, Settings
from ..data.hub import DataHub, resample
from . import analysis as A
from . import analysts as AN
from . import features as F
from .model import Registry, confidence_for

STATE_AR = {"LIVE": "حية", "DELAYED": "متأخرة", "STALE": "قديمة", "OFFLINE": "غير متاحة"}
SOURCE_AR = {"expertoption": "ExpertOption (عبر الجسر)", "binance": "Binance (بيانات مرجعية — ليست سعر ExpertOption)",
             "import": "بيانات مستوردة"}


def analyze(market: dict, duration: int, hub: DataHub, registry: Registry, settings: Settings,
            now: float | None = None, news=None, perf=None) -> dict:
    t0 = time.perf_counter()
    now = now or time.time()
    P = ANALYSIS_PERIOD[duration]
    sig = {
        "market": market["id"], "market_name": market["name"], "market_name_ar": market.get("name_ar"),
        "kind": market["kind"], "duration": duration, "timestamp": now, "source": "fast",
        "decision": "WAIT", "candidate": None, "prob": None, "confidence": None, "validated": False,
        "model_id": None, "trend": None, "reasons": [], "warnings": [], "evidence": {},
        "data_source": None, "data_source_ar": None, "data_state": "OFFLINE", "data_age": None,
        "entry_price": None, "entry_ts": None, "analysis_period": P,
    }

    ctx: dict = {}

    def done():
        classify(sig, ctx, settings)
        explain(sig, ctx, settings, perf)
        sig["panel"] = AN.panel(ctx.get("row"), ctx.get("c"), ctx.get("ev"), ctx.get("regime"), sig["data_state"],
                                ctx.get("health"), ctx.get("model"))
        sig["latency_ms"] = round((time.perf_counter() - t0) * 1000, 1)
        return sig

    src, state = hub.best_source(market, now)
    if src is None:
        sig["reasons"].append("لا توجد بيانات حقيقية لهذا السوق" +
                              (" — أسواق OTC تتطلب بيانات ExpertOption عبر الجسر" if market["kind"] == "otc" else ""))
        return done()
    price, rx = hub.last_price(market["id"], src)
    sig.update(data_source=src, data_source_ar=SOURCE_AR.get(src, src), data_state=state,
               data_age=round(now - rx, 2) if rx else None, entry_price=price, entry_ts=int(now))
    if src != "expertoption":
        sig["warnings"].append("مصدر البيانات مرجعي وليس سعر ExpertOption نفسه؛ قد يختلف السعر قليلًا")
    from ..data import quality as DQ
    h = DQ.health(hub, market["id"], src, now)
    ctx["health"] = h
    sig["data_health"] = {k: h.get(k) for k in ("last_bar_utc", "age_s", "gaps_last_hour", "longest_gap_s",
                                                "spikes_last_hour", "recent_spike", "frozen", "degraded")}

    bars = hub.bars(market["id"], src, seconds=F.LIVE_CANDLES * P, include_current=False)
    c = resample(bars, P)
    if len(c) and c[-1, 0] + P > (bars[-1, 0] + 1 if len(bars) else 0):
        c = c[:-1]  # drop the still-forming candle
    if len(c) and c[0, 0] < bars[0, 0]:
        c = c[1:]   # drop the partially covered first candle: the window start moves every second,
                    # which made indicator values (and the feature-cache key) change on every call
    if len(c) < F.MIN_CANDLES or not F.contiguous(c, P)[-1]:
        sig["reasons"].append(f"بيانات متصلة غير كافية: يلزم {F.MIN_CANDLES} شمعة متتالية من {P} ثانية")
        if state != "LIVE":
            sig["reasons"].append(f"حالة البيانات: {STATE_AR[state]}")
        return done()

    ctx["c"] = c
    feats = F.compute_cached(c)
    row = feats.iloc[-1].to_dict()
    news_events = news_status = None
    if news is not None:
        from ..data.providers.news import market_currencies
        news_status = news.status()
        news_events = news.near(market_currencies(market), now, settings.news_window_min)
    ev = A.evidence(row, candles=c, market=market, news_events=news_events,
                    news_status=news_status if news is not None else {"ok": False}, now=now)
    sig["evidence"] = ev
    q = hub.quality.get(market["id"], {})
    sig["data_quality"] = {k: v for k, v in q.items()}
    from .structure import REGIME_AR, regime
    reg = regime(row)
    sig["regime"], sig["regime_ar"] = reg, REGIME_AR[reg]
    ctx.update(row=row, ev=ev, regime=reg)
    sig["trend"] = ev["trend"]["label"]
    score = A.ensemble(ev)
    sig["ensemble_score"] = round(score, 3)
    sig["features"] = {k: (None if v != v else round(float(v), 4)) for k, v in row.items()}

    champ = registry.champion(market["id"], duration)
    if champ is not None and champ[0]["metrics"].get("source") != src:
        sig["warnings"].append("النموذج المعتمد دُرّب على مصدر بيانات آخر؛ لا يُستخدم على هذا المصدر")
        champ = None
    if champ is not None and champ[0]["metrics"].get("features", F.FEATURES) != F.FEATURES:
        sig["warnings"].append("النموذج المعتمد دُرّب على قائمة مؤشرات مختلفة؛ يلزم إعادة تدريب")
        champ = None
    p_up = None
    if champ is not None:
        mrow, model = champ
        x = feats.iloc[[-1]].to_numpy(dtype=float)
        p_up = float(model.predict(x)[0])
        sig["prob"] = round(p_up, 4)          # internal model output; displayed only if calibrated
        sig["model_id"] = mrow["id"]
        ctx["model_meta"] = mrow["metrics"]
        sig["candidate"] = "BUY" if p_up > 0.5 else "SELL"
    else:
        # no model: candidate direction from the redundancy-weighted analyst consensus (NOT a decision)
        cons = AN.panel(row, c, ev, reg, state, h, None)["consensus"]
        sig["consensus_score"] = cons
        sig["candidate"] = "BUY" if cons > 0 else "SELL" if cons < 0 else None

    # reasons: strongest agreeing specialist facts first
    direction = 1 if sig["candidate"] == "BUY" else -1 if sig["candidate"] == "SELL" else 0
    for k, e in sorted(ev.items(), key=lambda kv: -kv[1]["score"] * direction):
        tag = "يؤيد" if e["score"] * direction > 0.05 else "يعارض" if e["score"] * direction < -0.05 else "محايد"
        sig["reasons"].append(f"{e['name_ar']} ({tag}): " + "، ".join(e["facts"][:3]))

    if state != "LIVE":
        sig["reasons"].insert(0, f"البيانات {STATE_AR[state]} (آخر تحديث قبل {sig['data_age']} ث) — لا إشارة على بيانات غير حية")
        return done()
    if h.get("recent_spike"):
        sig["reasons"].insert(0, "قفزة سعرية غير طبيعية خلال آخر دقيقتين (أكبر من 12 انحرافًا متينًا في ثانية واحدة): حركة عنيفة أو خطأ بيانات — انتظار")
        ctx["unreliable"] = True
        return done()
    if ev["liquidity"].get("abnormal"):
        sig["reasons"].insert(0, "ظروف تقلب/سيولة غير طبيعية — انتظار")
        ctx["blocked"] = "volatility"
        return done()
    if reg == "quiet":
        sig["reasons"].insert(0, "السوق هادئ جدًا (تقلب أقل من 40% من المعتاد) — احتمال التعادل مرتفع، انتظار")
        ctx["blocked"] = "quiet"
        return done()
    if q.get(f"frozen_{src}"):
        sig["reasons"].insert(0, "السعر مجمّد (لم يتغير منذ دقيقتين) — بيانات مشكوك فيها، انتظار")
        ctx["unreliable"] = True
        return done()
    if q.get("mismatch"):
        sig["warnings"].append(f"عدم تطابق بين سعر ExpertOption والمرجع ({q.get('mismatch_median_pct')}%)")
    if ev.get("news", {}).get("high_impact_soon"):
        sig["reasons"].insert(0, "خبر اقتصادي عالي التأثير قريب من وقت الصفقة — انتظار")
        ctx["blocked"] = "news"
        return done()

    if champ is None:
        msg = "لا يوجد نموذج مُتحقق منه لهذا السوق والمدة بعد؛ الاتجاه المرشح غير مُثبت إحصائيًا"
        if settings.require_validated_model:
            sig["reasons"].insert(0, msg)
            return done()
        sig["warnings"].append(msg)
        sig["decision"] = sig["candidate"] or "WAIT"
        return done()

    meta = mrow["metrics"]
    thr = meta.get("threshold")
    conf = confidence_for(meta, p_up)
    if conf:
        sig["confidence"] = round(conf["acc"], 4) if conf["acc"] is not None else None
        sig["confidence_detail"] = {"oos_accuracy": conf["acc"], "oos_samples": conf["n"],
                                    "wilson_lb": conf["wilson_lb"], "breakeven": settings.breakeven,
                                    "model_trained_at": mrow["created_at"]}
    ctx.update(thr=thr, p_up=p_up)
    if meta.get("validated") and conf and conf.get("acc") is not None:
        ctx["model"] = {"id": mrow["id"], "algo": meta.get("algo", "xgboost"), "p_up": p_up, "threshold": thr,
                        "oos_acc": conf["acc"], "oos_n": conf["n"]}
    if thr is None:
        sig["reasons"].insert(0, "النموذج الحالي لم يحقق دقة أعلى من نقطة التعادل خارج العينة — انتظار")
        return done()
    # Dynamic threshold: regimes where this model's held-out accuracy at its threshold fell below
    # break-even (measured in training, enough samples) are blocked for this model.
    rb = (meta.get("regime_stats") or {}).get(reg)
    if rb and rb.get("blocked"):
        sig["reasons"].insert(0, f"النموذج غير مربح تاريخيًا في حالة «{REGIME_AR[reg]}» "
                                 f"(دقة {rb['acc']*100:.1f}% على {rb['n']} صفقة خارج العينة) — انتظار")
        ctx["blocked"] = "regime"
        return done()
    if abs(p_up - 0.5) < thr:
        sig["reasons"].insert(0, f"قوة التوقع {abs(p_up-0.5):.3f} أقل من العتبة المُتحقق منها {thr:.3f}")
        return done()
    sig["decision"] = sig["candidate"]
    sig["validated"] = True
    return done()


ECE_MAX = 0.03


def calibration_ok(meta: dict | None) -> tuple[bool, str]:
    """A raw model probability may be displayed only when the model is validated AND its
    probabilities proved calibrated on independent out-of-sample trades."""
    if not meta or not meta.get("validated"):
        return False, "لا يوجد نموذج مُتحقق منه"
    cq = meta.get("calibration_quality") or {}
    rel = cq.get("reliability") or []
    n = sum(b["n"] for b in rel)
    if n < 200:
        return False, "عينة المعايرة غير كافية"
    ece = sum(b["n"] * abs(b["mean_pred"] - b["freq_up"]) for b in rel) / n
    if ece > ECE_MAX or (cq.get("brier") or 1) >= (cq.get("brier_baseline") or 0):
        return False, f"الاحتمالات غير معايرة (ECE {ece:.3f})"
    return True, f"معايرة مُتحقق منها (ECE {ece:.3f} على {n} صفقة مستقلة)"


ABSTAIN_CODES = [("لا توجد بيانات", "no_data"), ("متصلة غير كافية", "insufficient_continuous_data"),
                 ("ليست حية", "data_not_live"), ("لا إشارة على بيانات غير حية", "data_not_live"),
                 ("مجمّد", "frozen_data"), ("قفزة سعرية غير طبيعية", "data_anomaly"), ("تقلب/سيولة", "abnormal_volatility"), ("هادئ جدًا", "quiet_market"),
                 ("خبر اقتصادي", "news_risk"), ("غير مربح تاريخيًا", "regime_blocked"),
                 ("لا يوجد نموذج", "no_validated_model"), ("لم يحقق دقة", "model_not_validated"),
                 ("أقل من العتبة", "below_validated_threshold")]


def explain(sig: dict, ctx: dict, settings, perf) -> None:
    """Supporting / conflicting evidence, validation status, conditional historical performance."""
    ev = ctx.get("ev") or {}
    d = 1 if sig.get("candidate") == "BUY" else -1 if sig.get("candidate") == "SELL" else 0
    sig["evidence_for"], sig["evidence_against"] = [], []
    for k, e in ev.items():
        if k == "news":
            continue
        line = {"agent": e.get("name_ar", k), "score": round(e["score"], 3), "facts": e.get("facts", [])[:3]}
        if d and e["score"] * d > 0.05:
            sig["evidence_for"].append(line)
        elif d and e["score"] * d < -0.05:
            sig["evidence_against"].append(line)
    sig["evidence_for"].sort(key=lambda x: -abs(x["score"]))
    sig["evidence_against"].sort(key=lambda x: -abs(x["score"]))
    meta = ctx.get("model_meta")
    if meta:
        g = meta.get("gates") or {}
        sig["model_status"] = {
            "state": "validated" if meta.get("validated") else "not_validated", "model_id": sig.get("model_id"),
            "protocol": meta.get("protocol"), "algo": meta.get("algo", "xgboost"), "spec": meta.get("spec"),
            "oos_independent_trades": g.get("trades"), "oos_accuracy": g.get("accuracy"), "oos_lb": g.get("lb"),
            "required_accuracy": meta.get("required_accuracy"), "folds": meta.get("walk_forward")}
        reg = (meta.get("regime_stats") or {}).get(sig.get("regime"))
    else:
        sig["model_status"] = {"state": "none", "note": "لا يوجد نموذج مُتحقق منه لهذا السوق والمدة"}
        reg = None
    ok, why = calibration_ok(meta)
    sig["probability_display"] = sig.get("prob") if ok else None
    sig["probability_note"] = why if ok else f"لا يُعرض احتمال: {why}"
    sig["conditional_performance"] = {
        "oos_this_regime": ({**reg, "verified": reg.get("n", 0) >= 30} if reg else None),
        "live": perf.get(sig["market"], sig["duration"], sig.get("regime")) if perf is not None else None}
    if sig["decision"] == "WAIT":
        first = (sig.get("reasons") or [""])[0]
        code = next((c for k, c in ABSTAIN_CODES if k in first), "other")
        sig["abstain_reason"] = {"code": code, "text": first}


CLASS_AR = {"STRONG_BUY": "شراء قوي", "STRONG_SELL": "بيع قوي", "BUY": "شراء", "SELL": "بيع",
            "WEAK": "فرصة ضعيفة", "CONFLICT": "إشارات متعارضة", "BLOCKED": "محجوبة بفلتر",
            "UNRELIABLE_DATA": "بيانات غير موثوقة", "NO_DATA": "لا بيانات"}


def classify(sig: dict, ctx: dict, settings) -> None:
    """Signal class + quality score (0–100).

    The quality score is a transparent heuristic, NOT a probability and NOT validated: it never
    overrides the validated model decision. It is stored with every signal so the learning system
    can measure whether higher quality actually means better outcomes (Performance page)."""
    ev, row = ctx.get("ev"), ctx.get("row")
    if sig["data_state"] == "OFFLINE" and not ev:
        sig["signal_class"], sig["quality_score"] = "NO_DATA", 0
    elif ctx.get("unreliable") or sig["data_state"] != "LIVE" or not ev:
        sig["signal_class"], sig["quality_score"] = "UNRELIABLE_DATA", 0
    else:
        d = 1 if sig["candidate"] == "BUY" else -1 if sig["candidate"] == "SELL" else 0
        directional = [e for k, e in ev.items() if k != "news" and abs(e["score"]) > 0.05]
        agree = sum(1 for e in directional if e["score"] * d > 0)
        oppose = sum(1 for e in directional if e["score"] * d < 0)
        frac = agree / len(directional) if directional else 0.5
        p_up, thr = ctx.get("p_up"), ctx.get("thr")
        model = 40 * min(1.0, abs(p_up - 0.5) / (2 * thr)) if (p_up is not None and thr) else 0.0
        mtf = (row or {}).get("mtf_align") or 0
        mtf_pts = 15 if mtf == d and d else 7 if mtf == 0 else 0
        reg = ctx.get("regime")
        reg_pts = 15 if (reg == "trend_up" and d > 0) or (reg == "trend_down" and d < 0) else 10 if reg == "range" else 3
        age = sig.get("data_age") or 0
        data_pts = 10 if age <= 1 else 6 if age <= settings.live_max_age else 0
        score = round(model + 20 * frac + mtf_pts + reg_pts + data_pts)
        sig["quality_score"] = int(max(0, min(100, score)))
        sig["quality_parts"] = {"model": round(model, 1), "agreement": round(20 * frac, 1), "mtf": mtf_pts,
                                "regime": reg_pts, "data": data_pts, "agree": agree, "oppose": oppose}
        if ctx.get("blocked"):
            cls = "BLOCKED"
        elif sig["decision"] in ("BUY", "SELL"):
            cls = ("STRONG_" if sig["quality_score"] >= 70 else "") + sig["decision"]
        elif oppose >= 3 and agree >= 3 or (mtf and d and mtf == -d):
            cls = "CONFLICT"
        else:
            cls = "WEAK"
        sig["signal_class"] = cls
    sig["signal_class_ar"] = CLASS_AR[sig["signal_class"]]
