import time

import fake_llm_server as F
from conftest import random_walk_bars
from eoplatform.agents.graph import AgentSystem
from eoplatform.agents.llm import LocalLLM
from eoplatform.engine.fast import analyze
from eoplatform.markets import get_market


def _signal(env):
    s, db, hub, reg = env
    bars = random_walk_bars(2000, seed=9)
    hub.ingest_bars("EURUSD_OTC", "expertoption", bars, now=bars[-1][0] + 1)
    return analyze(get_market(db, "EURUSD_OTC"), 60, hub, reg, s, now=bars[-1][0] + 1.5)


def test_deterministic_team_without_llm(env):
    sig = _signal(env)
    out = AgentSystem(LocalLLM(env[0])).run(sig)
    assert out["llm_used"] is False
    assert set(out["reports"]) == {"technical", "trend", "candles", "price_action", "momentum", "liquidity"}
    h = out["investment_debate_state"]["history"]
    assert "Bull Researcher" in h and "Bear Researcher" in h          # debate happened, both sides
    assert out["risk_debate_state"]["count"] == 3                     # aggressive/conservative/neutral
    assert out["final"]["decision"] in ("BUY", "SELL", "WAIT")


def test_llm_path_through_tradingagents_client(env, monkeypatch):
    srv, url = F.start()
    s = env[0]
    s.llm_base_url = url
    F.REQUESTS.clear()
    sig = _signal(env)
    F.H.final_decision = "WAIT"
    out = AgentSystem(LocalLLM(s), 1, 1).run(sig)
    assert out["llm_used"] and out["llm_model"] == "qwen3.5:9b"
    assert len(F.REQUESTS) == 14 and all(r["model"] == "qwen3.5:9b" for r in F.REQUESTS)
    assert "<think>" not in out["investment_debate_state"]["history"]   # reasoning stripped
    assert out["final"]["decision"] == "WAIT"
    srv.shutdown()


def test_llm_cannot_override_evidence(env):
    srv, url = F.start()
    s = env[0]
    s.llm_base_url = url
    sig = _signal(env)
    sig["data_state"] = "STALE"           # risk manager must veto
    F.H.final_decision = "BUY"
    out = AgentSystem(LocalLLM(s), 1, 0).run(sig)
    assert out["final"]["llm_decision"] == "BUY"
    assert out["final"]["decision"] == "WAIT" and out["final"]["guarded"]
    srv.shutdown()


def test_no_evidence_means_wait(env):
    out = AgentSystem(LocalLLM(env[0])).run({"evidence": {}})
    assert out["final"]["decision"] == "WAIT" and out.get("skipped")
