import time

import numpy as np
import pytest

from eoplatform.data.hub import resample
from eoplatform.data.providers import bridge
from eoplatform.data.providers.binance import BinanceProvider
from eoplatform.markets import allowed_sources, get_market, list_markets


def test_otc_markets_only_accept_expertoption(env):
    _, db, hub, _ = env
    for m in list_markets(db):
        if m["kind"] == "otc":
            assert allowed_sources(m) == ["expertoption"]
            assert m["reference_symbol"] is None
    # even a hand-edited row is repaired on startup
    db.execute("UPDATE markets SET reference_symbol='BTCUSDT' WHERE id='BTCUSD_OTC'")
    from eoplatform.markets import ensure_catalog
    ensure_catalog(db)
    assert get_market(db, "BTCUSD_OTC")["reference_symbol"] is None
    with pytest.raises(AssertionError):
        BinanceProvider(hub, [get_market(db, "BTCUSD_OTC")], "http://x", "ws://x")


def test_tick_aggregation_and_validation(env):
    _, db, hub, _ = env
    now = 1_800_000_000.0
    ticks = [(now - 10.9, 1.0), (now - 10.5, 1.05), (now - 10.1, 0.98), (now - 9.5, 1.02)]
    r = hub.ingest_ticks("EURUSD_OTC", "expertoption", ticks, now=now)
    assert r == {"accepted": 4, "rejected": 0}
    bad = [(now * 1000, 1.1), (now + 3600, 1.1), (now - 9, -1), (now - 9, float("nan")), (now - 8, 5.0), (500.0, 1.1)]
    r = hub.ingest_ticks("EURUSD_OTC", "expertoption", bad, now=now)
    assert r["accepted"] == 0
    s = hub.series[("EURUSD_OTC", "expertoption")]
    assert set(s.rejected) >= {"time_in_ms", "time_in_future", "bad_price", "price_jump", "time_too_old"}
    hub.tick(now=now)
    b = hub.bars("EURUSD_OTC", "expertoption", 100)
    assert b[0].tolist() == [now - 11, 1.0, 1.05, 0.98, 0.98, 3]
    assert db.bars("EURUSD_OTC", "expertoption", 0)[0][:5] == (int(now - 11), 1.0, 1.05, 0.98, 0.98)


def test_freshness_states(env):
    _, _, hub, _ = env
    now = time.time()
    hub.ingest_ticks("EURUSD_OTC", "expertoption", [(now - 0.5, 1.1)], now=now)
    m = {"id": "EURUSD_OTC", "kind": "otc"}
    assert hub.best_source(m, now + 1) == ("expertoption", "LIVE")
    assert hub.best_source(m, now + 6)[1] == "DELAYED"
    assert hub.best_source(m, now + 30)[1] == "STALE"
    assert hub.best_source(m, now + 120)[1] == "OFFLINE"


def test_historical_import_never_looks_live(env, tmp_path):
    _, db, hub, _ = env
    from eoplatform.data.providers.csv_import import import_csv
    now = time.time()
    p = tmp_path / "h.csv"
    p.write_text("ts,price\n" + "\n".join(f"{now - 500 + i},{1.1 + i * 1e-5}" for i in range(400)))
    r = import_csv(db, hub, p, "EURUSD_OTC", "expertoption")
    assert r["accepted"] == 400
    assert hub.best_source({"id": "EURUSD_OTC", "kind": "otc"})[1] != "LIVE"
    with pytest.raises(ValueError):
        import_csv(db, hub, p, "EURUSD_OTC", "binance")  # OTC accepts ExpertOption data only


def test_resample_matches_naive():
    rng = np.random.default_rng(3)
    ts = np.sort(rng.choice(np.arange(1000, 1300), 200, replace=False))
    bars = np.array([[t, 1 + rng.random(), 3, 0, 1 + rng.random(), 1] for t in ts], float)
    out = resample(bars, 10)
    for row in out:
        seg = bars[(bars[:, 0] >= row[0]) & (bars[:, 0] < row[0] + 10)]
        assert row[1] == seg[0, 1] and row[4] == seg[-1, 4] and row[5] == len(seg)


def test_bridge_token_and_market_resolution(env):
    _, db, hub, _ = env
    tok = bridge.new_token(db)
    assert bridge.verify_token(db, tok) and not bridge.verify_token(db, tok + "x") and not bridge.verify_token(db, None)
    assert bridge.resolve_market(db, "EUR/USD OTC", None)["id"] == "EURUSD_OTC"
    assert bridge.resolve_market(db, "EUR/USD", None)["id"] == "EURUSD"
    assert bridge.resolve_market(db, "EURUSD_OTC", False) is None  # flagged regular but OTC market → refused
    now = time.time()
    r = bridge.ingest(db, hub, {"assets": [{"asset": "EUR/USD OTC", "otc": True, "ticks": [[now, 1.1]]},
                                           {"asset": "MYSTERY", "ticks": [[now, 1.0]]}]})
    assert r["accepted"] == 1 and r["unknown_assets"] == ["MYSTERY"]
    assert get_market(db, "EURUSD_OTC")["catalog_verified"] == 1
    assert db.kv_get("bridge_unknown_assets") == ["MYSTERY"]
