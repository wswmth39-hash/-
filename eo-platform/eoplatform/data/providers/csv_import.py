"""Import genuine historical data you already have (e.g. recorded by the bridge on
another machine, or exported from a data vendor) for backtesting and training.

Accepted columns (header required): ``ts,price`` or ``ts,open,high,low,close``.
``ts`` is unix seconds. You must state the source honestly: data labelled
``expertoption`` is treated as genuine ExpertOption data everywhere.
"""
from __future__ import annotations

import csv
from pathlib import Path

from ...db import DB
from ..hub import DataHub

VALID_SOURCES = ("expertoption", "binance", "import")


def import_csv(db: DB, hub: DataHub, path: str | Path, market_id: str, source: str) -> dict:
    if source not in VALID_SOURCES:
        raise ValueError(f"source must be one of {VALID_SOURCES}")
    m = db.one("SELECT * FROM markets WHERE id=?", (market_id,))
    if m is None:
        raise ValueError(f"unknown market {market_id}")
    if m["kind"] == "otc" and source != "expertoption":
        raise ValueError("OTC markets accept ExpertOption data only")
    ticks, bars = [], []
    with open(path, newline="", encoding="utf-8") as f:
        rd = csv.DictReader(f)
        cols = {c.lower().strip() for c in rd.fieldnames or []}
        for row in rd:
            r = {k.lower().strip(): v for k, v in row.items()}
            if {"open", "high", "low", "close"} <= cols:
                bars.append((float(r["ts"]), float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"])))
            elif "price" in cols:
                ticks.append((float(r["ts"]), float(r["price"])))
            else:
                raise ValueError("CSV needs ts,price or ts,open,high,low,close")
    out = {"accepted": 0, "rejected": 0}
    if bars:
        r = hub.ingest_bars(market_id, source, bars, live=False)
        out = {k: out[k] + r[k] for k in out}
    if ticks:
        r = hub.ingest_ticks(market_id, source, ticks, live=False)
        out = {k: out[k] + r[k] for k in out}
    hub.tick()
    with hub._lock:  # close the last tick-built bar now: the import is complete
        s = hub.series.get((market_id, source))
        if s is not None and s.cur is not None:
            hub._close_bar(s)
    hub.tick()
    db.event("info", "import", f"استيراد {out['accepted']} سجل إلى {market_id} [{source}]")
    return out
