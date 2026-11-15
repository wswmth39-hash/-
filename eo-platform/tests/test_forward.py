"""Pre-registered forward tests: scored only on data that arrives after registration."""
import numpy as np

from conftest import random_walk_bars, trending_regime_bars
from eoplatform.learning import forward
from eoplatform.markets import get_market


def _setup(env, future_gen, seed):
    s, db, hub, reg = env
    end = 1_800_000_000
    past = trending_regime_bars(24000, end=end, seed=2)
    db.upsert_bars("EURUSD_OTC", "expertoption", past)
    ft = forward.register(db, reg, s, get_market(db, "EURUSD_OTC"), 30, "base", "test", target_n=150)
    assert ft["start_ts"] == end and reg.champion("EURUSD_OTC", 30) is None   # registration ≠ activation
    st = db.one("SELECT * FROM forward_tests WHERE id=?", (ft["forward_test_id"],))
    assert forward.evaluate(db, reg, s, st)["n"] == 0                         # no future data yet
    last = past[-1][4]
    fut = future_gen(30000, end=end + 30000, seed=seed)
    k = last / fut[0][1]
    fut = [(t, o * k, h * k, l_ * k, c * k, n) for t, o, h, l_, c, n in fut]
    db.upsert_bars("EURUSD_OTC", "expertoption", fut)
    return s, db, reg, ft


def test_forward_test_passes_on_persistent_edge(env):
    s, db, reg, ft = _setup(env, trending_regime_bars, 9)
    res = forward.evaluate_all(db, reg, s)[0]
    assert res["status"] == "passed" and res["n"] == 150, res
    champ = reg.champion("EURUSD_OTC", 30)
    assert champ is not None and champ[0]["id"] == ft["model_id"] and champ[0]["metrics"]["forward_result"]["status"] == "passed"


def test_forward_test_fails_when_edge_disappears(env):
    s, db, reg, ft = _setup(env, random_walk_bars, 10)
    res = forward.evaluate_all(db, reg, s)[0]
    assert res["status"] == "failed", res
    assert reg.champion("EURUSD_OTC", 30) is None
    assert db.one("SELECT status FROM models WHERE id=?", (ft["model_id"],))["status"] == "rejected"
