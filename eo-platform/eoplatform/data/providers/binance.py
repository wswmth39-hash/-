"""Binance public market data — REFERENCE data for regular crypto markets only.

Uses the public, key-less market-data endpoints (data-api.binance.vision /
data-stream.binance.vision), which Binance documents for exactly this purpose.
This is NOT ExpertOption's quote: ExpertOption prices its crypto instruments
from its own liquidity, so small differences are expected. It is never used for
OTC markets (enforced in markets.allowed_sources and asserted here).

Not verified from the build environment (its network blocks Binance); run
``python -m eoplatform check-sources`` on your machine to verify it.
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import time

import httpx
import websockets

from ..hub import DataHub

log = logging.getLogger("eo.binance")
SOURCE = "binance"


class BinanceProvider:
    def __init__(self, hub: DataHub, markets: list[dict], rest_base: str, ws_base: str,
                 backfill_seconds: int = 3600, silence_timeout: float = 30.0):
        for m in markets:
            assert m["kind"] == "regular" and m.get("reference_symbol"), "reference feed for regular markets only"
        self.hub = hub
        self.by_symbol = {m["reference_symbol"].upper(): m["id"] for m in markets}
        self.rest_base = rest_base.rstrip("/")
        self.ws_base = ws_base.rstrip("/")
        self.backfill_seconds = backfill_seconds
        self.silence_timeout = silence_timeout
        self.messages = 0

    async def backfill(self, client: httpx.AsyncClient) -> None:
        end_ms = int(time.time() * 1000)
        for sym, mid in self.by_symbol.items():
            start_ms = end_ms - self.backfill_seconds * 1000
            total = 0
            while start_ms < end_ms:
                r = await client.get(f"{self.rest_base}/api/v3/klines",
                                     params={"symbol": sym, "interval": "1s", "startTime": start_ms, "limit": 1000})
                r.raise_for_status()
                rows = r.json()
                if not rows:
                    break
                bars = [(k[0] // 1000, float(k[1]), float(k[2]), float(k[3]), float(k[4]), 1)
                        for k in rows if k[6] < time.time() * 1000]  # closed klines only
                self.hub.ingest_bars(mid, SOURCE, bars, live=False)
                total += len(bars)
                start_ms = rows[-1][0] + 1000
                if len(rows) < 1000:
                    break
            log.info("binance backfill %s: %d bars", sym, total)

    def _handle(self, raw: str | bytes) -> None:
        msg = json.loads(raw)
        data = msg.get("data", msg)
        if data.get("e") != "kline":
            return
        k = data["k"]
        if not k.get("x"):
            return  # only closed 1-second klines are stored
        mid = self.by_symbol.get(k["s"].upper())
        if mid is None:
            return
        self.messages += 1
        self.hub.ingest_bars(mid, SOURCE, [(k["t"] // 1000, float(k["o"]), float(k["h"]),
                                            float(k["l"]), float(k["c"]), int(k.get("n", 1)) or 1)])

    async def run(self, stop: asyncio.Event) -> None:
        """Connect, backfill, stream; reconnect with jittered exponential backoff forever."""
        if not self.by_symbol:
            return
        delay = 1.0
        streams = "/".join(f"{s.lower()}@kline_1s" for s in self.by_symbol)
        url = f"{self.ws_base.removesuffix('/ws')}/stream?streams={streams}"
        while not stop.is_set():
            try:
                async with httpx.AsyncClient(timeout=15) as client:
                    await self.backfill(client)
                async with websockets.connect(url, ping_interval=20, ping_timeout=20, open_timeout=15) as ws:
                    self.hub.set_provider_state(SOURCE, True, "stream connected")
                    delay = 1.0
                    while not stop.is_set():
                        try:
                            raw = await asyncio.wait_for(ws.recv(), timeout=self.silence_timeout)
                        except asyncio.TimeoutError:
                            raise ConnectionError(f"no data for {self.silence_timeout}s") from None
                        try:
                            self._handle(raw)
                        except (ValueError, KeyError, TypeError) as e:
                            self.hub.provider_error(SOURCE)
                            log.warning("bad binance message: %s", e)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # network errors, HTTP errors, server closes
                self.hub.provider_error(SOURCE)
                self.hub.set_provider_state(SOURCE, False, f"{type(e).__name__}: {e}"[:300])
                log.warning("binance feed error (%s); reconnecting in %.0fs", e, delay)
                try:
                    await asyncio.wait_for(stop.wait(), timeout=delay + random.random())
                except asyncio.TimeoutError:
                    pass
                delay = min(delay * 2, 60.0)
        self.hub.set_provider_state(SOURCE, False, "stopped")
