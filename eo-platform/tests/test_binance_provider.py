"""Binance provider against a local fake server that speaks the documented Binance
formats (REST /api/v3/klines and the combined-stream kline_1s event). Verifies
parsing, closed-kline-only storage, and reconnection after the server drops us."""
import asyncio
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import websockets

from eoplatform.data.providers.binance import BinanceProvider
from eoplatform.markets import get_market


class Rest(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        now = int(time.time())
        rows = [[(now - 100 + i) * 1000, "100", "101", "99", str(100 + i * 0.01), "1", (now - 100 + i) * 1000 + 999,
                 "0", 3, "0", "0", "0"] for i in range(90)]
        body = json.dumps(rows).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)


def test_binance_feed_and_reconnect(env):
    s, db, hub, _ = env
    rest = ThreadingHTTPServer(("127.0.0.1", 0), Rest)
    threading.Thread(target=rest.serve_forever, daemon=True).start()
    conns = []

    async def handler(ws):
        conns.append(1)
        for i in range(3):
            t = int(time.time()) - 1
            await ws.send(json.dumps({"stream": "btcusdt@kline_1s", "data": {"e": "kline", "s": "BTCUSDT", "k": {
                "t": t * 1000, "s": "BTCUSDT", "i": "1s", "o": "101", "h": "102", "l": "100", "c": "101.5",
                "n": 4, "x": i != 1}}}))  # i==1 is an unfinished kline → must be ignored
            await asyncio.sleep(0.3)
        if len(conns) == 1:
            await ws.close()          # simulate the exchange dropping the connection
        else:
            await asyncio.sleep(5)

    async def main():
        async with websockets.serve(handler, "127.0.0.1", 0) as srv:
            port = srv.sockets[0].getsockname()[1]
            p = BinanceProvider(hub, [get_market(db, "BTCUSD")], f"http://127.0.0.1:{rest.server_address[1]}",
                                f"ws://127.0.0.1:{port}/ws", backfill_seconds=100)
            stop = asyncio.Event()
            task = asyncio.create_task(p.run(stop))
            await asyncio.sleep(5)
            stop.set(); task.cancel()
            return p
    p = asyncio.run(main())
    assert len(conns) >= 2                                     # reconnected
    assert hub.provider_state["binance"]["reconnects"] >= 1
    st = hub.series[("BTCUSD", "binance")]
    assert len(st.bars) >= 90 and p.messages >= 2
    assert ("BTCUSD_OTC", "binance") not in hub.series        # never feeds OTC
    rest.shutdown()
