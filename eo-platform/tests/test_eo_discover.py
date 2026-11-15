"""tools/eo_discover.py against a LOCAL stand-in server (the real ExpertOption is not reachable from the
build environment). Checks: read-only allow-list, token scrubbing, asset matching, candle request."""
import asyncio
import json
import sys
from pathlib import Path

import pytest
import websockets

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import eo_discover as D  # noqa: E402

TOKEN = "tok-NOT-REAL-1234567890"
ASSETS = [{"id": 1, "name": "Football Index", "symbol": "FTBL"}, {"id": 2, "name": "Smarty", "symbol": "SMRT"},
          {"id": 3, "name": "USD/NGN OTC", "symbol": "USDNGN_OTC", "is_otc": 1},
          {"id": 4, "name": "EUR/USD OTC", "symbol": "EURUSD_OTC", "is_otc": 1},
          {"id": 5, "name": "EUR/USD", "symbol": "EURUSD"},
          {"id": 6, "name": "GBP/USD OTC", "symbol": "GBPUSD_OTC", "is_otc": 1},
          {"id": 7, "name": "USD/JPY OTC", "symbol": "USDJPY_OTC", "is_otc": 1},
          {"id": 8, "name": "Gold", "symbol": "XAUUSD"}, {"id": 9, "name": "Silver", "symbol": "XAGUSD"}]


def test_discovery_against_local_stand_in(tmp_path, monkeypatch):
    seen = []

    async def handler(ws):
        async for raw in ws:
            m = json.loads(raw)
            seen.append(m)
            if m["action"] == "multipleAction":
                await ws.send(json.dumps({"action": "multipleAction", "token": TOKEN, "message": {"actions": [
                    {"action": "assets", "message": {"assets": ASSETS}, "token": TOKEN}]}}))
            elif m["action"] == "assetHistoryCandles":
                await ws.send(json.dumps({"action": "assetHistoryCandles", "token": TOKEN,
                                          "message": {"assetid": m["message"]["assetid"], "candles": [[1, 2, 3]]}}))

    async def run():
        async with websockets.serve(handler, "127.0.0.1", 0) as srv:
            port = srv.sockets[0].getsockname()[1]
            monkeypatch.setitem(D.REGIONS, "eu", f"ws://127.0.0.1:{port}/")
            monkeypatch.setattr(D, "Session", type("S", (D.Session,), {}))
            orig = D.Session.collect

            async def fast(self, seconds):
                await orig(self, min(seconds, 0.6))
            monkeypatch.setattr(D.Session, "collect", fast)
            env = tmp_path / ".env"
            env.write_text(f"EO_EXPERTOPTION_TOKEN={TOKEN}\n")
            out = tmp_path / "out.json"
            monkeypatch.setattr(sys, "argv", ["x", "--env", str(env), "--out", str(out)])
            await D.main()
            return out
    out = asyncio.run(run())
    text = out.read_text()
    assert TOKEN not in text                                         # token scrubbed from the saved report
    rep = json.loads(text)
    assert rep["assets_total"] == 9
    m = rep["matches"]
    assert [h["id"] for h in m["EUR/USD (OTC)"]] == [4]              # OTC, not the regular pair
    for label in ("Football Index", "Smarty", "USD/NGN (OTC)", "GBP/USD (OTC)", "USD/JPY (OTC)", "Gold", "Silver"):
        assert m[label], label
    assert any(x["action"] == "assetHistoryCandles" for x in seen) and rep["history_samples"]
    assert all(x["action"] in D.READ_ONLY_ACTIONS for x in seen)    # nothing but read-only actions went out


def test_buy_is_refused_by_the_allow_list():
    class W:
        async def send(self, _):
            raise AssertionError("must not be sent")
    s = D.Session(W(), TOKEN)
    with pytest.raises(RuntimeError, match="read-only"):
        asyncio.run(s.send("buyOption", {}))
    with pytest.raises(RuntimeError, match="read-only"):
        asyncio.run(s.send("multipleAction", {"actions": [{"action": "buyOption"}]}))
