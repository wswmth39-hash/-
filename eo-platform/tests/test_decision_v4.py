"""V4 phases 6/7/9 — gate checklist, per-duration results, final decision, AUTO SCANNER.
Validated models are simulated by stub signals only; no claim of real accuracy is made."""
import time

from conftest import random_walk_bars
from eoplatform.engine.decision import decide
from eoplatform.engine.fast import GATES, analyze, gate_checklist
from eoplatform.markets import get_market

M = {"id": "BTCUSD", "name": "Bitcoin", "name_ar": "بيتكوين", "kind": "regular"}


def _sig(d, decision="WAIT", validated=False, lb=None, acc=None, code="no_validated_model"):
    s = {"market": "BTCUSD", "duration": d, "decision": decision, "candidate": "BUY", "validated": validated,
         "entry_price": 65000.0, "data_source": "binance", "data_state": "LIVE", "data_age": 0.5,
         "timestamp": 1_800_000_000, "reasons": ["r"], "gates": gate_checklist(None if validated else code, decision),
         "model_status": {"state": "validated" if validated else "none"},
         "confidence_detail": {"wilson_lb": lb, "oos_accuracy": acc, "oos_samples": 400} if lb else None}
    if decision == "WAIT":
        s["abstain_reason"] = {"code": code, "text": "x"}
    return s


def test_gate_checklist_never_claims_unevaluated_gates():
    g = gate_checklist("no_validated_model", "WAIT")
    idx = [x["gate"] for x in g].index("validated_model")
    assert all(x["ok"] is True for x in g[:idx]) and g[idx]["ok"] is False
    assert all(x["ok"] is None for x in g[idx + 1:])            # not evaluated ≠ passed
    assert all(x["ok"] is True for x in gate_checklist(None, "BUY"))
    assert all(x["ok"] is None for x in gate_checklist("mystery", "WAIT"))
    assert len(g) == len(GATES)


def test_real_analysis_reports_where_it_stopped(env):
    s, db, hub, reg = env
    now = time.time()
    hub.ingest_bars("BTCUSD", "binance", random_walk_bars(4000, end=int(now), seed=11, p0=65000.0), now=now)
    sig = analyze(get_market(db, "BTCUSD"), 60, hub, reg, s, now=now)
    failed = [g for g in sig["gates"] if g["ok"] is False]
    assert sig["decision"] == "WAIT" and len(failed) == 1
    assert sig["abstain_reason"]["code"] in {c for _, c, _ in GATES}     # explicit code, not text matching
    sig2 = analyze(get_market(db, "EURUSD_OTC"), 60, hub, reg, s)
    assert sig2["gates"][0]["ok"] is False and sig2["abstain_reason"]["code"] == "no_data"


def test_decision_picks_best_conservative_ev_and_explains_each_duration():
    sigs = [_sig(30), _sig(60, "BUY", True, 0.57, 0.60), _sig(120, "BUY", True, 0.60, 0.63),
            _sig(300, "WAIT", code="data_anomaly")]
    d = decide(M, sigs, 0.80)
    assert d["decision"] == "BUY" and d["horizon"] == 120 and abs(d["edge_lb"] - (0.60 * 1.8 - 1)) < 1e-12
    ch = {h["duration"]: h["choice"] for h in d["horizons"]}
    assert ch[120] == "chosen" and "أقل عائدًا" in ch[60] and "قفزة" in ch[300] and "نموذج" in ch[30]
    assert d["confidence"]["lower_bound_95"] == 0.60 and d["confidence"]["calibrated_probability"] is None
    assert "غير متوفرة" in d["confidence_note"]                     # never an uncalibrated "probability"
    for k in ("market", "direction", "horizon", "model_state", "data_source", "data_age", "evidence_for",
              "evidence_against", "reason", "gates", "horizons"):
        assert k in d


def test_validated_but_below_break_even_with_market_payout_is_wait():
    # lb 0.545 > 1/1.8? No: 0.545×1.8−1 = −0.019 → not positive at payout 0.80 …
    sigs = [_sig(30, "BUY", True, 0.545, 0.58), _sig(60), _sig(120), _sig(300)]
    assert decide(M, sigs, 0.80)["decision"] == "WAIT"
    # … but positive if the owner's actual payout for this market is 0.90 (EO_PAYOUT_MAP)
    assert decide(M, sigs, 0.90)["decision"] == "BUY"
    w = decide(M, sigs, 0.80)
    assert any(h["stop_code"] == "non_positive_edge" for h in w["horizons"])


def test_unvalidated_buy_is_never_published():
    sigs = [_sig(30, "BUY", False), _sig(60), _sig(120), _sig(300)]
    d = decide(M, sigs, 0.80)
    assert d["decision"] == "WAIT" and d["direction"] is None and d["confidence"] is None


def test_scanner_reports_no_qualified_opportunity_and_counts_reasons(settings):
    from eoplatform.service.core import Core
    settings.enable_binance = True
    core = Core(settings)
    core.started -= 1000
    now = time.time()
    core.hub.ingest_bars("BTCUSD", "binance", random_walk_bars(4000, end=int(now), seed=12, p0=65000.0), now=now)
    r = core.auto.scan_report(now)
    assert r["markets_scanned"] == 1 and r["evaluations"] == 4 and r["qualified"] == 0
    assert r["best"] is None and r["message"] == "لا توجد فرصة مؤهلة حاليًا"
    assert sum(r["wait_reasons"].values()) == 4 and len(r["unavailable"]) == 33
    assert core.db.one("SELECT count(*) n FROM orders")["n"] == 0                # analysis only, nothing executed
    # stats of the event-driven scanner (via scan_once)
    core.auto.scan_once(now)
    st = core.auto.stats_view()
    assert st["cycles"] >= 1 and st["qualified_cycles"] == 0 and st["qualified_rate"] == 0.0
