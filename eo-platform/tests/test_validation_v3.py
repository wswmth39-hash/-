"""Validation protocol v3: the fixes for the measured Phase-3 audit findings."""
import numpy as np
import pytest

from conftest import random_walk_bars, trending_regime_bars
from eoplatform.engine import features as F
from eoplatform.engine.model import ALGOS, DirectionModel, build_dataset
from eoplatform.learning import trainer
from eoplatform.learning import validation as V
from eoplatform.markets import get_market


def test_non_overlapping_selection():
    ts = np.arange(0, 300, 5)
    idx = V.non_overlapping(ts, 30)
    assert np.all(np.diff(ts[idx]) >= 30) and len(idx) == 10


def test_threshold_never_chosen_on_test_blocks():
    """Fold k's threshold may depend only on data BEFORE block k: shuffling the labels of block k
    and everything after it must leave thresholds of folds 1..k unchanged. (Earlier blocks are
    legitimately reused as training data by later folds, as in any walk-forward.)"""
    bars = np.array(trending_regime_bars(24000, end=1_800_000_000, seed=2), float)
    ds = build_dataset(bars, 30)
    base = [f["threshold"] for f in V.walk_forward(ds.X, ds.y, ds.ts, 30, 66, 0.566).folds]
    n = len(ds.y)
    bounds = np.linspace(int(n * (1 - V.TEST_FRAC)), n, V.K_FOLDS + 1).astype(int)
    for k in range(V.K_FOLDS):
        y2 = ds.y.copy()
        y2[bounds[k]:] = np.random.default_rng(k).permutation(y2[bounds[k]:])
        got = [f["threshold"] for f in V.walk_forward(ds.X, y2, ds.ts, 30, 66, 0.566).folds]
        assert got[:k + 1] == base[:k + 1], (k, got, base)


def test_gate_stats_use_independent_trades():
    bars = np.array(trending_regime_bars(24000, end=1_800_000_000, seed=2), float)
    ds = build_dataset(bars, 30)
    r = V.walk_forward(ds.X, ds.y, ds.ts, 30, 66, 0.566)
    assert r.all_p is not None
    n_test = len(ds.y) - int(len(ds.y) * (1 - V.TEST_FRAC))
    assert len(r.all_p) <= n_test / 5          # 30 s horizon on 5 s candles → at most 1 in 6 kept


@pytest.mark.parametrize("spec", ["lightgbm", "catboost", "logistic", "interactions", "structure_mtf"])
def test_new_specs_never_validate_on_random_walk(env, spec):
    s, db, hub, reg = env
    bars = np.array(random_walk_bars(20000, end=1_800_000_000, seed=40), float)
    r = trainer.train_one(db, reg, s, get_market(db, "EURUSD_OTC"), 30, "expertoption", bars, spec=spec)
    assert not r.get("validated"), r


def test_planted_edge_validates_under_v3_and_ledger_records(env):
    s, db, hub, reg = env
    bars = np.array(trending_regime_bars(24000, seed=2), float)
    r = trainer.train_one(db, reg, s, get_market(db, "EURUSD_OTC"), 30, "expertoption", bars, spec="base")
    assert r["validated"] and r["status"] == "champion", r
    row, _ = reg.champion("EURUSD_OTC", 30)
    m = row["metrics"]
    assert m["protocol"] == "v3-walkforward-nonoverlap" and m["exec_delay_s"] == s.exec_delay_s
    assert m["gates"]["lb"] > m["required_accuracy"] > s.breakeven
    led = db.all("SELECT * FROM hypothesis_ledger")
    assert len(led) == 1 and led[0]["validated"] == 1 and led[0]["trades"] == r["trades"]


def test_ledger_family_grows_across_runs(env):
    s, db, hub, reg = env
    db.upsert_bars("EURUSD_OTC", "expertoption", random_walk_bars(20000, end=1_800_000_000, seed=41))
    m = [get_market(db, "EURUSD_OTC")]
    trainer.retrain_all(db, reg, s, m, specs=("base",))
    f1 = db.kv_get("last_retrain")["family_size"]
    trainer.retrain_all(db, reg, s, m, specs=("base",))
    f2 = db.kv_get("last_retrain")["family_size"]
    assert f2 > f1                       # earlier tests on the same data count against later ones


def test_pre_v3_champion_is_retired(env):
    s, db, hub, reg = env
    X = np.random.default_rng(0).normal(size=(300, len(F.FEATURES)))
    old = DirectionModel.train(X, (X[:, 0] > 0).astype(int))
    mid = reg.register("EURUSD_OTC", 30, old, {"source": "expertoption", "threshold": 0.05, "validated": True,
                                                "features": F.FEATURES}, "candidate")
    reg.promote(mid)
    trainer.train_one(db, reg, s, get_market(db, "EURUSD_OTC"), 30, "expertoption",
                      np.array(random_walk_bars(20000, end=1_800_000_000, seed=42), float))
    assert db.one("SELECT status FROM models WHERE id=?", (mid,))["status"] == "retired"


def test_interactions_roundtrip(tmp_path):
    X = np.random.default_rng(3).normal(size=(500, len(F.FEATURES)))
    y = (X[:, 0] * X[:, 1] > 0).astype(int)
    inter = trainer.interaction_idx("core")
    for algo in ALGOS:
        m = DirectionModel.train(X, y, algo=algo, interactions=inter)
        m.meta.update(interactions=inter)
        p = tmp_path / f"m_{algo}.{'ubj' if algo == 'xgboost' else 'joblib'}"
        m.save(p)
        assert np.allclose(DirectionModel.load(p).predict(X[:20]), m.predict(X[:20]))
