"""Validation protocol v3 (Phase 3) — built from the measured causes of the Phase-2 failure.

Audit findings it addresses (docs/AUDIT_PHASE3.md):
 1. Selection bias: the trading threshold used to be chosen ON the test window, and hundreds
    of hypotheses were tested on the same data across runs. → the threshold is now chosen on
    an inner validation split of each fold's PAST; the test block is only scored once; the
    multiple-testing family spans every test recorded in the ledger over a rolling window.
 2. Overlapping labels: one sample per analysis candle with a longer horizon shares outcomes,
    overstating the independent sample size ~3×. → every statistic used by a gate is computed
    on NON-OVERLAPPING trades (entries at least `duration` apart).
 3. Realism: entry happens ``exec_delay_s`` after the candle closes (labels built that way);
    the required accuracy is break-even + a cost buffer for quote differences.

Protocol (strictly chronological):
    data:  |-------- past (training only) --------|  test block 1 | 2 | 3 | 4  |   (last 50 %)
    fold k: fit on [0, inner_start − purge), choose threshold on inner [inner_start, a_k − purge),
            score block k once (non-overlapping trades, selected by that threshold).
Pooled over the 4 blocks, every scored trade is genuinely out-of-sample.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from statistics import NormalDist

import numpy as np

from ..engine.model import EDGES, DirectionModel, calibration_table, wilson_lb

K_FOLDS = 4
TEST_FRAC = 0.5
INNER_FRAC = 0.25
MIN_INNER_TRADES = 60
MIN_FOLD_TRADES = 15


def z_family(family: int) -> float:
    """One-sided 97.5 % split over ``family`` independent hypotheses (Bonferroni)."""
    return NormalDist().inv_cdf(1 - 0.025 / max(1, family))


def non_overlapping(ts: np.ndarray, horizon: int) -> np.ndarray:
    """Indices of a greedy subsequence whose entries are at least ``horizon`` seconds apart."""
    keep, last = [], -math.inf
    for i, t in enumerate(ts):
        if t - last >= horizon:
            keep.append(i)
            last = t
    return np.asarray(keep, dtype=int)


def choose_inner_threshold(p: np.ndarray, y: np.ndarray, required: float) -> float | None:
    """Smallest strength edge whose INNER-validation accuracy reaches the required accuracy."""
    for e in EDGES:
        sel = np.abs(p - 0.5) >= e
        n = int(sel.sum())
        if n < MIN_INNER_TRADES:
            break
        if ((p[sel] > 0.5).astype(int) == y[sel]).mean() >= required:
            return e
    return None


@dataclass
class WFResult:
    folds: list = field(default_factory=list)
    trades_n: int = 0
    trades_wins: int = 0
    trade_p: np.ndarray | None = None       # model p_up of the pooled selected trades
    trade_y: np.ndarray | None = None
    trade_X: np.ndarray | None = None
    all_p: np.ndarray | None = None         # pooled non-overlapping test predictions (all, for calibration)
    all_y: np.ndarray | None = None
    model: DirectionModel | None = None     # last fold's model = the one that would be deployed
    threshold: float | None = None          # last fold's inner-chosen threshold
    majority_baseline: float | None = None

    @property
    def acc(self):
        return self.trades_wins / self.trades_n if self.trades_n else None


def walk_forward(X: np.ndarray, y: np.ndarray, ts: np.ndarray, duration: int, purge: int, required: float,
                 algo: str = "xgboost", params: dict | None = None, feature_idx=None,
                 interactions=None) -> WFResult:
    n = len(y)
    bounds = np.linspace(int(n * (1 - TEST_FRAC)), n, K_FOLDS + 1).astype(int)
    r = WFResult()
    tp, ty, tx, ap, ay, maj = [], [], [], [], [], []
    for k in range(K_FOLDS):
        a, b = bounds[k], bounds[k + 1]
        train_end = a - purge
        inner_start = int(train_end * (1 - INNER_FRAC))
        fit_end = inner_start - purge
        if fit_end < 200 or b - a < 50:
            continue
        model = DirectionModel.train(X[:fit_end], y[:fit_end], params=params, feature_idx=feature_idx, algo=algo,
                                     interactions=interactions)
        # inner validation (non-overlapping) → threshold
        ii = np.arange(inner_start, train_end)
        ii = ii[non_overlapping(ts[ii], duration)]
        thr = choose_inner_threshold(model.predict(X[ii]), y[ii], required) if len(ii) else None
        # test block, non-overlapping, scored once
        ti = np.arange(a, b)
        ti = ti[non_overlapping(ts[ti], duration)]
        pt = model.predict(X[ti])
        ap.append(pt)
        ay.append(y[ti])
        f = {"block": [float(ts[a]), float(ts[b - 1])], "fit_samples": int(fit_end), "threshold": thr,
             "test_trades_available": int(len(ti))}
        if thr is not None:
            sel = np.abs(pt - 0.5) >= thr
            hits = ((pt[sel] > 0.5).astype(int) == y[ti][sel])
            f.update(n=int(sel.sum()), wins=int(hits.sum()), acc=float(hits.mean()) if sel.any() else None)
            tp.append(pt[sel])
            ty.append(y[ti][sel])
            tx.append(X[ti][sel])
            maj.append(np.full(int(sel.sum()), int(y[:fit_end].mean() > 0.5)))
        else:
            f.update(n=0, wins=0, acc=None, note="abstained: no threshold reached the required accuracy on inner validation")
        r.folds.append(f)
        r.model, r.threshold = model, thr
    if tp:
        r.trade_p, r.trade_y, r.trade_X = np.concatenate(tp), np.concatenate(ty), np.concatenate(tx)
        r.trades_n, r.trades_wins = int(len(r.trade_y)), int(((r.trade_p > 0.5).astype(int) == r.trade_y).sum())
        mj = np.concatenate(maj)
        r.majority_baseline = float((mj == r.trade_y).mean()) if len(mj) else None
    if ap:
        r.all_p, r.all_y = np.concatenate(ap), np.concatenate(ay)
    return r


def gates(r: WFResult, required: float, z: float, min_trades: int) -> dict:
    """All conditions for 'validated'. Returns the verdict and every number behind it."""
    out = {"required_accuracy": required, "z": z, "trades": r.trades_n, "wins": r.trades_wins,
           "accuracy": r.acc, "lb": wilson_lb(r.trades_wins, r.trades_n, z) if r.trades_n else None}
    traded = [f for f in r.folds if f.get("n", 0) >= MIN_FOLD_TRADES]
    good = [f for f in traded if f["acc"] >= required]
    out["folds_traded"], out["folds_at_or_above_required"] = len(traded), len(good)
    out["consistent"] = len(traded) >= 3 and len(good) >= len(traded) - 1
    base = max(0.5, r.majority_baseline or 0.0)
    out["best_baseline"] = base
    out["beats_baseline"] = bool(out["lb"] is not None and out["lb"] > base)
    reasons = []
    if r.trades_n < min_trades:
        reasons.append(f"only {r.trades_n} independent out-of-sample trades (< {min_trades})")
    if out["lb"] is None or out["lb"] <= required:
        reasons.append(f"lower bound {out['lb'] if out['lb'] is None else round(out['lb'], 4)} ≤ required {required:.4f}")
    if not out["consistent"]:
        reasons.append(f"walk-forward inconsistent ({len(good)}/{len(traded)} trading folds at/above required)")
    if not out["beats_baseline"]:
        reasons.append("does not beat the no-model baseline")
    out["validated"] = not reasons
    out["reasons"] = reasons
    return out


def pooled_calibration(r: WFResult) -> list[dict]:
    if r.all_p is None:
        return []
    return calibration_table(r.all_p, r.all_y)
