"""Independent cross-check of the Binance reference feed (data quality only).

Kraken and Coinbase publish free, key-less 1-minute candles. Every few minutes the closes of
the last complete minutes are compared with Binance's for the SAME minutes. Results are
reported (median / max disagreement) and an alert is raised when the reference feed
disagrees with both independent exchanges. These prices are NEVER written into any series and
never used for signals: Binance quotes USDT, the others USD, so a small basis is expected.
"""
from __future__ import annotations

import logging
import time

import httpx
import numpy as np

log = logging.getLogger("eo.crosscheck")

KRAKEN = {"BTCUSDT": "XBTUSD", "ETHUSDT": "ETHUSD", "LTCUSDT": "LTCUSD", "XRPUSDT": "XRPUSD"}
COINBASE = {"BTCUSDT": "BTC-USD", "ETHUSDT": "ETH-USD", "LTCUSDT": "LTC-USD", "XRPUSDT": "XRP-USD"}
ALERT_PCT = 0.5        # median disagreement above this (in %) with BOTH sources → data alert


def kraken_minutes(pair: str, client: httpx.Client) -> dict[int, float]:
    r = client.get("https://api.kraken.com/0/public/OHLC", params={"pair": pair, "interval": 1})
    r.raise_for_status()
    j = r.json()
    if j.get("error"):
        raise RuntimeError(str(j["error"]))
    rows = next(v for k, v in j["result"].items() if k != "last")
    return {int(x[0]): float(x[4]) for x in rows[:-1]}            # last row is the still-forming minute


def coinbase_minutes(product: str, client: httpx.Client) -> dict[int, float]:
    r = client.get(f"https://api.exchange.coinbase.com/products/{product}/candles", params={"granularity": 60},
                   headers={"User-Agent": "eoplatform/1.1"})
    r.raise_for_status()
    now_min = int(time.time()) // 60 * 60
    return {int(x[0]): float(x[4]) for x in r.json() if int(x[0]) < now_min}


def binance_minutes(db, market: str, since: int) -> dict[int, float]:
    """1-minute closes rebuilt from the stored 1-second bars (complete minutes only)."""
    bars = db.bars(market, "binance", since)
    out: dict[int, tuple[int, float]] = {}
    for ts, _o, _h, _l, c, _n in bars:
        m = int(ts) // 60 * 60
        cnt, _ = out.get(m, (0, 0.0))
        out[m] = (cnt + 1, c)
    return {m: c for m, (cnt, c) in out.items() if cnt >= 55}     # skip minutes with missing seconds


def compare(ref: dict[int, float], other: dict[int, float], last_n: int = 30) -> dict:
    common = sorted(set(ref) & set(other))[-last_n:]
    if not common:
        return {"n": 0}
    d = np.array([abs(ref[t] / other[t] - 1) * 100 for t in common])
    return {"n": len(common), "median_pct": round(float(np.median(d)), 4), "max_pct": round(float(d.max()), 4),
            "from": common[0], "to": common[-1]}


def run_once(db, markets: list[dict], alert=None) -> dict:
    res = {"at": time.time(), "markets": {}}
    with httpx.Client(timeout=15) as client:
        for m in markets:
            sym = m.get("reference_symbol")
            if not sym or m["kind"] != "regular":
                continue
            ref = binance_minutes(db, m["id"], int(time.time()) - 3 * 3600)
            row = {}
            for name, fn, mapping in (("kraken", kraken_minutes, KRAKEN), ("coinbase", coinbase_minutes, COINBASE)):
                if sym not in mapping:
                    continue
                try:
                    row[name] = compare(ref, fn(mapping[sym], client))
                except Exception as e:
                    row[name] = {"n": 0, "error": f"{type(e).__name__}: {e}"[:160]}
            meds = [v["median_pct"] for v in row.values() if v.get("n")]
            row["status"] = ("disagrees" if len(meds) == 2 and min(meds) > ALERT_PCT else
                             "consistent" if meds else "unverified")
            if row["status"] == "disagrees" and alert:
                alert("alert", "quality", f"أسعار Binance المرجعية لـ{m['id']} تختلف عن Kraken وCoinbase "
                                          f"(وسيط {min(meds):.2f}%)")
            res["markets"][m["id"]] = row
    db.kv_set("crosscheck_last", res)
    return res
