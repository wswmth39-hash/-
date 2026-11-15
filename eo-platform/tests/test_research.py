"""Model governance: invalid models can never become active; rollback; candidate specs."""
import json
import time

import numpy as np
import pytest

from conftest import random_walk_bars, trending_regime_bars
from eoplatform.engine import features as F
from eoplatform.engine.model import DirectionModel
from eoplatform.learning import trainer
from eoplatform.markets import get_market


def _model():
    X = np.random.default_rng(0).normal(size=(300, len(F.FEATURES)))
    return DirectionModel.train(X, (X[:, 0] > 0).astype(int))


@pytest.mark.parametrize("meta", [{}, {"validated": False, "threshold": 0.05}, {"validated": True, "threshold": None}])
def test_invalid_models_cannot_be_promoted(env, meta):
    s, db, hub, reg = env
    mid = reg.register("EURUSD_OTC", 60, _model(), {"source": "expertoption", **meta}, "candidate")
    with pytest.raises(ValueError):
        reg.promote(mid)
    assert reg.champion("EURUSD_OTC", 60) is None


def test_random_walk_never_validated_under_any_spec(env):
    s, db, hub, reg = env
    db.upsert_bars("EURUSD_OTC", "expertoption", random_walk_bars(20000, end=1_800_000_000, seed=21))
    res = trainer.retrain_all(db, reg, s, [get_market(db, "EURUSD_OTC")], specs=tuple(trainer.SPECS))
    assert res and not any(r.get("validated") for r in res), [r.get("note") for r in res]
    assert db.kv_get("last_retrain")["family_size"] == sum(1 for r in res if not str(r["status"]).startswith("insufficient"))
    assert reg.champion("EURUSD_OTC", 30) is None


def test_planted_edge_validated_with_full_metrics(env):
    s, db, hub, reg = env
    bars = np.array(trending_regime_bars(24000, seed=2), float)
    m = get_market(db, "EURUSD_OTC")
    r = trainer.train_one(db, reg, s, m, 30, "expertoption", bars, spec="base")
    assert r["status"] == "champion" and r["validated"], r
    row, model = reg.champion("EURUSD_OTC", 30)
    meta = row["metrics"]
    assert meta["fold_consistent"] and meta["baseline_check"]["passed"]
    assert meta["expected_value"]["ev_per_unit_lb"] > 0
    assert meta["calibration_quality"]["brier"] < meta["calibration_quality"]["brier_baseline"]
    assert sum(b["n"] for b in meta["calibration_quality"]["reliability"]) == meta["test_samples"]
    # a feature-subset spec stores its indices and predicts on the subset
    r2 = trainer.train_one(db, reg, s, m, 30, "expertoption", bars, spec="trend_momentum")
    mrow = db.one("SELECT metrics FROM models WHERE id=?", (r2["model_id"],))
    assert len(json.loads(mrow["metrics"])["feature_idx"]) == len(trainer.feature_idx("trend_momentum"))


def test_auto_rollback_to_previous_validated_champion(env):
    s, db, hub, reg = env
    bars = trending_regime_bars(24000, end=int(time.time()), seed=2)
    db.upsert_bars("EURUSD_OTC", "expertoption", bars)
    m = get_market(db, "EURUSD_OTC")
    first = trainer.train_one(db, reg, s, m, 30, "expertoption", np.array(bars, float), spec="base")
    assert first["status"] == "champion"
    # a second (hand-registered, validated) champion takes over, then performs badly live
    second = reg.register("EURUSD_OTC", 30, _model(), {"source": "expertoption", "threshold": 0.0, "validated": True,
                                                       "calibration": []}, "candidate")
    reg.promote(second)
    for i in range(150):
        db.execute("INSERT INTO signals(created_at,market,kind,duration,source,decision,candidate,model_id,status) "
                   "VALUES(?,?,?,?,?,?,?,?,?)", (time.time(), "EURUSD_OTC", "otc", 30, "fast", "BUY", "BUY", second,
                                                 "win" if i % 4 == 0 else "loss"))
    assert trainer.check_live_degradation(db, reg, s) == ["EURUSD_OTC:30"]
    champ = reg.champion("EURUSD_OTC", 30)
    assert champ is not None and champ[0]["id"] == first["model_id"]      # automatic rollback happened
    assert db.one("SELECT status FROM models WHERE id=?", (second,))["status"] == "retired"


def test_research_cycle_runs_end_to_end_without_llm(settings):
    from eoplatform.learning import research
    from eoplatform.service.core import Core
    core = Core(settings)
    core.db.upsert_bars("EURUSD_OTC", "expertoption", random_walk_bars(20000, end=1_800_000_000, seed=5))
    rep = research.run_cycle(core, use_llm=False)
    st = core.db.kv_get("research_status")
    assert st["state"] == "idle" and st["progress"] == 1.0
    assert 1 <= len(rep["hypotheses"]) <= research.MAX_SPECS and rep["hypotheses"][0]["spec"] == "base"
    assert rep["promoted"] == []                         # random walk: nothing may be promoted
    assert rep["family_size"] == sum(1 for r in rep["results"] if not str(r["status"]).startswith("insufficient"))


def test_llm_hypotheses_are_restricted_to_catalog():
    from eoplatform.learning import research

    class FakeLLM:
        def health(self):
            return {"ok": True}

        def ask_json(self, prompt, max_tokens=None, role=""):
            return {"specs": ["regularised", "rm -rf /", "base; DROP TABLE"], "reasoning": "x",
                    "weaknesses": ["خسائر متكررة في حالة النطاق العرضي"]}
    hyps, info = research.llm_hypotheses(FakeLLM(), {})
    assert [h[0] for h in hyps] == ["regularised"] and info["accepted"] == ["regularised"]
    assert info["rejected"] == ["rm -rf /", "base; DROP TABLE"] and info["weaknesses"]


def test_every_proposal_is_recorded(env):
    from eoplatform.learning import research
    s, db, hub, reg = env

    class FakeLLM:
        def health(self):
            return {"ok": True}

        def ask_json(self, prompt, max_tokens=None, role=""):
            assert "catalog" in prompt                     # Qwen only sees the fixed catalog
            return {"specs": ["lightgbm", "make_money_fast"], "reasoning": "x", "weaknesses": ["w"]}
    research.llm_hypotheses(FakeLLM(), research.failure_summary(db), db)
    row = db.one("SELECT * FROM research_proposals")
    assert json.loads(row["accepted"]) == ["lightgbm"] and json.loads(row["rejected"]) == ["make_money_fast"]


def test_parse_json_tolerates_missing_final_brace():
    from eoplatform.agents.llm import parse_json_answer
    real = '{"specs":["regularised","shallow"],"reasoning":"نموذج regularised يعالج الإفراط في التخصيص."'
    assert parse_json_answer(real)["specs"] == ["regularised", "shallow"]
    assert parse_json_answer('noise {"a": 1} tail')["a"] == 1
    with pytest.raises(ValueError):
        parse_json_answer("no json here")


def test_incumbent_with_old_feature_layout_is_retired_not_crash(env):
    s, db, hub, reg = env
    X = np.random.default_rng(0).normal(size=(300, 37))
    old = DirectionModel.train(X, (X[:, 0] > 0).astype(int))
    mid = reg.register("EURUSD_OTC", 30, old, {"source": "expertoption", "threshold": 0.05, "validated": True,
                                                "features": F.FEATURES[:37]}, "candidate")
    reg.promote(mid)
    r = trainer.train_one(db, reg, s, get_market(db, "EURUSD_OTC"), 30, "expertoption",
                          np.array(random_walk_bars(20000, end=1_800_000_000, seed=31), float))
    assert not str(r["status"]).startswith("error"), r
    assert db.one("SELECT status FROM models WHERE id=?", (mid,))["status"] == "retired"


def test_llm_proposal_gets_a_slot(settings, monkeypatch):
    from eoplatform.learning import research
    from eoplatform.service.core import Core
    core = Core(settings)
    core.db.upsert_bars("EURUSD_OTC", "expertoption", random_walk_bars(20000, end=1_800_000_000, seed=5))
    monkeypatch.setattr(research, "llm_hypotheses",
                        lambda llm, summary, db=None: ([("regularised", "اقتراح Qwen: x")],
                                                       {"used": True, "accepted": ["regularised"]}))
    rep = research.run_cycle(core, use_llm=True)
    specs = [h["spec"] for h in rep["hypotheses"]]
    assert specs[0] == "base" and specs[1] == "regularised" and len(specs) == research.MAX_SPECS
