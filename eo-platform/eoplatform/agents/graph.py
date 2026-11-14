"""ExpertOption multi-agent graph, built on the TradingAgents architecture.

Same shape as TradingAgents' GraphSetup.setup_graph():

    analysts (parallel) ──► Bull ⇄ Bear debate ──► Research Manager
        ──► Aggressive → Conservative → Neutral risk debate ──► Risk Management Agent
        ──► Final Decision Agent

Re-used from TradingAgents: ``InvestDebateState`` / ``RiskDebateState`` (state
shape), ``ConditionalLogic`` (debate/risk routing, unchanged) and the LLM client
factory (``agents/llm.py``). The stock-specific analysts (news, fundamentals,
social) are replaced with six market-microstructure specialists, because short
binary-option horizons (30s–5m) are driven by price data, not company filings.

Grounding: each agent receives deterministic facts computed by the fast engine.
The LLM interprets and argues; it cannot invent data. Guards on the final node
force WAIT when data is not live, when risk vetoes, or when the LLM's direction
contradicts the debated evidence. When no local LLM is available the same graph
runs with deterministic reasoning and the run is labelled as such.
"""
from __future__ import annotations

import json
import logging
import operator
import time
from typing import Annotated, Any, TypedDict

from langgraph.graph import END, START, StateGraph
from tradingagents.agents.state import InvestDebateState, RiskDebateState
from tradingagents.graph.conditional_logic import ConditionalLogic

from ..engine.analysis import AGENTS
from .llm import LocalLLM

log = logging.getLogger("eo.agents")

LANG = "Arabic text, at most 35 words per field. Use only the facts in the shared context."

# Per-role output budgets (tokens). Measured on qwen3.5:9b / 4 CPUs: generation ~4.1 tok/s,
# new-prompt processing ~42 tok/s, cached prefix ~0.5 s — so output length dominates cost.
BUDGET = {"analyst": 90, "researcher": 110, "manager": 100, "risk_debater": 70, "risk": 100, "final": 70}


def _merge(a: dict, b: dict) -> dict:
    return {**(a or {}), **(b or {})}


class EOAgentState(TypedDict, total=False):
    market: str
    market_name: str
    kind: str
    duration: int
    data_state: str
    data_source: str
    fast: dict                       # fast-engine signal summary
    evidence: dict                   # deterministic specialist evidence
    recent_record: dict              # this market/duration live record
    reports: Annotated[dict, _merge]
    investment_debate_state: InvestDebateState
    research: dict
    risk_debate_state: RiskDebateState
    risk: dict
    final: dict
    log: Annotated[list, operator.add]


def _fmt_facts(e: dict) -> str:
    return "; ".join(e.get("facts", []))


class AgentSystem:
    def __init__(self, llm: LocalLLM | None, debate_rounds: int = 1, risk_rounds: int = 1, profile: str = "fast"):
        """profile 'fast': LLM only where language reasoning adds something (debate, judgement, risk
        summary, final call); analysts and risk debaters stay deterministic (their facts are exact
        numbers already). 'full': every node calls the LLM, as in original TradingAgents."""
        self.llm = llm
        self.profile = profile
        self._shared_block = ""
        self.logic = ConditionalLogic(max_debate_rounds=max(1, debate_rounds),
                                      max_risk_discuss_rounds=max(1, risk_rounds))
        self.risk_rounds = risk_rounds
        self.use_llm = False
        self.graph = self._build()

    # ------------------------------------------------------------------ helpers
    def _llm_json(self, state: EOAgentState, who: str, prompt: str, role: str = "manager",
                  full_only: bool = False) -> tuple[dict | None, list]:
        if not self.use_llm:
            return None, []
        if full_only and self.profile != "full":
            return None, [{"agent": who, "llm": False, "skipped": "deterministic in fast profile"}]
        t = time.time()
        try:
            # Shared block first and byte-identical across the run. NOTE (measured): Ollama 0.40.16 did not
            # reuse a common prefix for qwen3.5 (cached_tokens=0 with different suffixes; only identical
            # prompts hit the cache), so this ordering is kept only because it is free and helps on
            # servers/models that do support prefix caching.
            out = self.llm.ask_json(self._shared_block + "\n---\n" + prompt + "\n" + LANG,
                                    max_tokens=BUDGET.get(role), role=who)
            return out, [{"agent": who, "llm": True, "secs": round(time.time() - t, 1)}]
        except Exception as e:
            # Circuit breaker: one failure (usually a timeout) switches the rest of this run to
            # deterministic reasoning instead of paying the timeout again for every agent.
            self.use_llm = False
            self.llm_failed = True
            log.warning("%s LLM failed, rest of run deterministic: %s", who, e)
            return None, [{"agent": who, "llm": False, "error": f"{type(e).__name__}: {e}"[:200]}]

    def _ctx(self, s: EOAgentState) -> str:
        return ""   # market context lives in the shared block (cached prefix)

    @staticmethod
    def shared_block(s: dict) -> str:
        """Compact, deterministic context shared by every prompt of one run."""
        f = s.get("fast", {})
        # Token cost measured with qwen3.5:9b's tokenizer: 3 facts/analyst = 405 tokens, 2 facts capped at
        # 70 chars = 355. Prompt processing runs ~42 tok/s on 4 CPUs, so every token matters.
        lines = [f"SHARED CONTEXT. {s['market_name']} ({'OTC' if s['kind'] == 'otc' else 'regular'}) {s['duration']}s, "
                 f"{s['data_source']}/{s['data_state']}; fast engine {f.get('decision')} (cand {f.get('candidate')}, "
                 f"p_up {f.get('prob')}, validated {f.get('validated')}).", "Facts (score -1..+1):"]
        for k, e in (s.get("evidence") or {}).items():
            lines.append(f"- {AGENTS.get(k, k)} {e.get('score', 0):+.2f}: "
                         + "؛ ".join(x[:70] for x in e.get("facts", [])[:2]))
        return "\n".join(lines)

    # ------------------------------------------------------------------ analysts
    def _analyst(self, key: str):
        name = AGENTS[key]

        def node(s: EOAgentState) -> dict:
            e = s["evidence"].get(key) or {"score": 0.0, "facts": ["غير متاح لهذا التحليل"]}
            rep = {"agent": key, "name_ar": name, "score": round(e["score"], 3), "facts": e["facts"],
                   "stance": "bullish" if e["score"] > 0.1 else "bearish" if e["score"] < -0.1 else "neutral",
                   "summary": f"{name}: " + _fmt_facts(e), "llm": False}
            out, lg = self._llm_json(s, name, (
                f"Role: {key.replace('_', ' ')} specialist. Interpret YOUR line ({name}) only.\n"
                'Return {"stance":"bullish|bearish|neutral","summary":"...","key_risk":"..."}'),
                role="analyst", full_only=True)
            if out:
                rep.update(llm=True, summary=str(out.get("summary", rep["summary"]))[:600],
                           key_risk=str(out.get("key_risk", ""))[:300],
                           llm_stance=str(out.get("stance", "")).lower())
                if rep["llm_stance"] in ("bullish", "bearish") and rep["llm_stance"] != rep["stance"]:
                    rep["disagreement"] = "تفسير النموذج اللغوي يخالف القراءة الرقمية"
            return {"reports": {key: rep}, "log": lg}
        return node

    # ------------------------------------------------------------------ researchers
    def _researcher(self, side: str):
        label = "Bull" if side == "bull" else "Bear"

        def node(s: EOAgentState) -> dict:
            st = dict(s["investment_debate_state"])
            reps = s["reports"].values()
            sign = 1 if side == "bull" else -1
            pro = [r for r in reps if r["score"] * sign > 0.05]
            con = [r for r in reps if r["score"] * sign < -0.05]
            strength = sum(abs(r["score"]) for r in pro)
            text = (f"{label} Researcher: الأدلة المؤيدة ({len(pro)}): " +
                    " | ".join(r["summary"] for r in pro)[:700] +
                    (f". أضعف حجج الطرف الآخر: {con[0]['name_ar']} قراءته ضعيفة ({con[0]['score']:+.2f})." if con else ""))
            out, lg = self._llm_json(s, f"{label} Researcher", (
                f"Role: {label}ish researcher. Argue the {'BUY' if side=='bull' else 'SELL'} case from the facts and "
                f"rebut the opponent.\nOpponent: {(st.get('current_response') or 'none yet')[:400]}\n"
                'Return {"argument":"...","strength":0..1}'), role="researcher")
            if out:
                text = f"{label} Researcher: {str(out.get('argument', ''))[:900]}"
            st.update(history=st.get("history", "") + "\n" + text,
                      current_response=text, count=st.get("count", 0) + 1)
            st[f"{side}_history"] = st.get(f"{side}_history", "") + "\n" + text
            st[f"{side}_strength"] = strength
            return {"investment_debate_state": st, "log": lg}
        return node

    def _research_manager(self, s: EOAgentState) -> dict:
        # the news analyst is risk-only (no direction), so it does not vote here
        reps = [r for k, r in s["reports"].items() if k != "news"]
        net = sum(r["score"] for r in reps) / max(1, len(reps))
        agree = sum(1 for r in reps if r["score"] * net > 0.05)
        oppose = sum(1 for r in reps if r["score"] * net < -0.05)
        lean = "BUY" if net > 0.12 else "SELL" if net < -0.12 else "NEUTRAL"
        res = {"lean": lean, "net_score": round(net, 3), "agree": agree, "oppose": oppose, "llm": False,
               "summary": f"صافي الأدلة {net:+.2f}؛ {agree} يؤيد و{oppose} يعارض ⇒ {lean}"}
        out, lg = self._llm_json(s, "Research Manager", (
            f"Role: judge of the debate.\nDebate:\n{s['investment_debate_state'].get('history','')[-1200:]}\n"
            f"Numeric net evidence {net:+.2f} ({agree} agree, {oppose} oppose).\n"
            'Return {"lean":"BUY|SELL|NEUTRAL","summary":"..."}'), role="manager")
        if out:
            res.update(llm=True, llm_lean=str(out.get("lean", "")).upper(), summary=str(out.get("summary", ""))[:600])
        return {"research": res, "risk_debate_state": RiskDebateState(
            aggressive_history="", conservative_history="", neutral_history="", history="", latest_speaker="",
            current_aggressive_response="", current_conservative_response="", current_neutral_response="", count=0),
            "log": lg}

    def _risk_debater(self, who: str):
        def node(s: EOAgentState) -> dict:
            st = dict(s["risk_debate_state"])
            r = s["research"]
            default = {"Aggressive": f"المؤيد للمخاطرة: الاتجاه {r['lean']} بصافي {r['net_score']:+.2f} يكفي للدخول.",
                       "Conservative": f"المتحفظ: {r['oppose']} من الوكلاء يعارضون، والمدة {s['duration']} ث قصيرة جدًا؛ الانتظار أسلم.",
                       "Neutral": "المحايد: يُدخل فقط إن كانت البيانات حية والنموذج مُتحقق منه."}[who]
            text = f"{who} Analyst: {default}"
            out, lg = self._llm_json(s, f"{who} Risk Analyst", (
                f"Role: {who.lower()} risk analyst — argue from a {who.lower()} risk appetite.\n"
                f"Research verdict: {r['summary'][:300]}\nDiscussion so far: {st.get('history','')[-600:]}\n"
                'Return {"argument":"..."}'), role="risk_debater", full_only=True)
            if out:
                text = f"{who} Analyst: {str(out.get('argument', ''))[:600]}"
            st.update(history=st.get("history", "") + "\n" + text, latest_speaker=who, count=st.get("count", 0) + 1)
            st[f"current_{who.lower()}_response"] = text
            st[f"{who.lower()}_history"] = st.get(f"{who.lower()}_history", "") + "\n" + text
            return {"risk_debate_state": st, "log": lg}
        return node

    def _risk_manager(self, s: EOAgentState) -> dict:
        f, r, rec = s.get("fast", {}), s["research"], s.get("recent_record") or {}
        vetoes = []
        if s["data_state"] != "LIVE":
            vetoes.append("البيانات ليست حية")
        if s["evidence"]["liquidity"].get("abnormal"):
            vetoes.append("تقلب/سيولة غير طبيعية")
        nw = s["evidence"].get("news") or {}
        if nw.get("high_impact_soon"):
            vetoes.append("خبر اقتصادي عالي التأثير قريب")
        if nw.get("unavailable"):
            warnings_pre = ["تقويم الأخبار غير متاح"]
        else:
            warnings_pre = []
        if r["lean"] == "NEUTRAL":
            vetoes.append("لا أفضلية واضحة في الأدلة")
        if r["oppose"] >= max(2, r["agree"]):
            vetoes.append("تعارض كبير بين الوكلاء")
        if f.get("candidate") and r["lean"] in ("BUY", "SELL") and f["candidate"] != r["lean"] and f.get("validated"):
            vetoes.append("يخالف إشارة النموذج المُتحقق منه")
        if rec.get("n", 0) >= 30 and rec.get("accuracy") is not None and rec["accuracy"] < 0.5:
            vetoes.append(f"سجل هذا السوق الحي ضعيف ({rec['accuracy']*100:.0f}% على {rec['n']})")
        warnings = list(warnings_pre)
        if not f.get("validated"):
            warnings.append("لا يوجد نموذج مُتحقق منه — أي اتجاه هنا غير مثبت إحصائيًا")
        level = "high" if vetoes else "medium" if warnings else "low"
        risk = {"level": level, "vetoes": vetoes, "warnings": warnings, "llm": False,
                "summary": "؛ ".join(vetoes + warnings) or "لا موانع"}
        out, lg = self._llm_json(s, "Risk Management Agent", (
            f"Role: risk manager.\nResearch: {r['summary'][:300]}\n"
            f"Risk debate: {s.get('risk_debate_state', {}).get('history', '')[-600:]}\n"
            f"Hard vetoes already found: {vetoes or 'none'}. Warnings: {warnings or 'none'}.\n"
            'Return {"summary":"...","extra_veto":""} (extra_veto only for a concrete risk in the facts)'), role="risk")
        if out:
            risk.update(llm=True, summary=str(out.get("summary", risk["summary"]))[:600])
            ev = str(out.get("extra_veto") or "").strip()
            if ev:
                risk["vetoes"].append(ev[:200])
                risk["level"] = "high"
        return {"risk": risk, "log": lg}

    def _final(self, s: EOAgentState) -> dict:
        r, risk = s["research"], s["risk"]
        decision = r["lean"] if r["lean"] in ("BUY", "SELL") and not risk["vetoes"] else "WAIT"
        reason = (f"قرار مبني على صافي أدلة {r['net_score']:+.2f}" if decision != "WAIT"
                  else "انتظار: " + (risk["summary"] or "لا أفضلية"))
        final = {"decision": decision, "candidate": r["lean"] if r["lean"] in ("BUY", "SELL") else None,
                 "reason": reason, "llm": False, "guarded": False}
        if decision == "WAIT" and (risk["vetoes"] or r["lean"] not in ("BUY", "SELL")):
            # The guard below would force WAIT whatever the model says: don't spend ~15 s asking.
            final["reason"] += " (لم يُستدعَ النموذج اللغوي: النتيجة محسومة بموانع المخاطر)"
            return {"final": final, "log": [{"agent": "Final Decision Agent", "llm": False, "skipped": "outcome forced"}]}
        out, lg = self._llm_json(s, "Final Decision Agent", (
            f"Role: final decision.\nResearch verdict: {r['summary'][:300]} (lean {r['lean']}).\n"
            f"Risk: {risk['summary'][:300]} (vetoes: {risk['vetoes'] or 'none'}).\n"
            'Return {"decision":"BUY|SELL|WAIT","reason":"..."}. Prefer WAIT when in doubt.'), role="final")
        if out:
            d = str(out.get("decision", "WAIT")).upper()
            d = d if d in ("BUY", "SELL", "WAIT") else "WAIT"
            final.update(llm=True, llm_decision=d, reason=str(out.get("reason", reason))[:600])
            # Guards: the LLM may only choose WAIT or the direction the evidence supports.
            if d != "WAIT" and (risk["vetoes"] or d != r["lean"]):
                final.update(decision="WAIT", guarded=True,
                             reason=final["reason"] + " — (تم التحويل إلى انتظار: القرار يخالف الأدلة أو موانع المخاطر)")
            else:
                final["decision"] = d
        return {"final": final, "log": lg}

    # ------------------------------------------------------------------ graph
    def _build(self):
        g = StateGraph(EOAgentState)
        keys = list(AGENTS)
        for k in keys:
            g.add_node(f"{k}_analyst", self._analyst(k))
            g.add_edge(START, f"{k}_analyst")
        g.add_node("Bull Researcher", self._researcher("bull"))
        g.add_node("Bear Researcher", self._researcher("bear"))
        g.add_node("Research Manager", self._research_manager)
        g.add_edge([f"{k}_analyst" for k in keys], "Bull Researcher")
        dmap = {"Bull Researcher": "Bull Researcher", "Bear Researcher": "Bear Researcher",
                "Research Manager": "Research Manager"}
        for n in ("Bull Researcher", "Bear Researcher"):
            g.add_conditional_edges(n, self.logic.should_continue_debate, dmap)
        g.add_node("Risk Management Agent", self._risk_manager)
        g.add_node("Final Decision Agent", self._final)
        if self.risk_rounds > 0:
            for who in ("Aggressive", "Conservative", "Neutral"):
                g.add_node(f"{who} Analyst", self._risk_debater(who))
            g.add_edge("Research Manager", "Aggressive Analyst")
            rmap = {"Aggressive Analyst": "Aggressive Analyst", "Conservative Analyst": "Conservative Analyst",
                    "Neutral Analyst": "Neutral Analyst", "Portfolio Manager": "Risk Management Agent"}
            for who in ("Aggressive", "Conservative", "Neutral"):
                g.add_conditional_edges(f"{who} Analyst", self.logic.should_continue_risk_analysis, rmap)
        else:
            g.add_edge("Research Manager", "Risk Management Agent")
        g.add_edge("Risk Management Agent", "Final Decision Agent")
        g.add_edge("Final Decision Agent", END)
        return g.compile()

    def run(self, fast_signal: dict, recent_record: dict | None = None) -> dict[str, Any]:
        """Run the full team on top of a fast-engine signal (needs its evidence)."""
        if not fast_signal.get("evidence"):
            return {"final": {"decision": "WAIT", "reason": "لا توجد أدلة كافية (بيانات غير متاحة)", "llm": False},
                    "skipped": True}
        self.use_llm = bool(self.llm and self.llm.health()["ok"])
        self.llm_failed = False
        t = time.time()
        init: EOAgentState = {
            "market": fast_signal["market"], "market_name": fast_signal["market_name"], "kind": fast_signal["kind"],
            "duration": fast_signal["duration"], "data_state": fast_signal["data_state"],
            "data_source": fast_signal["data_source"], "evidence": fast_signal["evidence"],
            "fast": {k: fast_signal.get(k) for k in ("decision", "candidate", "prob", "validated", "confidence")},
            "recent_record": recent_record or {}, "reports": {}, "log": [],
            "investment_debate_state": InvestDebateState(bull_history="", bear_history="", history="",
                                                         current_response="", count=0),
        }
        self._shared_block = self.shared_block(init)
        out = self.graph.invoke(init, {"recursion_limit": 60})
        out["elapsed"] = round(time.time() - t, 2)
        out["llm_used"] = self.use_llm or self.llm_failed
        out["llm_partial"] = self.llm_failed   # LLM failed mid-run; later agents ran deterministically
        out["llm_model"] = self.llm.model if out["llm_used"] else None
        return out
