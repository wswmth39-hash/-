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
    assert set(out["reports"]) == {"technical", "trend", "candles", "price_action", "momentum", "liquidity",
                                   "support_resistance", "news"}
    assert out["reports"]["news"]["score"] == 0           # news is risk-only, never a direction
    h = out["investment_debate_state"]["history"]
    assert "Bull Researcher" in h and "Bear Researcher" in h          # debate happened, both sides
    assert out["risk_debate_state"]["count"] == 3                     # aggressive/conservative/neutral
    assert out["final"]["decision"] in ("BUY", "SELL", "WAIT")


def test_llm_path_through_tradingagents_client_full_profile(env):
    srv, url = F.start()
    s = env[0]
    s.llm_base_url = url
    F.REQUESTS.clear()
    sig = _signal(env)
    F.H.final_decision = "WAIT"
    out = AgentSystem(LocalLLM(s), 1, 1, profile="full").run(sig)
    assert out["llm_used"] and out["llm_model"] == "qwen3.5:9b"
    # 8 analysts + 2 researchers + manager + 3 risk debaters + risk manager (+ final unless forced)
    assert len(F.REQUESTS) in (15, 16) and all(r["model"] == "qwen3.5:9b" for r in F.REQUESTS)
    assert all(r.get("reasoning_effort") == "none" for r in F.REQUESTS)        # thinking disabled
    assert "<think>" not in out["investment_debate_state"]["history"]
    srv.shutdown()


def test_fast_profile_fewer_calls_and_shared_cached_prefix(env):
    srv, url = F.start()
    s = env[0]
    s.llm_base_url = url
    F.REQUESTS.clear()
    out = AgentSystem(LocalLLM(s), 1, 1, profile="fast").run(_signal(env))
    roles = [l["agent"] for l in out["log"] if l.get("llm")]
    assert "Bull Researcher" in roles and "Bear Researcher" in roles and "Research Manager" in roles
    assert len(F.REQUESTS) <= 5                                              # vs 16 in the full profile
    prompts = [r["messages"][-1]["content"] for r in F.REQUESTS]
    prefix = prompts[0].split("\n---\n")[0]
    assert prefix.startswith("SHARED CONTEXT") and all(p.startswith(prefix + "\n---\n") for p in prompts)
    assert all(r.get("max_tokens", 999) <= 110 for r in F.REQUESTS)          # per-role budgets, as max_tokens
    #   (Ollama 0.40.16 ignores max_completion_tokens — measured — so max_tokens must be sent explicitly)
    srv.shutdown()


def test_llm_cannot_override_evidence(env):
    srv, url = F.start()
    s = env[0]
    s.llm_base_url = url
    sig = _signal(env)
    for e in sig["evidence"].values():                 # unanimous bullish evidence → lean BUY, no vetoes
        if e.get("agent") != "news":
            e["score"] = 0.8
    sig["evidence"]["liquidity"]["abnormal"] = False
    F.H.final_decision = "SELL"                         # the LLM contradicts the evidence
    out = AgentSystem(LocalLLM(s), 1, 0).run(sig)
    assert out["research"]["lean"] == "BUY" and not out["risk"]["vetoes"]
    assert out["final"]["llm_decision"] == "SELL"
    assert out["final"]["decision"] == "WAIT" and out["final"]["guarded"]
    srv.shutdown()


def test_forced_outcome_skips_final_llm_call(env):
    srv, url = F.start()
    s = env[0]
    s.llm_base_url = url
    sig = _signal(env)
    sig["data_state"] = "STALE"                         # risk veto → WAIT is certain
    F.REQUESTS.clear()
    out = AgentSystem(LocalLLM(s), 1, 0).run(sig)
    assert out["final"]["decision"] == "WAIT" and "llm_decision" not in out["final"]
    assert not any("final call" in r["messages"][-1]["content"].lower() or "final decision" in
                   r["messages"][-1]["content"].lower() for r in F.REQUESTS)
    srv.shutdown()


def test_no_evidence_means_wait(env):
    out = AgentSystem(LocalLLM(env[0])).run({"evidence": {}})
    assert out["final"]["decision"] == "WAIT" and out.get("skipped")
