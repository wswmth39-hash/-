"""Cross-check provider: compares minutes, never writes prices, alerts only on disagreement with both."""
import time

from eoplatform.data.providers import crosscheck as X
from eoplatform.markets import get_market


def test_compare_and_status(env, monkeypatch):
    s, db, hub, reg = env
    now = int(time.time()) // 60 * 60
    bars = [(now - 3600 + i, 100.0, 100.0, 100.0, 100.0, 1) for i in range(3600)]
    db.upsert_bars("BTCUSD", "binance", bars)
    n_bars = db.one("SELECT count(*) n FROM bars1s")["n"]
    minutes = {now - 3600 + 60 * k: 100.03 for k in range(60)}
    monkeypatch.setattr(X, "kraken_minutes", lambda pair, c: minutes)
    monkeypatch.setattr(X, "coinbase_minutes", lambda prod, c: {k: 101.0 for k in minutes})
    alerts = []
    r = X.run_once(db, [get_market(db, "BTCUSD")], alert=lambda *a: alerts.append(a))
    row = r["markets"]["BTCUSD"]
    assert row["kraken"]["median_pct"] < 0.05 and row["coinbase"]["median_pct"] > 0.9
    assert row["status"] == "consistent" and not alerts           # one source agrees → no alert
    monkeypatch.setattr(X, "kraken_minutes", lambda pair, c: {k: 102.0 for k in minutes})
    r = X.run_once(db, [get_market(db, "BTCUSD")], alert=lambda *a: alerts.append(a))
    assert r["markets"]["BTCUSD"]["status"] == "disagrees" and alerts
    assert db.one("SELECT count(*) n FROM bars1s")["n"] == n_bars     # nothing written to the series
    assert db.kv_get("crosscheck_last")["markets"]["BTCUSD"]["status"] == "disagrees"


def test_incomplete_minutes_are_skipped(env):
    s, db, hub, reg = env
    now = int(time.time()) // 60 * 60
    db.upsert_bars("BTCUSD", "binance", [(now - 120 + i, 1, 1, 1, 1, 1) for i in range(0, 120, 3)])  # 20/60 seconds
    assert X.binance_minutes(db, "BTCUSD", now - 200) == {}
