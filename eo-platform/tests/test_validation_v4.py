"""V4 phases 4/5 — per-market payout, EV including ties, out-of-distribution gate, model summary.
The statistical gates themselves are unchanged (tests in test_validation*.py keep guarding them)."""
import json
import time

import numpy as np

from eoplatform.config import _payout_map
from eoplatform.engine import features as F
from eoplatform.engine.fast import out_of_distribution
from eoplatform.learning import stats
from eoplatform.learning.models_view import summary


def test_payout_map_and_breakeven_per_market(settings):
    assert _payout_map("btcusd=0.82, ETHUSD=0.7,bad=x,XRPUSD=5") == {"BTCUSD": 0.82, "ETHUSD": 0.7}
    settings.payout_map = {"BTCUSD": 0.85}
    assert settings.payout_for("BTCUSD") == 0.85 and settings.payout_for("ETHUSD") == settings.payout
    assert abs(settings.breakeven_for("BTCUSD") - 1 / 1.85) < 1e-12
    assert settings.breakeven_for("ETHUSD") == settings.breakeven          # default unchanged (0.80 → 55.56 %)
    assert abs(settings.breakeven - 1 / 1.8) < 1e-12


def test_ev_includes_ties_and_uses_market_payout(env):
    s, db, hub, reg = env
    now = time.time()
    rows = [("win",) * 1] * 31 + [("loss",)] * 31 + [("draw",)] * 6        # model #139's live record
    for (st,) in rows:
        db.execute("INSERT INTO signals(created_at,market,kind,duration,source,decision,candidate,status,payload) "
                   "VALUES(?,?,?,?,?,?,?,?,?)", (now, "LTCUSD", "regular", 30, "fast", "BUY", "BUY", st, "{}"))
    p = stats.performance(db, s.breakeven, payout_for=lambda m: 0.80)
    row = p["by_market_duration"][0]["signals"]
    assert row["accuracy"] == 0.5 and row["draws"] == 6
    assert row["ev_per_unit"] == -0.1                                          # 0.5×0.8 − 0.5
    assert row["ev_per_trade_incl_draws"] == round((31 * 0.8 - 31) / 68, 4)   # −0.0912 over all 68 trades
    assert row["draw_rate"] == round(6 / 68, 4) and row["payout"] == 0.8


def test_out_of_distribution_gate():
    ref = {"median": [0.0] * len(F.FEATURES), "scale": [1.0] * len(F.FEATURES)}
    normal = {k: 0.5 for k in F.FEATURES}
    assert out_of_distribution(ref, normal) == []
    two = dict(normal, rsi14=50.0, adx=40.0)                                  # 2 extreme features: tolerated
    assert out_of_distribution(ref, two) == []
    three = dict(two, atr_rel=99.0)
    assert set(out_of_distribution(ref, three)) == {"rsi14", "adx", "atr_rel"}
    assert out_of_distribution(None, three) == []                            # old models without a reference


def test_models_summary_explains_rejections(env):
    s, db, hub, reg = env
    g = {"trades": 250, "accuracy": 0.53, "lb": 0.47, "consistent": False, "beats_baseline": False,
         "reasons": ["lower bound 0.47 ≤ required 0.5656", "walk-forward inconsistent (1/4)"]}
    db.execute("INSERT INTO models(market,duration,created_at,algo,path,metrics,status) VALUES(?,?,?,?,?,?,?)",
               ("ETHUSD", 30, time.time(), "xgboost", "/x", json.dumps({"gates": g, "validated": False,
                                                                         "required_accuracy": 0.5656}), "rejected"))
    out = summary(db)
    assert out["counts"] == {"rejected": 1} and out["champions"] == 0
    r = out["recent"][0]
    assert r["status_ar"] == "مرفوض" and r["reasons"] == g["reasons"] and r["validated"] is False


def test_feature_reference_is_stored_from_training_rows_only():
    from eoplatform.learning.trainer import _feature_ref
    X = np.random.default_rng(0).normal(size=(500, len(F.FEATURES)))
    ref = _feature_ref(X)
    assert len(ref["median"]) == len(F.FEATURES) and all(v > 0 for v in ref["scale"])
    assert _feature_ref(X[:100]) is None                                      # too few rows → no reference


def test_rejection_reasons_are_translated():
    from eoplatform.learning.models_view import reason_ar
    assert reason_ar("only 50 independent out-of-sample trades (< 200)").startswith("50 صفقة مستقلة")
    assert "≤ المطلوب 0.5656" in reason_ar("lower bound 0.2415 ≤ required 0.5656")
    assert "1 من 4" in reason_ar("walk-forward inconsistent (1/4 trading folds at/above required)")
    assert reason_ar("unknown text") == "unknown text"
