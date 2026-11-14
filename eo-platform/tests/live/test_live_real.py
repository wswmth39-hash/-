"""REAL integration tests — real network, real model. No mocks, no synthetic prices.
Skipped unless EO_LIVE=1, because they need internet access and a running Ollama.

    EO_LIVE=1 python -m pytest -q tests/live -s
"""
import asyncio
import os
import time

import httpx
import pytest

pytestmark = pytest.mark.skipif(os.environ.get("EO_LIVE") != "1", reason="set EO_LIVE=1 for real-network tests")


def test_binance_rest_returns_fresh_closed_kline(settings):
    r = httpx.get(f"{settings.binance_rest}/api/v3/klines",
                  params={"symbol": "BTCUSDT", "interval": "1s", "limit": 3}, timeout=10)
    r.raise_for_status()
    k = r.json()[-2]                     # last fully closed one
    age = time.time() - k[6] / 1000
    print(f"\n  REST last closed 1s kline age {age:.2f}s close {k[4]}")
    assert age < 10 and float(k[4]) > 0


def test_stream_ingest_matches_source_exactly(env):
    """Run the real provider for ~40 s, then compare every stored second with Binance's own record."""
    from eoplatform.data.providers.binance import BinanceProvider
    from eoplatform.data.verify import verify_binance
    from eoplatform.markets import get_market
    s, db, hub, _ = env
    m = get_market(db, "BTCUSD")
    p = BinanceProvider(hub, [m], s.binance_rest, s.binance_ws, backfill_seconds=60)

    async def run():
        stop = asyncio.Event()
        t = asyncio.create_task(p.run(stop))
        for _ in range(40):
            await asyncio.sleep(1)
            hub.tick()
        stop.set(); t.cancel()
    asyncio.run(run())
    hub.tick()
    pv = hub.provider_view()["binance"]
    print(f"\n  provider: {pv}")
    assert pv["connected"] and p.messages >= 20
    time.sleep(3)
    v = verify_binance(db, s.binance_rest, m, seconds=60)
    print(f"  verify: compared {v['compared']} exact {v['exact_matches']} missing {v['missing_in_ours']}")
    assert v["compared"] >= 50 and v["match_rate"] == 1.0


def test_news_calendar_real(settings):
    from eoplatform.data.providers.news import NewsCalendar
    n = NewsCalendar(settings.news_url)
    n.refresh(force=True)
    st = n.status()
    print(f"\n  calendar: {st['events']} events, error={st['error']}")
    assert st["ok"] and st["events"] > 10
    assert {"ts", "currency", "impact", "title"} <= set(n.events[0])


def test_real_local_llm_answers_json(settings):
    from eoplatform.agents.llm import LocalLLM
    # the shared fixture points the LLM at a dead port; live tests use the real server
    settings.llm_base_url = os.environ.get("EO_LIVE_LLM_URL", "http://127.0.0.1:11434/v1")
    llm = LocalLLM(settings)
    h = llm.health(force=True)
    print(f"\n  llm: {h['detail']}")
    assert h["ok"], h
    t = time.time()
    out = llm.ask_json('Classify RSI=78 for a 1-minute chart. Return {"state":"overbought|oversold|neutral"}')
    print(f"  answer {out} in {time.time()-t:.1f}s")
    assert out.get("state") == "overbought"
