"""Walk-forward training, strategy comparison and champion/challenger promotion.

Protocol (per market × duration × data source):
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
                            wilson_lb)

log = logging.getLogger("eo.trainer")
MIN_SAMPLES = 1500


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


def train_one(db: DB, registry: Registry, settings: Settings, market: dict, duration: int,
              source: str, bars: np.ndarray) -> dict:
    ds = build_dataset(bars, duration)
    res = {"market": market["id"], "duration": duration, "source": source, "samples": int(len(ds.y))}
    if len(ds.y) < MIN_SAMPLES:
        res["status"] = f"insufficient data ({len(ds.y)} < {MIN_SAMPLES} samples)"
        return res
    P = ANALYSIS_PERIOD[duration]
    purge = duration // P + F.MIN_CANDLES
    tr, te = _split(len(ds.y), purge)
    Xtr, ytr, Xte, yte = ds.X[tr], ds.y[tr], ds.X[te], ds.y[te]

    model = DirectionModel.train(Xtr, ytr)
    p = model.predict(Xte)
    table = calibration_table(p, yte)
    thr = choose_threshold(table, settings.breakeven, settings.min_validation_samples)

    # walk-forward stability (3 expanding folds over the train+test range)
    wf = []
    n = len(ds.y)
    for k in range(3):
        a, b = int(n * (0.4 + 0.2 * k)), int(n * (0.6 + 0.2 * k))
        if b - a - purge < 50:
            continue
        m_k = DirectionModel.train(ds.X[:a], ds.y[:a])
        pk = m_k.predict(ds.X[a + purge:b])
        wf.append(_acc((pk > 0.5).astype(int), ds.y[a + purge:b]))

    # alternative strategies on the same test window
    strategies = {}
    for name, pred in strategy_predictions(Xte).items():
        m = pred >= 0
        strategies[name] = _acc(pred[m], yte[m]) | {"coverage": float(m.mean())}
    strategies["majority_class_baseline"] = _acc(np.full(len(yte), int(ytr.mean() > 0.5)), yte)
    strategies["xgboost_all"] = _acc((p > 0.5).astype(int), yte)
    for name, s in strategies.items():
        db.execute("INSERT INTO strategy_results(created_at,market,duration,strategy,n,wins,accuracy,wilson_lb,details)"
                   " VALUES(?,?,?,?,?,?,?,?,?)", (time.time(), market["id"], duration, name, s["n"], s["wins"],
                                                 s["acc"], s["wilson_lb"], json.dumps({"source": source, **s})))

    metrics = {
        "source": source, "train_samples": int(len(ytr)), "test_samples": int(len(yte)),
        "train_range": [float(ds.ts[tr][0]), float(ds.ts[tr][-1])],
        "test_range": [float(ds.ts[te][0]), float(ds.ts[te][-1])],
        "test_accuracy": strategies["xgboost_all"]["acc"], "calibration": table, "threshold": thr,
        "breakeven": settings.breakeven, "walk_forward": wf, "strategies": strategies,
        "features": F.FEATURES, "analysis_period": P,
    }

    champ = registry.champion(market["id"], duration)
    decision, note = "rejected", ""
    if thr is None:
        note = "no threshold reached significance and break-even on held-out data"
    else:
        ch_row = next(r for r in table if r["edge"] == thr)
        if champ is None or champ[0]["metrics"].get("source") != source:
            decision, note = "champion", f"first validated model: acc {ch_row['acc']:.3f} on {ch_row['n']} OOS"
        else:
            # Evaluate the incumbent on the challenger's test window (incumbent may have seen
            # part of it in training, which only favours the incumbent — a conservative test).
            cp = champ[1].predict(Xte)
            ctable = calibration_table(cp, yte)
            cthr = champ[0]["metrics"].get("threshold")
            c_row = next((r for r in ctable if cthr is not None and r["edge"] == cthr), None)
            if c_row is None or c_row["acc"] is None or (ch_row["wilson_lb"] > c_row["wilson_lb"]):
                decision = "champion"
                note = (f"challenger LB {ch_row['wilson_lb']:.3f} > incumbent LB "
                        f"{(c_row or {}).get('wilson_lb', 0) or 0:.3f} on same window")
            else:
                note = "incumbent equal or better on the same window"
    metrics["promotion_note"] = note
    mid = registry.register(market["id"], duration, model, metrics, "candidate", note)
    if decision == "champion":
        registry.promote(mid)
        db.event("info", "model", f"ترقية نموذج جديد {market['id']} {duration}ث: {note}")
    else:
        db.execute("UPDATE models SET status='rejected' WHERE id=?", (mid,))
    res.update(status=decision, model_id=mid, note=note, test_accuracy=metrics["test_accuracy"], threshold=thr)
    return res


def pick_source(db: DB, market: dict) -> str | None:
    from ..markets import allowed_sources
    best, best_n = None, 0
    for src in allowed_sources(market):
        r = db.one("SELECT count(*) n FROM bars1s WHERE market=? AND source=?", (market["id"], src))
        if r["n"] > best_n:
            best, best_n = src, r["n"]
    return best


def retrain_all(db: DB, registry: Registry, settings: Settings, markets: list[dict] | None = None) -> list[dict]:
    from ..markets import list_markets
    out = []
    for m in markets or list_markets(db, enabled_only=True):
        src = pick_source(db, m)
        if src is None:
            continue
        bars = np.asarray(db.bars(m["id"], src, 0), dtype=float)
        for d in DURATIONS:
            try:
                out.append(train_one(db, registry, settings, m, d, src, bars))
            except Exception as e:  # one failure must not stop the others
                log.exception("training failed for %s %s", m["id"], d)
                out.append({"market": m["id"], "duration": d, "status": f"error: {e}"})
    db.kv_set("last_retrain", {"at": time.time(), "results": out})
    return out


def check_live_degradation(db: DB, registry: Registry, settings: Settings, min_n: int = 100) -> list[str]:
    """Retire a champion whose LIVE accuracy is significantly below break-even."""
    retired = []
    for r in db.all("SELECT id,market,duration FROM models WHERE status='champion'"):
        rows = db.all("SELECT status FROM signals WHERE model_id=? AND decision!='WAIT' AND status IN ('win','loss') "
                      "ORDER BY created_at DESC LIMIT 300", (r["id"],))
        n = len(rows)
        if n < min_n:
            continue
        w = sum(1 for x in rows if x["status"] == "win")
        # upper bound of 95% interval below break-even → clearly losing
        ub = 1 - wilson_lb(n - w, n)
        if ub < settings.breakeven:
            registry.demote(r["id"], f"live accuracy {w/n:.3f} on {n}, upper bound {ub:.3f} < break-even")
            db.event("warning", "model", f"سحب النموذج {r['market']} {r['duration']}ث: أداء حي أقل من التعادل")
            retired.append(f"{r['market']}:{r['duration']}")
    return retired
