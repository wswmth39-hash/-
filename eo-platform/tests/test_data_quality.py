"""V4 phase 2 — data health, spikes, gaps, availability. Synthetic prices only (test DBs)."""
import time

import numpy as np

from conftest import random_walk_bars
from eoplatform.data import quality as DQ
from eoplatform.engine import features as F
from eoplatform.engine.fast import analyze
from eoplatform.markets import get_market


def test_no_false_spikes_on_normal_random_walks():
    flagged = 0
    for seed in range(20):
        b = np.asarray(random_walk_bars(3600, end=2_000_000_000, seed=seed, vol=2e-4), dtype=float)
        sp, sigma = DQ._spikes(b[:, 4], b[:, 0].astype(np.int64))
        flagged += len(sp)
        assert sigma and sigma > 0
    assert flagged == 0                                    # 72,000 normal seconds: no false alarm


def test_injected_jump_is_detected_and_blocks_analysis(env):
    s, db, hub, reg = env
    now = time.time()
    bars = [list(b) for b in random_walk_bars(3000, end=int(now), seed=3, p0=65000.0, vol=1e-4)]
    i = len(bars) - 30                                     # 30 s ago: +3 % in one second
    for b in bars[i:]:
        for k in (1, 2, 3, 4):
            b[k] *= 1.03
    hub.ingest_bars("BTCUSD", "binance", [tuple(b) for b in bars], now=now)
    h = DQ.health(hub, "BTCUSD", "binance", now)
    assert h["recent_spike"] and h["spikes_last_hour"] >= 1 and "data_anomaly" in h["reasons"] and not h["usable"]
    sig = analyze(get_market(db, "BTCUSD"), 60, hub, reg, s, now=now)
    assert sig["decision"] == "WAIT" and sig["abstain_reason"]["code"] == "data_anomaly"
    assert sig["data_health"]["recent_spike"] is True


def test_gaps_duplicates_and_last_update_are_measured(env):
    s, db, hub, reg = env
    now = time.time()
    bars = random_walk_bars(1200, end=int(now), seed=4, p0=3000.0)
    kept = [b for j, b in enumerate(bars) if not (500 <= j < 560)]     # a 60-second hole
    hub.ingest_bars("ETHUSD", "binance", kept, now=now)
    hub.ingest_bars("ETHUSD", "binance", kept[-5:], now=now)          # duplicates are rejected
    h = DQ.health(hub, "ETHUSD", "binance", now)
    assert h["gaps_last_hour"] == 60 and h["longest_gap_s"] == 60 and h["duplicates_rejected"] == 5
    assert h["last_bar_ts"] == int(kept[-1][0]) and h["last_bar_utc"].endswith("UTC") and h["age_s"] is not None
    assert h["state"] == "LIVE" and h["usable"]


def test_stale_data_is_not_usable(env):
    s, db, hub, reg = env
    t = time.time() - 600
    hub.ingest_bars("LTCUSD", "binance", random_walk_bars(600, end=int(t), seed=5, p0=80.0), now=t)
    h = DQ.health(hub, "LTCUSD", "binance")
    assert not h["usable"] and "not_live" in h["reasons"] and h["age_s"] > 500


def test_availability_lists_and_reasons(settings):
    from eoplatform.service.core import Core
    settings.enable_binance = True
    core = Core(settings)
    core.started -= 1000                                   # past the startup window
    now = time.time()
    core.hub.ingest_bars("BTCUSD", "binance", random_walk_bars(900, end=int(now), seed=6, p0=65000.0), now=now)
    from eoplatform.markets import list_markets
    avail, unavail = DQ.split_markets(core, list_markets(core.db), now)
    assert [a["market"] for a in avail] == ["BTCUSD"] and avail[0]["source"] == "binance"
    codes = {u["market"]: u["code"] for u in unavail}
    assert codes["EURUSD_OTC"] == "otc_requires_bridge" and codes["EURUSD"] == "no_allowed_source"
    assert codes["XAUUSD"] == "no_allowed_source" and codes["ETHUSD"] == "no_data_yet"
    assert all(u["reason_ar"] for u in unavail) and len(avail) + len(unavail) == 34
    settings.enable_binance = False
    assert DQ.availability(core, get_market(core.db, "BTCUSD"), now)["code"] == "provider_disabled"


def test_first_candle_is_whole_so_features_and_cache_are_stable(env):
    """The analysis window start moves each second; features must not change until a candle closes."""
    s, db, hub, reg = env
    end = (int(time.time()) // 60) * 60 - 1               # just before a 60 s boundary
    hub.ingest_bars("BTCUSD", "binance", random_walk_bars(20000, end=end - 20, seed=7, p0=65000.0), now=end - 20)
    m = get_market(db, "BTCUSD")
    F.CACHE_STATS.update(hits=0, misses=0)
    rows = []
    for k in range(3):                                     # three different "now"s inside the same 5 s candle
        hub.ingest_bars("BTCUSD", "binance", random_walk_bars(1, end=end - 19 + k, seed=100 + k, p0=65000.0),
                        now=end - 19 + k)
        sig = analyze(m, 300, hub, reg, s, now=end - 19 + k)
        rows.append(sig.get("features"))
    assert F.CACHE_STATS["hits"] >= 1
    assert rows[0] == rows[1] or rows[1] == rows[2]
