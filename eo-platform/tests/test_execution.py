"""Execution engine, risk manager, kill switch and AUTO scanner (synthetic prices in temp DBs only)."""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from eoplatform.execution import brokers as B
from eoplatform.execution.engine import ExecutionEngine
from eoplatform.service.alerts import Alerter


def _sig(now, **kw):
    s = {"id": 1, "market": "EURUSD_OTC", "kind": "otc", "duration": 60, "decision": "BUY", "candidate": "BUY",
         "validated": True, "data_state": "LIVE", "data_source": "expertoption", "timestamp": now,
         "confidence": 0.62, "confidence_detail": {"wilson_lb": 0.6, "oos_samples": 500}}
    s.update(kw)
    return s


@pytest.fixture
def ex(env):
    s, db, hub, _ = env
    alerts = []
    e = ExecutionEngine(db, hub, s, alert=lambda *a, **k: alerts.append(a))
    e.alerts = alerts
    now = time.time()
    hub.ingest_ticks("EURUSD_OTC", "expertoption", [(now - 0.2, 1.1000)], now=now)
    return e


def test_analysis_mode_sends_nothing(ex):
    assert ex.submit_from_signal(_sig(time.time()))["status"] == "analysis_only"
    assert ex.db.one("SELECT count(*) n FROM orders")["n"] == 0


def test_real_money_execution_is_out_of_scope(ex):
    with pytest.raises(ValueError, match="outside the scope"):
        ex.set_config({"mode": "live"})
    assert not hasattr(B, "ExpertOptionBroker")                       # no real broker adapter exists at all
    assert [b["name"] for b in ex.brokers()] == ["paper", "real_money"]
    assert ex.brokers()[1]["available"] is False


def test_paper_order_lifecycle_and_idempotency(ex):
    ex.set_config({"mode": "paper", "stake": 5, "max_stake_pct": 5})
    now = time.time()
    r = ex.submit_from_signal(_sig(now))
    assert r["status"] == "confirmed" and r["broker_ref"].startswith("paper-")
    assert ex.submit_from_signal(_sig(now))["status"] == "duplicate_blocked"      # same signal → never twice
    assert ex.state()["paper_balance"] == 995
    o = ex.db.one("SELECT * FROM orders WHERE id=?", (r["order_id"],))
    # genuine-looking expiry bar (synthetic, test DB): price rose → BUY wins
    ex.db.upsert_bars("EURUSD_OTC", "expertoption", [(int(o["expiry_ts"]) - 1, 1.1, 1.2, 1.1, 1.15, 1)])
    assert ex.settle(now=o["expiry_ts"] + 10) == 1
    o = ex.db.one("SELECT * FROM orders WHERE id=?", (r["order_id"],))
    assert o["result"] == "win" and o["pnl"] == pytest.approx(5 * ex.s.payout)
    assert ex.state()["paper_balance"] == pytest.approx(1000 + 5 * ex.s.payout)
    events = [x["event"] for x in ex.db.all("SELECT event FROM execution_log ORDER BY id")]
    assert events[-4:] == ["submitted", "confirmed", "duplicate_blocked", "settled"] or "settled" in events


def test_no_live_price_means_broker_rejects(ex):
    ex.set_config({"mode": "paper"})
    sig = _sig(time.time(), market="GBPUSD_OTC", id=7)
    r = ex.submit_from_signal(sig)
    assert r["status"] == "rejected"           # request sent but NOT confirmed → not a trade
    assert ex.state()["paper_balance"] == 1000


@pytest.mark.parametrize("kw,reason", [
    ({"validated": False}, "مُتحقق"), ({"data_state": "STALE"}, "حية"), ({"decision": "WAIT"}, "مُتحقق"),
    ({"timestamp": 0}, "قديمة"), ({"confidence_detail": {"wilson_lb": 0.5}}, "العائد المتوقع"),
])
def test_risk_rejections(ex, kw, reason):
    ex.set_config({"mode": "paper"})
    r = ex.submit_from_signal(_sig(time.time(), **kw))
    assert r["status"] == "risk_rejected" and any(reason in x for x in r["reasons"]), r


def test_stake_and_balance_limits(ex):
    ex.set_config({"mode": "paper", "stake": 10, "max_stake": 10, "max_stake_pct": 0.5})
    r = ex.submit_from_signal(_sig(time.time()))
    assert r["status"] == "risk_rejected" and any("%" in x for x in r["reasons"])
    with pytest.raises(ValueError):
        ex.set_config({"stake": 50, "max_stake": 10})


def test_consecutive_losses_auto_halt_and_kill_switch(ex):
    ex.set_config({"mode": "paper", "max_consecutive_losses": 2, "cooldown_s": 0, "max_stake_pct": 5,
                   "auto_enabled": True})
    for i in range(2):
        now = time.time()
        ex.hub.ingest_ticks("EURUSD_OTC", "expertoption", [(now, 1.1 + i * 0.001)], now=now)
        r = ex.submit_from_signal(_sig(now, id=100 + i))
        assert r["status"] == "confirmed", r
        o = ex.db.one("SELECT * FROM orders WHERE id=?", (r["order_id"],))
        ex.db.upsert_bars("EURUSD_OTC", "expertoption", [(int(o["expiry_ts"]) - 1, 1, 1, 1, o["entry_price"] - 0.01, 1)])
        ex.settle(now=o["expiry_ts"] + 10)
    st = ex.state()
    assert st["halted"] and "متتالية" in st["halt_reason"]
    assert ex.config()["auto_enabled"] is False and ex.alerts
    r = ex.submit_from_signal(_sig(time.time(), id=999))
    assert r["status"] == "risk_rejected"
    ex.resume()
    ex.kill("test")
    assert ex.state()["kill_switch"]
    assert any("الإيقاف الطارئ" in x for x in ex.submit_from_signal(_sig(time.time(), id=1000))["reasons"])


def test_void_when_no_genuine_expiry_price_refunds(ex):
    ex.set_config({"mode": "paper"})
    r = ex.submit_from_signal(_sig(time.time(), id=55))
    o = ex.db.one("SELECT * FROM orders WHERE id=?", (r["order_id"],))
    ex.settle(now=o["expiry_ts"] + 10)
    o = ex.db.one("SELECT * FROM orders WHERE id=?", (r["order_id"],))
    assert o["result"] == "void" and o["pnl"] == 0 and ex.state()["paper_balance"] == 1000


def test_alert_webhook_posts_and_rate_limits(env):
    got = []

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            got.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            self.send_response(200); self.end_headers()
    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    a = Alerter(env[1], f"http://127.0.0.1:{srv.server_address[1]}/hook")
    a("critical", "execution", "test halt")
    a("critical", "execution", "test halt")       # duplicate within 5 min → suppressed
    time.sleep(1)
    assert len(got) == 1 and got[0]["message"] == "test halt" and a.status()["sent"] == 1
    srv.shutdown()


def test_auto_scanner_abstains_without_validated_model(settings):
    from conftest import random_walk_bars
    from eoplatform.service.core import Core
    core = Core(settings)
    end = (int(time.time()) // 60) * 60          # bars end exactly at a minute boundary
    bars = random_walk_bars(3000, end=end)
    core.hub.ingest_bars("EURUSD_OTC", "expertoption", bars, now=end + 0.2)
    core.execution.set_config({"mode": "paper", "durations": [30, 60, 120, 300]})
    res = core.auto.scan_once(now=end + 0.4)      # right after every analysis candle closed
    assert res["evaluated"] == 4                  # all four durations compared
    assert res["chosen"] is None and "لا توجد فرصة مؤهلة حاليًا" in res["why"]   # V4 wording (phase 7)
    assert core.db.one("SELECT count(*) n FROM orders")["n"] == 0


def test_auto_scanner_picks_validated_opportunity_and_paper_trades(settings):
    """Planted learnable edge → validated champion → AUTO chooses it → confirmed paper order."""
    import numpy as np
    from conftest import trending_regime_bars
    from eoplatform.learning import trainer
    from eoplatform.markets import get_market
    from eoplatform.service.core import Core
    core = Core(settings)
    end = (int(time.time()) // 60) * 60
    bars = trending_regime_bars(24000, end=end, seed=2)
    m = get_market(core.db, "EURUSD_OTC")
    res = trainer.train_one(core.db, core.registry, settings, m, 30, "expertoption", np.array(bars[:-2500], float))
    assert res["status"] == "champion", res
    core.execution.set_config({"mode": "paper", "durations": [30], "stake": 1, "max_stake_pct": 5, "cooldown_s": 0,
                               "max_open": 50, "max_trades_per_hour": 500})
    chosen = []
    core.hub.ingest_bars("EURUSD_OTC", "expertoption", bars[:-2500], now=bars[-2501][0] + 1, live=False)
    # replay the last 2500 seconds as a live feed, one 1-second bar at a time; scan right after
    # each 5-second candle close (the moment the scanner wakes in production)
    for i in range(len(bars) - 2500, len(bars)):
        t = bars[i][0] + 1
        core.hub.ingest_bars("EURUSD_OTC", "expertoption", [bars[i]], now=t + 0.2)
        if t % 5:
            continue
        r = core.auto.scan_once(now=t + 0.4)
        if r["chosen"]:
            chosen.append(r)
            if len(chosen) >= 3:
                break
    assert chosen, "a validated opportunity should be chosen at least once on the planted edge"
    r = chosen[0]
    assert r["execution"]["status"] == "confirmed", r["execution"]
    assert r["chosen"]["auto_choice"]["edge_lb"] > 0
    assert "إغلاق شمعة" in r["chosen"]["auto_choice"]["timing"]
    assert core.db.one("SELECT count(*) n FROM orders WHERE status='confirmed'")["n"] >= 1
