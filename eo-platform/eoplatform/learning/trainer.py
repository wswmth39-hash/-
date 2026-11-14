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
}


def feature_idx(group: str) -> list[int] | None:
    from ..engine.structure import STRUCT_FEATURES
    names = F.FEATURES
    if group == "all":
        return None
    if group == "no_structure":
        keep = [f for f in names if f not in STRUCT_FEATURES]
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


def _thr_acc(p: np.ndarray, y: np.ndarray, thr: float) -> tuple[int, int]:
    sel = np.abs(p - 0.5) >= thr
    return int(((p[sel] > 0.5).astype(int) == y[sel]).sum()), int(sel.sum())


def train_one(db: DB, registry: Registry, settings: Settings, market: dict, duration: int,
              source: str, bars: np.ndarray | None, family: int = 1, ds=None, spec: str = "base") -> dict:
    from ..engine.structure import regime
    ds = ds if ds is not None else build_dataset(bars, duration)
    z = z_for(family)
    res = {"market": market["id"], "duration": duration, "source": source, "samples": int(len(ds.y)), "spec": spec}
    if len(ds.y) < MIN_SAMPLES:
        res["status"] = f"insufficient data ({len(ds.y)} < {MIN_SAMPLES} samples)"
        return res
    sp = SPECS[spec]
    fidx = feature_idx(sp["features"])
    P = ANALYSIS_PERIOD[duration]
    purge = duration // P + F.MIN_CANDLES
    tr, te = _split(len(ds.y), purge)
    Xtr, ytr, Xte, yte = ds.X[tr], ds.y[tr], ds.X[te], ds.y[te]

    model = DirectionModel.train(Xtr, ytr, params=sp["params"], feature_idx=fidx)
    p = model.predict(Xte)
    table = calibration_table(p, yte)
    thr = choose_threshold(table, settings.breakeven, settings.min_validation_samples, z)
    gate_note = None if thr is not None else "no threshold reached significance and break-even on held-out data"

    # calibration quality of the raw probabilities (reported; confidence shown to users stays empirical)
    pc = np.clip(p, 1e-6, 1 - 1e-6)
    calib = {"brier": float(np.mean((p - yte) ** 2)), "brier_baseline": float(np.mean((ytr.mean() - yte) ** 2)),
             "logloss": float(-np.mean(yte * np.log(pc) + (1 - yte) * np.log(1 - pc))),
             "reliability": _reliability(p, yte)}

    # walk-forward stability (3 expanding folds, purged); also measured AT the chosen threshold
    wf = []
    n = len(ds.y)
    for k in range(3):
        a, b = int(n * (0.4 + 0.2 * k)), int(n * (0.6 + 0.2 * k))
        if b - a - purge < 50:
            continue
        m_k = DirectionModel.train(ds.X[:a], ds.y[:a], params=sp["params"], feature_idx=fidx)
        pk = m_k.predict(ds.X[a + purge:b])
        fold = _acc((pk > 0.5).astype(int), ds.y[a + purge:b])
        if thr is not None:
            kk, nn_ = _thr_acc(pk, ds.y[a + purge:b], thr)
            fold.update(thr_n=nn_, thr_acc=kk / nn_ if nn_ else None)
        wf.append(fold)
    fold_ok = None
    if thr is not None:
        good = sum(1 for f in wf if f.get("thr_n", 0) >= 30 and f["thr_acc"] is not None
                   and f["thr_acc"] >= settings.breakeven)
        fold_ok = good >= 2
        if not fold_ok:
            gate_note = f"walk-forward inconsistent: only {good} of {len(wf)} folds at/above break-even"
            thr = None

    # alternative strategies on the same test window (reported for comparison)
    strategies = {}
    for name, pred in strategy_predictions(Xte).items():
        m = pred >= 0
        strategies[name] = _acc(pred[m], yte[m]) | {"coverage": float(m.mean())}
    strategies["majority_class_baseline"] = _acc(np.full(len(yte), int(ytr.mean() > 0.5)), yte)
    strategies["xgboost_all"] = _acc((p > 0.5).astype(int), yte)

    # baseline gate on exactly the trades the model would take
    baseline_check = None
    ev = None
    regime_stats = {}
    if thr is not None:
        sel = np.abs(p - 0.5) >= thr
        k, n_sel = int(((p[sel] > 0.5).astype(int) == yte[sel]).sum()), int(sel.sum())
        model_lb = wilson_lb(k, n_sel, z)
        base = {"majority_class": float((np.full(n_sel, int(ytr.mean() > 0.5)) == yte[sel]).mean()),
                "chance": 0.5}
        best_name = max(base, key=base.get)
        baseline_check = {"model_gate_lb": model_lb, "baselines": base, "best_baseline": best_name,
                          "passed": model_lb > base[best_name]}
        acc_sel = k / n_sel
        ev = {"acc": acc_sel, "n": n_sel, "ev_per_unit": acc_sel * settings.payout - (1 - acc_sel),
              "ev_per_unit_lb": model_lb * settings.payout - (1 - model_lb)}
        # regime breakdown of the trades it would take (blocks regimes that lost on held-out data)
        regs = np.array([regime(dict(zip(F.FEATURES, row))) for row in Xte[sel]])
        hit = (p[sel] > 0.5).astype(int) == yte[sel]
        for rg in np.unique(regs):
            m_ = regs == rg
            nr = int(m_.sum())
            ar = float(hit[m_].mean())
            regime_stats[str(rg)] = {"n": nr, "acc": ar, "blocked": nr >= REGIME_MIN_N and ar < settings.breakeven}
        if not baseline_check["passed"]:
            gate_note = "does not beat the no-model baselines on its own trades"
            thr = None
    for name, s_ in strategies.items():
        db.execute("INSERT INTO strategy_results(created_at,market,duration,strategy,n,wins,accuracy,wilson_lb,details)"
                   " VALUES(?,?,?,?,?,?,?,?,?)", (time.time(), market["id"], duration, name, s_["n"], s_["wins"],
                                                 s_["acc"], s_["wilson_lb"], json.dumps({"source": source, **s_})))

    validated = thr is not None
    metrics = {
        "source": source, "spec": spec, "params": sp["params"], "feature_group": sp["features"],
        "feature_idx": fidx, "train_samples": int(len(ytr)), "test_samples": int(len(yte)),
        "train_range": [float(ds.ts[tr][0]), float(ds.ts[tr][-1])],
        "test_range": [float(ds.ts[te][0]), float(ds.ts[te][-1])],
        "test_accuracy": strategies["xgboost_all"]["acc"], "calibration": table, "threshold": thr,
        "breakeven": settings.breakeven, "walk_forward": wf, "fold_consistent": fold_ok,
        "strategies": strategies, "baseline_check": baseline_check, "z_gate": z, "family_size": family,
        "calibration_quality": calib, "expected_value": ev, "regime_stats": regime_stats,
        "validated": validated, "gate_note": gate_note, "features": F.FEATURES, "analysis_period": P,
    }

    champ = registry.champion(market["id"], duration)
    if champ is not None and champ[0]["metrics"].get("features") != F.FEATURES:
        # Found in production: a champion trained on the previous 37-feature layout crashed
        # re-validation (37 vs 45 columns). It cannot be scored on current features: retire it.
        registry.demote(champ[0]["id"], "feature set changed since training — retired, retraining required")
        db.event("warning", "model", f"سحب النموذج #{champ[0]['id']}: قائمة المؤشرات تغيّرت منذ تدريبه")
        champ = None
    # The incumbent must keep passing the CURRENT gate on the NEWEST held-out window.
    if champ is not None and champ[0]["metrics"].get("source") == source:
        cthr = champ[0]["metrics"].get("threshold")
        ctab = calibration_table(champ[1].predict(Xte), yte)
        crow = next((r for r in ctab if cthr is not None and r["edge"] == cthr), None)
        ok = bool(crow and crow["n"] >= settings.min_validation_samples
                  and wilson_lb(crow["wins"], crow["n"], z) > settings.breakeven)
        if not ok:
            why = (f"failed re-validation on newest window (family-wise z={z:.2f}): "
                   f"acc {crow['acc'] if crow else None} on {crow['n'] if crow else 0}")
            registry.demote(champ[0]["id"], why)
            db.event("warning", "model", f"سحب النموذج #{champ[0]['id']} {market['id']} {duration}ث: لم يجتز إعادة التحقق")
            champ = None
    decision, note = "rejected", gate_note or ""
    if validated:
        ch_row = next(r for r in table if r["edge"] == thr)
        if champ is None or champ[0]["metrics"].get("source") != source:
            decision, note = "champion", f"first validated model ({spec}): acc {ch_row['acc']:.3f} on {ch_row['n']} OOS"
        else:
            cp = champ[1].predict(Xte)
            ctable = calibration_table(cp, yte)
            cthr = champ[0]["metrics"].get("threshold")
            c_row = next((r for r in ctable if cthr is not None and r["edge"] == cthr), None)
            if c_row is None or c_row["acc"] is None or (ch_row["wilson_lb"] > c_row["wilson_lb"]):
                decision = "champion"
                note = (f"challenger ({spec}) LB {ch_row['wilson_lb']:.3f} > incumbent LB "
                        f"{(c_row or {}).get('wilson_lb', 0) or 0:.3f} on same window")
            else:
                note = "validated, but incumbent equal or better on the same window"
    metrics["promotion_note"] = note
    mid = registry.register(market["id"], duration, model, metrics, "candidate", note)
    if decision == "champion":
        registry.promote(mid)
        db.event("info", "model", f"ترقية نموذج جديد {market['id']} {duration}ث ({spec}): {note}")
    else:
        db.execute("UPDATE models SET status='rejected' WHERE id=?", (mid,))
    res.update(status=decision, model_id=mid, note=note, test_accuracy=metrics["test_accuracy"], threshold=thr,
               validated=validated, brier=calib["brier"], brier_baseline=calib["brier_baseline"])
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
                specs: tuple[str, ...] = ("base",), progress=None) -> list[dict]:
    from ..markets import list_markets
    out, jobs = [], []
    for m in markets or list_markets(db, enabled_only=True):
        src = pick_source(db, m)
        if src is None:
            continue
        bars = np.asarray(db.bars(m["id"], src, 0), dtype=float)
        for d in DURATIONS:
            jobs.append((m, d, src, build_dataset(bars, d)))
    tested = [j for j in jobs if len(j[3].y) >= MIN_SAMPLES]
    family = len(tested) * len(specs)          # every (market, duration, spec) is one hypothesis
    total = len(jobs) * len(specs)
    done = 0
    for m, d, src, ds in jobs:
        for spec in specs:
            try:
                out.append(train_one(db, registry, settings, m, d, src, None, family=family, ds=ds, spec=spec))
            except Exception as e:  # one failure must not stop the others
                log.exception("training failed for %s %s %s", m["id"], d, spec)
                out.append({"market": m["id"], "duration": d, "spec": spec, "status": f"error: {e}"})
            done += 1
            if progress:
                progress(done, total, f"{m['id']} {d}s {spec}")
    db.kv_set("last_retrain", {"at": time.time(), "results": out, "family_size": family, "z_gate": z_for(family),
                               "specs": list(specs)})
    return out


def revalidate(registry: Registry, settings: Settings, model_row: dict, ds) -> tuple[bool, dict]:
    """Single-hypothesis check of an existing model on the most recent 30% of data."""
    meta = model_row["metrics"] if isinstance(model_row["metrics"], dict) else json.loads(model_row["metrics"] or "{}")
    thr = meta.get("threshold")
    if thr is None or len(ds.y) < MIN_SAMPLES:
        return False, {"reason": "no threshold or not enough data"}
    m = DirectionModel.load(__import__("pathlib").Path(model_row["path"]))
    cut = int(len(ds.y) * 0.7)
    k, n = _thr_acc(m.predict(ds.X[cut:]), ds.y[cut:], thr)
    ok = n >= settings.min_validation_samples and wilson_lb(k, n, z_for(1)) > settings.breakeven
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
        if ub < settings.breakeven:
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
    ds = build_dataset(np.asarray(db.bars(market, src, 0), dtype=float), duration)
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
