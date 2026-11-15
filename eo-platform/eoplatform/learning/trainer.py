"""Walk-forward training, strategy comparison and champion/challenger promotion.

Protocol (per market × duration × data source × candidate spec):
 1. Build samples from genuine stored 1s bars (no synthetic data, ever).
 2. Time-ordered split: first 70% train, a purge gap, last 30% test. Nothing from
    the test period is used for fitting or for choosing hyper-parameters.
 3. Also report a 3-fold expanding-window walk-forward for stability.
 4. Calibrate on the test set: accuracy by prediction strength, Wilson lower bound.
 5. The challenger is promoted only if it has a trading threshold whose test
    accuracy is above the payout break-even with Bonferroni-corrected confidence, and it
    beats the current champion evaluated on the SAME test window.
 6. The deployed model is exactly the model that was validated (trained on the
    train split only).
 7. Gates for ``validated`` (all required): family-wise corrected lower bound > break-even,
    beats no-model baselines on its own trades, and walk-forward consistency (>= 2 of 3
    folds at or above break-even at the chosen threshold). Only validated models can be
    promoted (Registry.promote enforces it).
"""
from __future__ import annotations

import json
import logging
import time

import numpy as np

from ..config import ANALYSIS_PERIOD, DURATIONS, Settings
from ..db import DB
from ..engine import analysis as A
from ..engine import features as F
from ..engine.model import (DirectionModel, Registry, build_dataset, calibration_table, choose_threshold,
                            wilson_lb, z_for)

log = logging.getLogger("eo.trainer")
MIN_SAMPLES = 1500
REGIME_MIN_N = 50

# Candidate model specifications ("hypotheses"). Each tested spec counts toward the
# family-wise multiple-testing correction, so adding specs makes every gate stricter.
SPECS = {
    "base": {"features": "all", "params": {}},
    "shallow": {"features": "all", "params": {"max_depth": 2, "n_estimators": 300}},
    "no_structure": {"features": "no_structure", "params": {}},
    "trend_momentum": {"features": "trend_momentum", "params": {}},
    "regularised": {"features": "all", "params": {"min_child_weight": 20, "reg_lambda": 8.0, "subsample": 0.7}},
    # Phase 3: other local learners and explicit feature interactions
    "lightgbm": {"features": "all", "params": {}, "algo": "lightgbm"},
    "catboost": {"features": "all", "params": {}, "algo": "catboost"},
    "logistic": {"features": "all", "params": {}, "algo": "logistic"},
    "interactions": {"features": "all", "params": {}, "interactions": "core"},
    "structure_mtf": {"features": "structure_mtf", "params": {"max_depth": 2}},
}

# Interaction pairs (hypotheses about conditional effects, not blind indicator stacking):
# momentum only matters when the higher timeframe agrees; breaks of structure matter with
# activity; trend slope matters only when the trend is strong; FVG retests vs. oscillator state.
INTERACTIONS = {"core": [("ret6", "mtf_align"), ("ret3", "structure"), ("ema_slope", "adx"),
                         ("ret3", "atr_ratio"), ("macd_hist", "htf_trend"), ("bos", "activity_ratio"),
                         ("fvg_into", "rsi14"), ("sweep", "trend_up_frac")]}


def interaction_idx(name: str | None) -> list | None:
    if not name:
        return None
    return [(F.FEATURES.index(a), F.FEATURES.index(b)) for a, b in INTERACTIONS[name]]


def feature_idx(group: str) -> list[int] | None:
    from ..engine.structure import STRUCT_FEATURES
    names = F.FEATURES
    if group == "all":
        return None
    if group == "no_structure":
        keep = [f for f in names if f not in STRUCT_FEATURES]
    elif group == "structure_mtf":
        keep = ["ret3", "ret6", "atr_ratio", "adx", "ema_slope", "fvg_net10", "fvg_into", "structure", "bos",
                "choch", "htf_trend", "htf_rsi", "mtf_align", "sweep", "dist_hi20", "dist_lo20", "breakout"]
    elif group == "trend_momentum":
        keep = ["ret1", "ret3", "ret6", "ret12", "rsi14", "rsi7", "roc6", "stoch_k", "stoch_d", "streak",
                "ema_fast_slow", "ema_slope", "macd_hist", "adx", "di_diff", "trend_up_frac", "atr_ratio",
                "structure", "bos", "choch", "htf_trend", "htf_rsi", "mtf_align"]
    else:
        raise KeyError(group)
    return [names.index(f) for f in keep]


def _split(n: int, purge: int, frac: float = 0.7) -> tuple[slice, slice]:
    cut = int(n * frac)
    return slice(0, cut), slice(min(n, cut + purge), n)


def _acc(pred: np.ndarray, y: np.ndarray) -> dict:
    n = len(y)
    k = int((pred == y).sum())
    return {"n": n, "wins": k, "acc": k / n if n else None, "wilson_lb": wilson_lb(k, n)}


def strategy_predictions(X: np.ndarray) -> dict[str, np.ndarray]:
    """Alternative rule strategies evaluated on the same samples (1=up, 0=down, -1=abstain)."""
    idx = {f: i for i, f in enumerate(F.FEATURES)}
    out: dict[str, np.ndarray] = {}
    out["momentum_ret3"] = np.where(X[:, idx["ret3"]] > 0, 1, 0)
    out["mean_reversion_rsi"] = np.where(X[:, idx["rsi14"]] < 0, 1, 0)
    out["ema_trend"] = np.where(X[:, idx["ema_fast_slow"]] > 0, 1, 0)
    ens, per = [], {k: [] for k in A.FUNCS}
    for row in X:
        ev = A.evidence(dict(zip(F.FEATURES, row)))
        ens.append(A.ensemble(ev))
        for k in A.FUNCS:
            per[k].append(ev[k]["score"])
    ens = np.asarray(ens)
    out["specialist_ensemble"] = np.where(ens > 0, 1, np.where(ens < 0, 0, -1))
    for k, v in per.items():
        v = np.asarray(v)
        out[f"agent_{k}"] = np.where(v > 0.05, 1, np.where(v < -0.05, 0, -1))
    return out


def _reliability(p: np.ndarray, y: np.ndarray, bins: int = 10) -> list[dict]:
    out = []
    edges = np.linspace(0, 1, bins + 1)
    for a, b in zip(edges[:-1], edges[1:]):
        m = (p >= a) & (p < b if b < 1 else p <= b)
        if m.sum():
            out.append({"bin": [round(a, 2), round(b, 2)], "n": int(m.sum()), "mean_pred": float(p[m].mean()),
                        "freq_up": float(y[m].mean())})
    return out


def _feature_ref(X: np.ndarray) -> dict | None:
    if X is None or len(X) < 200:
        return None
    med = np.nanmedian(X, axis=0)
    mad = np.nanmedian(np.abs(X - med), axis=0) * 1.4826
    return {"median": [None if not np.isfinite(v) else float(v) for v in med],
            "scale": [None if not np.isfinite(v) or v <= 0 else float(v) for v in mad]}


def _features_hash() -> str:
    import hashlib
    return hashlib.sha256(",".join(F.FEATURES).encode()).hexdigest()[:12]


def _thr_acc(p: np.ndarray, y: np.ndarray, thr: float) -> tuple[int, int]:
    sel = np.abs(p - 0.5) >= thr
    return int(((p[sel] > 0.5).astype(int) == y[sel]).sum()), int(sel.sum())


def ledger_family(db: DB, settings: Settings, run_size: int) -> int:
    """Multiple-testing family = this run's hypotheses + every hypothesis tested in the last
    ``ledger_days`` (audit: 360 tests over 25 runs had been corrected only within each run)."""
    prior = db.one("SELECT count(*) n FROM hypothesis_ledger WHERE created_at > ?",
                   (time.time() - settings.ledger_days * 86400,))["n"]
    return max(1, run_size + prior)


def train_one(db: DB, registry: Registry, settings: Settings, market: dict, duration: int,
              source: str, bars: np.ndarray | None, family: int = 1, ds=None, spec: str = "base",
              proposer: str = "rule", rationale: str = "") -> dict:
    from ..engine.structure import regime
    from . import validation as V
    ds = ds if ds is not None else build_dataset(bars, duration, delay_s=settings.exec_delay_s)
    z = V.z_family(family)
    payout, breakeven = settings.payout_for(market["id"]), settings.breakeven_for(market["id"])
    required = breakeven + settings.cost_buffer
    res = {"market": market["id"], "duration": duration, "source": source, "samples": int(len(ds.y)), "spec": spec}
    if len(ds.y) < MIN_SAMPLES:
        res["status"] = f"insufficient data ({len(ds.y)} < {MIN_SAMPLES} samples)"
        return res
    sp = SPECS[spec]
    algo = sp.get("algo", "xgboost")
    fidx = feature_idx(sp["features"])
    P = ANALYSIS_PERIOD[duration]
    purge = duration // P + F.MIN_CANDLES

    inter = interaction_idx(sp.get("interactions"))
    wf = V.walk_forward(ds.X, ds.y, ds.ts, duration, purge, required, algo=algo, params=sp["params"],
                        feature_idx=fidx, interactions=inter)
    g = V.gates(wf, required, z, settings.min_validation_samples)
    model, thr = wf.model, (wf.threshold if g["validated"] else None)
    table = V.pooled_calibration(wf)

    calib = {}
    if wf.all_p is not None and len(wf.all_p):
        pc = np.clip(wf.all_p, 1e-6, 1 - 1e-6)
        yy = wf.all_y
        calib = {"brier": float(np.mean((wf.all_p - yy) ** 2)), "brier_baseline": float(np.mean((yy.mean() - yy) ** 2)),
                 "logloss": float(-np.mean(yy * np.log(pc) + (1 - yy) * np.log(1 - pc))),
                 "reliability": _reliability(wf.all_p, yy), "n_non_overlapping": int(len(yy))}

    # alternative strategies on exactly the same independent out-of-sample trades
    strategies, regime_stats, ev = {}, {}, None
    if wf.trades_n:
        for name, pred in strategy_predictions(wf.trade_X).items():
            m = pred >= 0
            strategies[name] = _acc(pred[m], wf.trade_y[m]) | {"coverage": float(m.mean())}
        strategies["model"] = _acc((wf.trade_p > 0.5).astype(int), wf.trade_y)
        for name, s_ in strategies.items():
            db.execute("INSERT INTO strategy_results(created_at,market,duration,strategy,n,wins,accuracy,wilson_lb,details)"
                       " VALUES(?,?,?,?,?,?,?,?,?)", (time.time(), market["id"], duration, f"{spec}:{name}", s_["n"],
                                                     s_["wins"], s_["acc"], s_["wilson_lb"],
                                                     json.dumps({"source": source, "spec": spec, **s_})))
        lb = g["lb"]
        ev = {"acc": wf.acc, "n": wf.trades_n, "payout": payout, "ev_per_unit": wf.acc * payout - (1 - wf.acc),
              "ev_per_unit_lb": lb * payout - (1 - lb), "required_accuracy": required,
              "note": "training labels drop exact ties; live ties (refunds) dilute EV per trade further"}
        regs = np.array([regime(dict(zip(F.FEATURES, row))) for row in wf.trade_X])
        hit = (wf.trade_p > 0.5).astype(int) == wf.trade_y
        for rg in np.unique(regs):
            m_ = regs == rg
            nr, ar = int(m_.sum()), float(hit[m_].mean())
            regime_stats[str(rg)] = {"n": nr, "acc": ar, "lb95": wilson_lb(int(hit[m_].sum()), nr),
                                     "blocked": nr >= REGIME_MIN_N and ar < breakeven}

    validated = bool(g["validated"])
    gate_note = None if validated else "; ".join(g["reasons"])
    metrics = {
        "protocol": "v3-walkforward-nonoverlap", "source": source, "spec": spec, "algo": algo, "params": sp["params"],
        "feature_group": sp["features"], "feature_idx": fidx, "interactions": inter,
        "exec_delay_s": settings.exec_delay_s,
        "train_samples": int(wf.folds[-1]["fit_samples"]) if wf.folds else 0,
        "test_samples": int(wf.trades_n), "data_range": [float(ds.ts[0]), float(ds.ts[-1])],
        "test_range": [wf.folds[0]["block"][0], wf.folds[-1]["block"][1]] if wf.folds else None,
        "test_accuracy": wf.acc, "calibration": table, "threshold": thr, "breakeven": breakeven, "payout": payout,
        "required_accuracy": required, "walk_forward": wf.folds, "fold_consistent": g["consistent"],
        "strategies": strategies,
        "baseline_check": {"passed": g["beats_baseline"], "best_baseline": g["best_baseline"], "model_gate_lb": g["lb"]},
        "z_gate": z, "family_size": family, "gates": g, "calibration_quality": calib, "expected_value": ev,
        "regime_stats": regime_stats, "validated": validated, "gate_note": gate_note,
        "features": F.FEATURES, "analysis_period": P,
        # out-of-distribution reference (robust per-feature centre/scale of the TRAINING samples only)
        "feature_ref": _feature_ref(ds.X[: int(wf.folds[-1]["fit_samples"])] if wf.folds else ds.X),
        "training_data": {"source": source, "samples": int(len(ds.y)), "bars_range": [float(ds.ts[0]), float(ds.ts[-1])],
                          "exec_delay_s": settings.exec_delay_s, "features_hash": _features_hash()},
    }

    champ = registry.champion(market["id"], duration)
    if champ is not None and champ[0]["metrics"].get("features") != F.FEATURES:
        registry.demote(champ[0]["id"], "feature set changed since training — retired, retraining required")
        db.event("warning", "model", f"سحب النموذج #{champ[0]['id']}: قائمة المؤشرات تغيّرت منذ تدريبه")
        champ = None
    if champ is not None and champ[0]["metrics"].get("protocol") != "v3-walkforward-nonoverlap":
        # validated under the old protocol (threshold chosen on its test window, overlapping n)
        registry.demote(champ[0]["id"], "validated under the pre-v3 protocol (selection bias / overlap) — retired")
        db.event("warning", "model", f"سحب النموذج #{champ[0]['id']}: اعتُمد ببروتوكول تحقق قديم ثبت انحيازه")
        champ = None
    decision, note = "rejected", gate_note or ""
    if validated:
        if champ is None or champ[0]["metrics"].get("source") != source:
            decision, note = "champion", f"validated ({spec}/{algo}): {wf.trades_wins}/{wf.trades_n} independent OOS trades"
        else:
            inc = champ[0]["metrics"].get("gates", {}).get("lb") or 0
            if (g["lb"] or 0) > inc:
                decision, note = "champion", f"challenger LB {g['lb']:.4f} > incumbent LB {inc:.4f}"
            else:
                note = "validated, but incumbent's lower bound is equal or better"
    metrics["promotion_note"] = note
    if model is not None:
        model.meta = metrics
    mid = registry.register(market["id"], duration, model, metrics, "candidate", note) if model is not None else None
    if decision == "champion":
        registry.promote(mid)
        db.event("info", "model", f"ترقية نموذج جديد {market['id']} {duration}ث ({spec}): {note}")
    elif mid is not None:
        db.execute("UPDATE models SET status='rejected' WHERE id=?", (mid,))
    db.execute("INSERT INTO hypothesis_ledger(created_at,market,duration,source,spec,algo,proposer,rationale,data_start,"
               "data_end,family,z,trades,wins,accuracy,lb,required,validated,outcome,reasons,model_id) "
               "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
               (time.time(), market["id"], duration, source, spec, algo, proposer, rationale[:300], float(ds.ts[0]),
                float(ds.ts[-1]), family, z, wf.trades_n, wf.trades_wins, wf.acc, g["lb"], required, int(validated),
                decision, json.dumps(g["reasons"], ensure_ascii=False), mid))
    res.update(status=decision, model_id=mid, note=note, test_accuracy=wf.acc, threshold=thr, validated=validated,
               trades=wf.trades_n, lb=g["lb"], brier=calib.get("brier"), brier_baseline=calib.get("brier_baseline"))
    return res


def pick_source(db: DB, market: dict) -> str | None:
    from ..markets import allowed_sources
    best, best_n = None, 0
    for src in allowed_sources(market):
        r = db.one("SELECT count(*) n FROM bars1s WHERE market=? AND source=?", (market["id"], src))
        if r["n"] > best_n:
            best, best_n = src, r["n"]
    return best


def retrain_all(db: DB, registry: Registry, settings: Settings, markets: list[dict] | None = None,
                specs: tuple[str, ...] = ("base",), progress=None, proposers: dict | None = None,
                rationales: dict | None = None) -> list[dict]:
    from ..markets import list_markets
    out, jobs = [], []
    for m in markets or list_markets(db, enabled_only=True):
        src = pick_source(db, m)
        if src is None:
            continue
        bars = np.asarray(db.bars(m["id"], src, 0), dtype=float)
        for d in DURATIONS:
            jobs.append((m, d, src, build_dataset(bars, d, delay_s=settings.exec_delay_s)))
    tested = [j for j in jobs if len(j[3].y) >= MIN_SAMPLES]
    family = ledger_family(db, settings, len(tested) * len(specs))
    total = len(jobs) * len(specs)
    done = 0
    for m, d, src, ds in jobs:
        for spec in specs:
            try:
                out.append(train_one(db, registry, settings, m, d, src, None, family=family, ds=ds, spec=spec,
                                     proposer=(proposers or {}).get(spec, "rule"),
                                     rationale=(rationales or {}).get(spec, "")))
            except Exception as e:  # one failure must not stop the others
                log.exception("training failed for %s %s %s", m["id"], d, spec)
                out.append({"market": m["id"], "duration": d, "spec": spec, "status": f"error: {e}"})
            done += 1
            if progress:
                progress(done, total, f"{m['id']} {d}s {spec}")
    from .validation import z_family
    db.kv_set("last_retrain", {"at": time.time(), "results": out, "family_size": family, "z_gate": z_family(family),
                               "specs": list(specs)})
    return out


def revalidate(registry: Registry, settings: Settings, model_row: dict, ds) -> tuple[bool, dict]:
    """Single-hypothesis check of an existing model on the most recent 30% of data."""
    meta = model_row["metrics"] if isinstance(model_row["metrics"], dict) else json.loads(model_row["metrics"] or "{}")
    thr = meta.get("threshold")
    if thr is None or len(ds.y) < MIN_SAMPLES:
        return False, {"reason": "no threshold or not enough data"}
    from .validation import non_overlapping, z_family
    m = DirectionModel.load(__import__("pathlib").Path(model_row["path"]))
    cut = int(len(ds.y) * 0.7)
    idx = np.arange(cut, len(ds.y))
    idx = idx[non_overlapping(ds.ts[idx], model_row["duration"])]     # independent trades only
    k, n = _thr_acc(m.predict(ds.X[idx]), ds.y[idx], thr)
    required = settings.breakeven_for(model_row["market"]) + settings.cost_buffer
    ok = n >= settings.min_validation_samples and wilson_lb(k, n, z_family(1)) > required
    return ok, {"n": n, "acc": k / n if n else None}


def check_live_degradation(db: DB, registry: Registry, settings: Settings, min_n: int = 100) -> list[str]:
    """Retire a champion whose LIVE accuracy is significantly below break-even, then try an
    automatic rollback to the most recent previous champion that still passes on recent data."""
    retired = []
    for r in db.all("SELECT id,market,duration FROM models WHERE status='champion'"):
        rows = db.all("SELECT status FROM signals WHERE model_id=? AND decision!='WAIT' AND status IN ('win','loss') "
                      "ORDER BY created_at DESC LIMIT 300", (r["id"],))
        n = len(rows)
        if n < min_n:
            continue
        w = sum(1 for x in rows if x["status"] == "win")
        ub = 1 - wilson_lb(n - w, n)     # upper bound of 95% interval below break-even → clearly losing
        if ub < settings.breakeven_for(r["market"]):
            registry.demote(r["id"], f"live accuracy {w/n:.3f} on {n}, upper bound {ub:.3f} < break-even")
            db.event("warning", "model", f"سحب النموذج {r['market']} {r['duration']}ث: أداء حي أقل من التعادل")
            retired.append(f"{r['market']}:{r['duration']}")
            auto_rollback(db, registry, settings, r["market"], r["duration"], exclude=r["id"])
    return retired


def auto_rollback(db: DB, registry: Registry, settings: Settings, market: str, duration: int,
                  exclude: int | None = None) -> int | None:
    from ..markets import get_market
    m = get_market(db, market)
    src = pick_source(db, m) if m else None
    if src is None:
        return None
    ds = build_dataset(np.asarray(db.bars(market, src, 0), dtype=float), duration, delay_s=settings.exec_delay_s)
    for row in db.all("SELECT * FROM models WHERE market=? AND duration=? AND status='retired' AND promoted_at IS NOT NULL "
                      "AND id != ? ORDER BY promoted_at DESC LIMIT 5", (market, duration, exclude or -1)):
        meta = json.loads(row["metrics"] or "{}")
        if not meta.get("validated") or meta.get("source") != src:
            continue
        ok, info = revalidate(registry, settings, row, ds)
        if ok:
            registry.promote(row["id"])
            db.event("warning", "model", f"استعادة تلقائية للنموذج #{row['id']} {market} {duration}ث بعد إعادة تحقق ناجحة")
            return row["id"]
    return None
