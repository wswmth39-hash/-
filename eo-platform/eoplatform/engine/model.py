"""XGBoost direction model + honest out-of-sample calibration.

Confidence shown to the user is NEVER the raw model probability. It is the
accuracy the model achieved on held-out, later-in-time data for predictions at
least as strong as the current one, together with the sample size and a 95%
Wilson lower bound. If that evidence is insufficient the engine says so and
returns WAIT.
"""
from __future__ import annotations

import json
import math
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import xgboost as xgb

from ..config import ANALYSIS_PERIOD
from ..data.hub import resample
from . import features as F

EDGES = [0.0, 0.02, 0.05, 0.08, 0.12, 0.18]
# Promotion requires the lower confidence bound to beat break-even after a Bonferroni
# correction for searching len(EDGES) thresholds (one-sided alpha 0.025/6 -> z≈2.64).
# Measured: the uncorrected rule (LB>50% & acc>=break-even) promoted models trained on a
# pure random walk in 3/24 trials; this rule in 0/24, while still finding a planted edge 8/8.
Z_GATE = 2.64


def z_for(family: int) -> float:
    """Family-wise z: one-sided alpha 0.025 split over len(EDGES) thresholds × ``family``
    market/duration models trained in the same run (Bonferroni). Measured on real data:
    1 of 12 models passed the per-model gate with LB 56.3% vs break-even 55.6% — a
    result that a run of 12 tries produces by chance far too often."""
    from statistics import NormalDist
    return max(Z_GATE, NormalDist().inv_cdf(1 - 0.025 / (len(EDGES) * max(1, family))))


def wilson_lb(k: int, n: int, z: float = 1.96) -> float:
    if n == 0:
        return 0.0
    p = k / n
    d = 1 + z * z / n
    return (p + z * z / (2 * n) - z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d


def binom_p_greater(k: int, n: int, p0: float = 0.5) -> float:
    """One-sided normal-approx p-value for accuracy > p0."""
    if n == 0:
        return 1.0
    z = (k - n * p0) / math.sqrt(n * p0 * (1 - p0))
    return 0.5 * math.erfc(z / math.sqrt(2))


@dataclass
class Dataset:
    X: np.ndarray
    y: np.ndarray
    ts: np.ndarray
    entry: np.ndarray


def build_dataset(bars: np.ndarray, duration: int) -> Dataset:
    """Samples at every analysis-candle close: features up to that candle, label =
    did the close `duration` seconds later end above (1) or below (0). Equal → dropped."""
    P = ANALYSIS_PERIOD[duration]
    steps = duration // P
    c = resample(bars, P)
    if len(c) < F.MIN_CANDLES + steps + 10:
        return Dataset(np.empty((0, len(F.FEATURES))), np.empty(0), np.empty(0), np.empty(0))
    feats = F.compute(c).to_numpy()
    ok = F.contiguous(c, P)
    idx = np.arange(len(c) - steps)
    j = idx + steps
    valid = ok[idx] & (c[j, 0] - c[idx, 0] == duration) & (c[j, 4] != c[idx, 4]) & ~np.isnan(feats[idx]).any(axis=1)
    idx = idx[valid]
    y = (c[idx + steps, 4] > c[idx, 4]).astype(int)
    return Dataset(feats[idx], y, c[idx, 0] + P, c[idx, 4])


def calibration_table(p_up: np.ndarray, y: np.ndarray) -> list[dict]:
    pred = (p_up > 0.5).astype(int)
    strength = np.abs(p_up - 0.5)
    rows = []
    for e in EDGES:
        m = strength >= e
        n = int(m.sum())
        k = int((pred[m] == y[m]).sum())
        rows.append({"edge": e, "n": n, "wins": k, "acc": (k / n) if n else None,
                     "wilson_lb": wilson_lb(k, n), "gate_lb": wilson_lb(k, n, Z_GATE),
                     "p_value": binom_p_greater(k, n)})
    return rows


def choose_threshold(table: list[dict], breakeven: float, min_n: int, z: float = Z_GATE) -> float | None:
    """Smallest strength edge whose held-out accuracy is above the payout break-even with
    multiple-comparison-corrected confidence, on enough samples. None = never trade."""
    for row in table:
        if row["n"] >= min_n and row["acc"] is not None and wilson_lb(row["wins"], row["n"], z) > breakeven:
            return row["edge"]
    return None


class DirectionModel:
    def __init__(self, booster: xgb.Booster | None = None, meta: dict | None = None):
        self.booster = booster
        self.meta = meta or {}

    @staticmethod
    def train(X: np.ndarray, y: np.ndarray, seed: int = 7) -> "DirectionModel":
        clf = xgb.XGBClassifier(n_estimators=250, max_depth=3, learning_rate=0.05, subsample=0.8,
                                colsample_bytree=0.8, min_child_weight=5, reg_lambda=2.0,
                                eval_metric="logloss", random_state=seed, n_jobs=2, tree_method="hist")
        clf.fit(X, y)
        return DirectionModel(clf.get_booster())

    def predict(self, X: np.ndarray) -> np.ndarray:
        d = xgb.DMatrix(np.atleast_2d(X), feature_names=None)
        return self.booster.predict(d)

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.booster.save_model(str(path))
        path.with_suffix(".meta.json").write_text(json.dumps(self.meta, default=str))

    @staticmethod
    def load(path: Path) -> "DirectionModel":
        b = xgb.Booster()
        b.load_model(str(path))
        meta_p = path.with_suffix(".meta.json")
        return DirectionModel(b, json.loads(meta_p.read_text()) if meta_p.exists() else {})


def confidence_for(meta: dict, p_up: float) -> dict | None:
    """Validated OOS accuracy for predictions at least as strong as p_up."""
    table = meta.get("calibration") or []
    s = abs(p_up - 0.5)
    best = None
    for row in table:
        if s >= row["edge"] and row["n"]:
            best = row
    return best


class Registry:
    """Champion model per (market, duration), cached in memory."""

    def __init__(self, db, model_dir: Path):
        self.db, self.model_dir = db, Path(model_dir)
        self._cache: dict[int, DirectionModel] = {}

    def champion(self, market: str, duration: int) -> tuple[dict, DirectionModel] | None:
        row = self.db.one("SELECT * FROM models WHERE market=? AND duration=? AND status='champion' "
                          "ORDER BY promoted_at DESC LIMIT 1", (market, duration))
        if not row:
            return None
        m = self._cache.get(row["id"])
        if m is None:
            try:
                m = DirectionModel.load(Path(row["path"]))
            except Exception:
                return None
            self._cache[row["id"]] = m
        row["metrics"] = json.loads(row["metrics"] or "{}")
        return row, m

    def register(self, market: str, duration: int, model: DirectionModel, metrics: dict, status: str,
                 note: str = "") -> int:
        cur = self.db.execute(
            "INSERT INTO models(market,duration,created_at,algo,metrics,status,note) VALUES(?,?,?,?,?,?,?)",
            (market, duration, time.time(), "xgboost", json.dumps(metrics, default=float), status, note))
        mid = cur.lastrowid
        path = self.model_dir / f"{market}_{duration}_{mid}.ubj"
        model.meta = metrics
        model.save(path)
        self.db.execute("UPDATE models SET path=? WHERE id=?", (str(path), mid))
        return mid

    def promote(self, model_id: int) -> None:
        row = self.db.one("SELECT market,duration FROM models WHERE id=?", (model_id,))
        self.db.execute("UPDATE models SET status='retired' WHERE market=? AND duration=? AND status='champion'",
                        (row["market"], row["duration"]))
        self.db.execute("UPDATE models SET status='champion', promoted_at=? WHERE id=?", (time.time(), model_id))

    def rollback(self, model_id: int) -> dict:
        """Re-promote a previously deployed (retired) model. Rejected models can't be promoted."""
        row = self.db.one("SELECT * FROM models WHERE id=?", (model_id,))
        if not row:
            raise KeyError(model_id)
        meta = json.loads(row["metrics"] or "{}")
        if row["status"] != "retired" or row["promoted_at"] is None:
            raise ValueError("only a model that was previously a champion can be restored")
        if meta.get("threshold") is None:
            raise ValueError("this model has no validated trading threshold")
        self.promote(model_id)
        self.db.event("warning", "model", f"استعادة النموذج #{model_id} ({row['market']} {row['duration']}ث) يدويًا")
        return row

    def demote(self, model_id: int, reason: str) -> None:
        self.db.execute("UPDATE models SET status='retired', note=? WHERE id=?", (reason, model_id))
        self._cache.pop(model_id, None)
