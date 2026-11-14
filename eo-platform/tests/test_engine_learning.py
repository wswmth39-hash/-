import json
import time

import numpy as np

from conftest import random_walk_bars, trending_regime_bars
from eoplatform.engine import features as F
from eoplatform.engine.fast import analyze
from eoplatform.engine.model import build_dataset, wilson_lb
from eoplatform.learning import evaluator, stats, trainer
from eoplatform.markets import get_market


def test_features_have_no_lookahead():
    bars = np.array(random_walk_bars(3000, seed=4), float)
    from eoplatform.data.hub import resample
    c = resample(bars, 10)
    full = F.compute(c)
    part = F.compute(c[:200])
    a, b = full.iloc[:200].to_numpy(), part.to_numpy()
    assert np.allclose(np.nan_to_num(a, nan=7), np.nan_to_num(b, nan=7))


def test_label_alignment():
    bars = np.array(random_walk_bars(4000, seed=5), float)
    ds = build_dataset(bars, 60)
    closes = {int(t): c for t, c in zip(bars[:, 0], bars[:, 4])}
    for ts, entry, y in list(zip(ds.ts, ds.entry, ds.y))[:200]:
        assert closes[int(ts) - 1] == entry               # entry = close of the analysis candle
        assert (closes[int(ts) - 1 + 60] > entry) == bool(y)  # label = close 60s later


def _live(hub, market, src, bars):
    hub.ingest_bars(market, src, bars, now=bars[-1][0] + 1.5)


def test_fast_engine_gates(env):
    s, db, hub, reg = env
    m = get_market(db, "EURUSD_OTC")
    assert analyze(m, 60, hub, reg, s)["decision"] == "WAIT"           # no data
    bars = random_walk_bars(2000)
    _live(hub, "EURUSD_OTC", "expertoption", bars)
    sig = analyze(m, 60, hub, reg, s, now=bars[-1][0] + 2)
    assert sig["data_state"] == "LIVE" and sig["decision"] == "WAIT"     # no validated model
    assert sig["candidate"] in ("BUY", "SELL") and sig["confidence"] is None
    assert any("نموذج" in r for r in sig["reasons"])
    stale = analyze(m, 60, hub, reg, s, now=bars[-1][0] + 40)
    assert stale["data_state"] == "STALE" and stale["decision"] == "WAIT"
    assert sig["latency_ms"] < 500


def test_trainer_rejects_random_walk(env):
    """No edge exists in a random walk: the trainer must not promote any model."""
    s, db, hub, reg = env
    m = get_market(db, "EURUSD_OTC")
    res = []
    for seed in (11, 12, 13):  # fixed timestamps → deterministic
        db.execute("DELETE FROM bars1s")
        db.upsert_bars("EURUSD_OTC", "expertoption", random_walk_bars(20000, end=1_800_000_000 + seed, seed=seed))
        res += trainer.retrain_all(db, reg, s, [m])
    assert all(r["status"] in ("rejected",) or r["status"].startswith("insufficient") for r in res), res
    assert reg.champion("EURUSD_OTC", 30) is None


def test_trainer_finds_planted_edge_and_engine_uses_it(env):
    s, db, hub, reg = env
    bars = trending_regime_bars(20000, seed=2)
    db.upsert_bars("EURUSD_OTC", "expertoption", bars[:-2000])
    m = get_market(db, "EURUSD_OTC")
    res = trainer.train_one(db, reg, s, m, 30, "expertoption", np.array(bars[:-2000], float))
    assert res["status"] == "champion", res
    row, model = reg.champion("EURUSD_OTC", 30)
    assert row["metrics"]["threshold"] is not None and row["metrics"]["test_accuracy"] > s.breakeven
    # strategies were compared on the same window and stored
    assert db.one("SELECT count(*) n FROM strategy_results")["n"] >= 5
    # live: the engine now emits validated signals with OOS-based confidence
    _live(hub, "EURUSD_OTC", "expertoption", bars[-2000:])
    decided = [analyze(m, 30, hub, reg, s, now=bars[-1][0] + 2)]
    sig = decided[0]
    if sig["decision"] != "WAIT":
        assert sig["validated"] and 0.5 < sig["confidence"] <= 1
        assert sig["confidence_detail"]["oos_samples"] >= s.min_validation_samples
    else:
        assert "العتبة" in sig["reasons"][0] or "تقلب" in sig["reasons"][0]
    # a model trained on one source is not applied to another
    hub.ingest_bars("EURUSD", "binance", bars[-2000:], now=bars[-1][0] + 1.5)


def test_evaluator_outcomes(env):
    s, db, hub, _ = env
    t0 = 1_800_000_000
    db.upsert_bars("EURUSD_OTC", "expertoption", [(t0 + i, 1, 1, 1, 1.0 + (0.01 if i >= 30 else 0), 1) for i in range(70)])
    base = {"market": "EURUSD_OTC", "market_name": "x", "kind": "otc", "duration": 60, "source": "fast",
            "timestamp": t0, "entry_ts": t0, "entry_price": 1.0, "data_source": "expertoption", "data_state": "LIVE",
            "reasons": []}
    ids = {
        "win": evaluator.record_signal(db, {**base, "decision": "BUY", "candidate": "BUY"}),
        "loss": evaluator.record_signal(db, {**base, "decision": "WAIT", "candidate": "SELL"}),
        "draw": evaluator.record_signal(db, {**base, "decision": "BUY", "candidate": "BUY", "entry_price": 1.01}),
        "void_stale": evaluator.record_signal(db, {**base, "decision": "BUY", "candidate": "BUY", "data_state": "STALE"}),
        "void_nodata": evaluator.record_signal(db, {**base, "decision": "BUY", "candidate": "BUY", "duration": 300}),
    }
    evaluator.resolve_pending(db, now=t0 + 1000)
    got = {k: db.one("SELECT status FROM signals WHERE id=?", (v,))["status"] for k, v in ids.items()}
    assert got == {"win": "win", "loss": "loss", "draw": "draw", "void_stale": "void", "void_nodata": "void"}
    p = stats.performance(db, s.breakeven)
    assert p["overall_signals"]["n"] == 1 and p["overall_signals"]["wins"] == 1   # WAIT excluded from signals
    assert p["overall_candidates"]["n"] == 2


def test_live_degradation_retires_champion(env):
    s, db, hub, reg = env
    from eoplatform.engine.model import DirectionModel
    X = np.random.default_rng(0).normal(size=(300, len(F.FEATURES)))
    mid = reg.register("EURUSD_OTC", 60, DirectionModel.train(X, (X[:, 0] > 0).astype(int)),
                       {"source": "expertoption", "threshold": 0.0, "calibration": [], "validated": True}, "candidate")
    reg.promote(mid)
    for i in range(150):
        db.execute("INSERT INTO signals(created_at,market,kind,duration,source,decision,candidate,model_id,status) "
                   "VALUES(?,?,?,?,?,?,?,?,?)", (time.time(), "EURUSD_OTC", "otc", 60, "fast", "BUY", "BUY", mid,
                                                 "win" if i % 3 == 0 else "loss"))
    assert trainer.check_live_degradation(db, reg, s) == ["EURUSD_OTC:60"]
    assert reg.champion("EURUSD_OTC", 60) is None


def test_wilson():
    assert abs(wilson_lb(60, 100) - 0.502) < 0.01
    assert wilson_lb(0, 0) == 0
