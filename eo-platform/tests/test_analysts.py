"""V4 phases 3/8 — eight-analyst panel, measured redundancy weights, no decision from consensus."""
import json
import time
from pathlib import Path

import numpy as np

from conftest import random_walk_bars
from eoplatform.engine import analysts as AN
from eoplatform.engine.fast import analyze
from eoplatform.markets import get_market

ROOT = Path(__file__).resolve().parents[1]


def test_measured_correlations_match_the_benchmark_file_and_weights_penalise_redundancy():
    bench = json.loads((ROOT / "docs/analyst_redundancy.json").read_text())
    for pair, v in bench["corr"].items():
        a, b = pair.split("|")
        assert abs(AN._corr(a, b) - v) < 0.011 and AN._corr(a, b) == AN._corr(b, a)
    w = AN.WEIGHTS
    assert w["momentum"] == min(w.values())            # most redundant (ρ=0.72 with price action)
    assert 1.0 < AN.effective_n() < 4.0               # 4 analysts are worth fewer independent opinions


def test_signal_has_full_panel_and_consensus_never_decides(env):
    s, db, hub, reg = env
    now = time.time()
    hub.ingest_bars("BTCUSD", "binance", random_walk_bars(4000, end=int(now), seed=9, p0=65000.0), now=now)
    sig = analyze(get_market(db, "BTCUSD"), 60, hub, reg, s, now=now)
    p = sig["panel"]
    assert set(p["analysts"]) == set(AN.NAMES_AR)     # all eight analysts
    for k, a in p["analysts"].items():
        assert a["name_ar"] and a["role"] in ("directional", "risk", "context") and a["facts"]
        assert ("weight" in a) and ("influence" in a) and a["stance"]
    assert abs(sum(a["weight"] for a in p["analysts"].values()) - 1.0) < 0.01   # directional weights sum to 1
    assert p["analysts"]["model"]["stance"] == "abstain" and p["analysts"]["model"]["score"] == 0
    assert sig["decision"] == "WAIT"                  # no validated model → consensus cannot trade
    assert "ليس إثباتًا" in p["note"]
    assert sig.get("consensus_score") is not None and sig["candidate"] in ("BUY", "SELL", None)


def test_panel_without_data_still_reports_data_risk(env):
    s, db, hub, reg = env
    sig = analyze(get_market(db, "EURUSD_OTC"), 60, hub, reg, s)
    p = sig["panel"]
    assert p["analysts"]["data_risk"]["verdict"] == "block" and "data_risk" in p["blocks"]
    assert p["direction"] == "neutral" and sig["decision"] == "WAIT"


def test_bounce_and_sma_facts():
    row = {"dist_lo20": 0.2, "lower_wick": 0.7, "dist_hi20": 3, "upper_wick": 0.1, "adx": 0.3, "ema_fast_slow": 0.5,
           "ema_slope": 0.4, "di_diff": 0.1, "ret3": 1, "ret6": 1, "streak": 2}
    c = np.column_stack([np.arange(60) * 10.0, *([np.linspace(100, 110, 60)] * 4), np.ones(60)])
    pa = AN.price_action(row, c)
    assert any("ارتداد محتمل من دعم" in f for f in pa["facts"])
    tr = AN.trend(row, c)
    assert any("SMA20" in f and "SMA50" in f for f in tr["facts"]) and tr["score"] > 0
