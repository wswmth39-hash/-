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
    def __init__(self, url: str, refresh_s: int = 1800, db=None):
        self.url, self.refresh_s, self.db = url, refresh_s, db
        self.events: list[dict] = []
        self.fetched_at: float = 0
        self.error: str | None = None
        # Reuse the last download across restarts (found in production: frequent restarts
        # re-downloaded the calendar and the publisher answered 429 Too Many Requests).
        if db is not None:
            cached = db.kv_get("news_cache")
            if cached and time.time() - cached.get("fetched_at", 0) < refresh_s:
                self.events, self.fetched_at = cached["events"], cached["fetched_at"]

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
            if self.db is not None:
                self.db.kv_set("news_cache", {"events": self.events, "fetched_at": self.fetched_at})
        except Exception as e:
            self.error = f"{type(e).__name__}: {e}"[:200]
            rate_limited = isinstance(e, httpx.HTTPStatusError) and e.response.status_code == 429
            # retry in 5 min, or 30 min when the publisher asks us to slow down
            self.fetched_at = time.time() - self.refresh_s + (1800 if rate_limited else 300)
            if self.events:   # keep serving the last good calendar, but say it is stale
                self.error += " — serving last good copy"
            log.warning("news calendar fetch failed: %s", self.error)

    def status(self) -> dict:
        # a previous good copy younger than 12 h is still usable (events are scheduled in advance)
        fresh = bool(self.events) and (self.error is None or time.time() - self.last_good() < 12 * 3600)
        return {"ok": fresh, "events": len(self.events),
                "fetched_at": self.fetched_at or None, "error": self.error, "source": self.url}

    def last_good(self) -> float:
        if self.db is not None:
            c = self.db.kv_get("news_cache") or {}
            return c.get("fetched_at", 0)
        return self.fetched_at if self.error is None else 0

    def near(self, currencies: list[str], now: float, window_min: int) -> list[dict]:
        w = window_min * 60
        cur = set(currencies) | {"All"}
        return [e for e in self.events if e["currency"] in cur and -w <= e["ts"] - now <= w
                and e["impact"] in ("High", "Medium")]
