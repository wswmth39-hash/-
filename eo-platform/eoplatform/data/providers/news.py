"""Economic-calendar news source (free, key-less JSON published by Fair Economy /
Forex Factory). Verified reachable on 2026-11-14 from this deployment.

What it is used for — honestly scoped:
* It tells the News analyst which scheduled events (CPI, NFP, rate decisions...)
  are imminent for the currencies behind a market. High-impact events near the
  trade window are a RISK factor (volatility, spreads), so they can veto a trade.
* It does NOT provide sentiment or direction. The News analyst never turns a
  calendar entry into BUY or SELL.
* OTC quotes are produced by the broker and are not driven by these events, so
  the analyst reports "not applicable" for OTC markets.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime

import httpx

log = logging.getLogger("eo.news")


def market_currencies(market: dict) -> list[str]:
    mid = market["id"].removesuffix("_OTC")
    if market["category"] == "forex" and len(mid) == 6:
        return [mid[:3], mid[3:]]
    return ["USD"]  # crypto, metals and oil are quoted in USD


class NewsCalendar:
    def __init__(self, url: str, refresh_s: int = 1800):
        self.url, self.refresh_s = url, refresh_s
        self.events: list[dict] = []
        self.fetched_at: float = 0
        self.error: str | None = None

    def refresh(self, force: bool = False) -> None:
        if not force and time.time() - self.fetched_at < self.refresh_s:
            return
        try:
            r = httpx.get(self.url, timeout=15, headers={"User-Agent": "eoplatform/1.1"})
            r.raise_for_status()
            evs = []
            for e in r.json():
                try:
                    ts = datetime.fromisoformat(e["date"]).timestamp()
                except (KeyError, ValueError):
                    continue
                evs.append({"ts": ts, "title": e.get("title", ""), "currency": e.get("country", ""),
                            "impact": e.get("impact", ""), "forecast": e.get("forecast", ""),
                            "previous": e.get("previous", "")})
            self.events, self.fetched_at, self.error = sorted(evs, key=lambda x: x["ts"]), time.time(), None
        except Exception as e:
            self.error = f"{type(e).__name__}: {e}"[:200]
            self.fetched_at = time.time() - self.refresh_s + 300   # retry in 5 min
            log.warning("news calendar fetch failed: %s", self.error)

    def status(self) -> dict:
        return {"ok": bool(self.events) and self.error is None, "events": len(self.events),
                "fetched_at": self.fetched_at or None, "error": self.error, "source": self.url}

    def near(self, currencies: list[str], now: float, window_min: int) -> list[dict]:
        w = window_min * 60
        cur = set(currencies) | {"All"}
        return [e for e in self.events if e["currency"] in cur and -w <= e["ts"] - now <= w
                and e["impact"] in ("High", "Medium")]
