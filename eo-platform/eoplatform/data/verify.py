"""End-to-end price verification against the source itself.

Downloads Binance's own 1-second klines for a recent window and compares them with
the bars this platform stored from the live stream, second by second. This is the
evidence behind "prices match the source"; nothing here is inferred."""
from __future__ import annotations

import time

import httpx


def verify_binance(db, rest_base: str, market: dict, seconds: int = 120) -> dict:
    end = int(time.time()) - 3
    start = end - seconds
    r = httpx.get(f"{rest_base.rstrip('/')}/api/v3/klines", timeout=15,
                  params={"symbol": market["reference_symbol"], "interval": "1s",
                          "startTime": start * 1000, "endTime": end * 1000, "limit": 1000})
    r.raise_for_status()
    src = {k[0] // 1000: (float(k[1]), float(k[2]), float(k[3]), float(k[4])) for k in r.json()}
    ours = {b[0]: b[1:5] for b in db.bars(market["id"], "binance", start, end)}
    common = sorted(set(src) & set(ours))
    exact = sum(1 for t in common if all(abs(a - b) <= 1e-9 * max(1, abs(b)) for a, b in zip(ours[t], src[t])))
    mism = [{"ts": t, "ours": ours[t], "source": src[t]} for t in common
            if not all(abs(a - b) <= 1e-9 * max(1, abs(b)) for a, b in zip(ours[t], src[t]))][:5]
    return {"market": market["id"], "symbol": market["reference_symbol"], "window": [start, end],
            "source_bars": len(src), "stored_bars": len(ours), "compared": len(common), "exact_matches": exact,
            "match_rate": round(exact / len(common), 6) if common else None,
            "missing_in_ours": len(set(src) - set(ours)), "examples_of_mismatch": mism,
            "checked_at": time.time()}
