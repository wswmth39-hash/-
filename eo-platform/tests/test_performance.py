"""Load, concurrency and robustness tests for the real-time engine (synthetic prices, temp DBs)."""
import asyncio
import statistics
import threading
import time

import numpy as np

from conftest import random_walk_bars
from eoplatform.engine.fast import analyze
from eoplatform.markets import get_market

MARKETS = ["EURUSD_OTC", "GBPUSD_OTC", "USDJPY_OTC", "BTCUSD_OTC"]


def _load(hub, end, n=5000):
    for i, m in enumerate(MARKETS):
        bars = random_walk_bars(n, end=end, seed=100 + i)
        hub.ingest_bars(m, "expertoption", bars, now=end + 0.2)


def test_high_load_p95_under_100ms(env):
    s, db, hub, reg = env
    end = (int(time.time()) // 60) * 60
    _load(hub, end)
    ms = {m: get_market(db, m) for m in MARKETS}
    lat = []
    for i in range(400):
        for m in MARKETS:
            d = (30, 60, 120, 300)[i % 4]
            t = time.perf_counter()
            sig = analyze(ms[m], d, hub, reg, s, now=end + 0.5)
            lat.append((time.perf_counter() - t) * 1000)
            assert sig["decision"] in ("BUY", "SELL", "WAIT") and sig["signal_class"]
    lat.sort()
    p50, p95 = statistics.median(lat), lat[int(len(lat) * 0.95)]
    print(f"\n  {len(lat)} analyses: p50 {p50:.2f} ms, p95 {p95:.2f} ms, max {lat[-1]:.2f} ms")
    assert p95 < 100


def test_concurrent_analysis_and_ingest(env):
    s, db, hub, reg = env
    end = int(time.time())
    _load(hub, end, 3000)
    errors, done = [], []
    stop = threading.Event()

    def writer():
        t = end
        while not stop.is_set():
            t += 1
            for m in MARKETS:
                hub.ingest_bars(m, "expertoption", [(t, 1.1, 1.1001, 1.0999, 1.1, 1)], now=time.time())
            hub.tick()

    def reader(k):
        try:
            for i in range(60):
                sig = analyze(get_market(db, MARKETS[(k + i) % 4]), 60, hub, reg, s)
                assert sig["decision"] in ("BUY", "SELL", "WAIT")
                done.append(1)
        except Exception as e:  # pragma: no cover - reported below
            errors.append(repr(e))
    w = threading.Thread(target=writer)
    w.start()
    readers = [threading.Thread(target=reader, args=(k,)) for k in range(8)]
    t0 = time.perf_counter()
    for r in readers:
        r.start()
    for r in readers:
        r.join()
    stop.set()
    w.join()
    print(f"\n  8 threads × 60 analyses with a concurrent writer: {len(done)} ok in {time.perf_counter()-t0:.2f}s")
    assert not errors and len(done) == 480


def test_missing_candles_and_frozen_feed_wait(env):
    s, db, hub, reg = env
    end = int(time.time())
    bars = random_walk_bars(3000, end=end, seed=7)
    gap = bars[:-200] + bars[-150:]                  # 50 seconds missing near the end
    hub.ingest_bars("EURUSD_OTC", "expertoption", gap, now=end + 0.2)
    sig = analyze(get_market(db, "EURUSD_OTC"), 30, hub, reg, s, now=end + 0.5)
    assert sig["decision"] == "WAIT" and any("متصلة" in r for r in sig["reasons"])
    # frozen: identical OHLC for > 2 minutes while "live"
    flat = [(end + i, 1.2, 1.2, 1.2, 1.2, 1) for i in range(1, 200)]
    hub.ingest_bars("GBPUSD_OTC", "expertoption", random_walk_bars(2000, end=end, seed=8) + flat, now=end + 200.2)
    hub.tick(now=end + 200.3)
    assert hub.quality["GBPUSD_OTC"]["frozen_expertoption"] is True
    sig = analyze(get_market(db, "GBPUSD_OTC"), 30, hub, reg, s, now=end + 200.5)
    assert sig["decision"] == "WAIT" and sig["signal_class"] in ("UNRELIABLE_DATA", "BLOCKED", "WEAK")


def test_event_driven_auto_pipeline(settings):
    """Bar-close events → per-market analysis → cross-market ranking, through the real asyncio path."""
    from eoplatform.service.core import Core
    core = Core(settings)
    end = int(time.time()) // 60 * 60 + 60           # the next minute boundary
    for i, m in enumerate(MARKETS):                   # live feeds up to just before the boundary
        core.hub.ingest_bars(m, "expertoption", random_walk_bars(4000, end=end - 1, seed=100 + i), now=time.time())
    core.execution.set_config({"durations": [30, 60]})

    async def go():
        task = asyncio.create_task(core.auto.run())
        await asyncio.sleep(0.05)
        for m in MARKETS:                               # last 1s bar of the minute closes for each market
            core.hub.ingest_bars(m, "expertoption", [(end - 1, 1.1, 1.1, 1.1, 1.1, 1)], now=time.time())
        await asyncio.sleep(0.6)
        task.cancel()
    asyncio.run(go())
    s = core.metrics.summary()["series"]
    assert s["data_to_signal_ms"]["n"] == len(MARKETS)
    assert s["auto_decision_ms"]["n"] == 1
    assert core.auto.board["evaluated"] == len(MARKETS) * 2
    print(f"\n  event path: data→signal p50 {s['data_to_signal_ms']['p50']:.1f} ms, "
          f"auto decision {s['auto_decision_ms']['p50']:.1f} ms")
