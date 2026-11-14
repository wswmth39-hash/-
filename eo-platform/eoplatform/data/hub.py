"""DataHub: the single place where genuine market data enters the system.

* Every price is tagged with the market AND the source it came from. Sources are
  never mixed inside one series, so a reference feed can never be mistaken for an
  ExpertOption quote.
* All data is normalised to 1-second OHLC bars (ticks are aggregated); any
  analysis period (5s, 10s, 1m ...) is rebuilt from those.
* Freshness is measured from the moment data was *received*, so a feed that is
  connected but silent is reported as DELAYED/STALE, never LIVE.
* Nothing here generates or interpolates prices. Missing seconds stay missing.
"""
from __future__ import annotations

import itertools
import logging
import math
import threading
import time
from collections import deque
from dataclasses import dataclass, field

import numpy as np

from ..db import DB

log = logging.getLogger("eo.data")

MEM_SECONDS = 6 * 3600  # in-memory window per series

STATES_AR = {
    "LIVE": "حية", "DELAYED": "متأخرة", "STALE": "قديمة", "OFFLINE": "غير متاحة",
}


@dataclass
class Series:
    market: str
    source: str
    bars: deque = field(default_factory=lambda: deque(maxlen=MEM_SECONDS))  # (ts,o,h,l,c,n)
    cur: list | None = None           # bar being built from ticks: [ts,o,h,l,c,n]
    last_rx: float = 0.0              # wall time of last accepted update
    last_ts: float = 0.0              # data timestamp of last accepted update
    last_price: float | None = None
    clock_offset: float | None = None  # server_now - data_ts at receipt (info only)
    accepted: int = 0
    rejected: dict = field(default_factory=dict)
    pending: list = field(default_factory=list)   # finalized bars awaiting DB flush
    state: str = "OFFLINE"


class DataHub:
    def __init__(self, db: DB, live_max_age=3.0, delayed_max_age=10.0, stale_max_age=60.0,
                 max_jump=0.2, max_future_skew=120.0):
        self.db = db
        self.live_max_age, self.delayed_max_age, self.stale_max_age = live_max_age, delayed_max_age, stale_max_age
        self.max_jump, self.max_future_skew = max_jump, max_future_skew
        self._lock = threading.RLock()
        self.series: dict[tuple[str, str], Series] = {}
        self.provider_state: dict[str, dict] = {}   # source -> {connected, detail, since, reconnects}
        self.last_data_at: dict[str, float] = {}     # source -> wall time of last accepted LIVE update
        self.quality: dict[str, dict] = {}           # market -> {frozen, mismatch, ...}
        self._loaded: set[tuple[str, str]] = set()
        # listeners(market, source, bar_ts, rx_time) called when a LIVE 1-second bar is closed
        self.listeners: list = []
        self.frozen_after = 120        # identical OHLC for this many consecutive live seconds → frozen
        self.mismatch_pct = 0.3        # median |ExpertOption − reference| above this % → mismatch

    # ------------------------------------------------------------------ providers
    def set_provider_state(self, source: str, connected: bool, detail: str = "") -> None:
        with self._lock:
            st = self.provider_state.setdefault(source, {"connected": False, "detail": "", "since": time.time(),
                                                         "reconnects": 0, "errors": 0})
            if st["connected"] != connected:
                st["since"] = time.time()
                if connected and st.get("ever_connected"):
                    st["reconnects"] += 1
                self.db.event("info" if connected else "warning", "provider",
                              f"{source}: {'متصل' if connected else 'انقطع الاتصال'}", {"detail": detail})
            if connected:
                st["ever_connected"] = True
            st["connected"], st["detail"] = connected, detail

    def provider_view(self, now: float | None = None) -> dict:
        """Provider state with PROOF: 'proven' is true only when the transport is up AND
        genuine data from it was accepted within the DELAYED window. This is the only
        thing the dashboard may label CONNECTED."""
        now = now or time.time()
        with self._lock:
            out = {}
            for src, st in self.provider_state.items():
                last = self.last_data_at.get(src)
                age = round(now - last, 1) if last else None
                out[src] = {**{k: v for k, v in st.items() if k != "ever_connected"}, "last_data_age": age,
                            "proven": bool(st["connected"] and last and now - last <= self.delayed_max_age)}
            return out

    def provider_error(self, source: str) -> None:
        with self._lock:
            self.provider_state.setdefault(source, {"connected": False, "detail": "", "since": time.time(),
                                                    "reconnects": 0, "errors": 0})["errors"] += 1

    # ------------------------------------------------------------------ ingest
    def _series(self, market: str, source: str) -> Series:
        key = (market, source)
        s = self.series.get(key)
        if s is None:
            s = self.series[key] = Series(market, source)
            if key not in self._loaded:
                self._loaded.add(key)
                since = int(time.time()) - MEM_SECONDS
                for b in self.db.bars(market, source, since):
                    s.bars.append(b)
                if s.bars:
                    s.last_price = s.bars[-1][4]
                    s.last_ts = s.bars[-1][0]
        return s

    def _reject(self, s: Series, reason: str) -> None:
        s.rejected[reason] = s.rejected.get(reason, 0) + 1

    def _valid(self, s: Series, ts: float, price: float, now: float) -> bool:
        if not (isinstance(price, (int, float)) and math.isfinite(price) and price > 0):
            self._reject(s, "bad_price"); return False
        if not (isinstance(ts, (int, float)) and math.isfinite(ts)):
            self._reject(s, "bad_time"); return False
        if ts > 1e11:
            self._reject(s, "time_in_ms"); return False
        if ts < 1_000_000_000:
            self._reject(s, "time_too_old"); return False
        if ts > now + self.max_future_skew:
            self._reject(s, "time_in_future"); return False
        if s.last_price and abs(price / s.last_price - 1) > self.max_jump and ts - s.last_ts < 300:
            self._reject(s, "price_jump"); return False
        return True

    def ingest_ticks(self, market: str, source: str, ticks: list[tuple[float, float]],
                     now: float | None = None, live: bool = True) -> dict:
        """ticks: (unix_ts_seconds, price). Out-of-order ticks older than the bar
        currently being built are rejected (we never rewrite closed bars from ticks)."""
        now = now or time.time()
        acc = 0
        with self._lock:
            s = self._series(market, source)
            for ts, price in sorted(ticks, key=lambda t: t[0]):
                if not self._valid(s, ts, price, now):
                    continue
                sec = int(ts)
                if s.cur is not None and sec < s.cur[0]:
                    self._reject(s, "out_of_order"); continue
                if s.bars and sec <= s.bars[-1][0] and (s.cur is None or sec < s.cur[0]):
                    self._reject(s, "out_of_order"); continue
                if s.cur is None or sec > s.cur[0]:
                    if s.cur is not None:
                        self._close_bar(s)
                    s.cur = [sec, price, price, price, price, 1]
                else:
                    c = s.cur
                    c[2], c[3], c[4], c[5] = max(c[2], price), min(c[3], price), price, c[5] + 1
                s.last_price, s.last_ts = price, ts
                if live:  # historical imports must never make a series look LIVE
                    s.last_rx = now
                    s.clock_offset = now - ts
                    self.last_data_at[source] = now
                acc += 1
            s.accepted += acc
        return {"accepted": acc, "rejected": len(ticks) - acc}

    def ingest_bars(self, market: str, source: str, bars: list[tuple], now: float | None = None,
                    live: bool = True) -> dict:
        """bars: (ts_sec, o, h, l, c[, n]) closed 1-second bars. ``live`` marks a real-time
        update (refreshes freshness); backfill passes live=False."""
        now = now or time.time()
        acc = 0
        with self._lock:
            s = self._series(market, source)
            existing = {b[0] for b in list(s.bars)[-600:]}
            new = []
            live_fill = False
            for b in sorted(bars, key=lambda x: x[0]):
                ts, o, h, l, c = (float(x) for x in b[:5])
                n = int(b[5]) if len(b) > 5 else 1
                if not all(self._valid(s, ts, p, now) for p in (o, h, l, c)) or h < max(o, c, l) or l > min(o, c, h):
                    self._reject(s, "bad_bar"); continue
                tsi = int(ts)
                if tsi in existing:
                    s.rejected["duplicate"] = s.rejected.get("duplicate", 0) + 1
                    continue
                if s.bars and tsi < s.bars[-1][0] and live:
                    live_fill = True  # fills a hole older than the newest bar (e.g. queued during backfill)
                bar = (tsi, o, h, l, c, n)
                if tsi in existing:
                    continue
                new.append(bar)
                acc += 1
                if live or not s.bars or tsi > s.bars[-1][0]:
                    s.last_price, s.last_ts = c, tsi + 1
            if new:
                if (live and not live_fill) or not s.bars or new[0][0] > s.bars[-1][0]:
                    s.bars.extend(new)
                else:  # backfill older than what we hold: rebuild ordered window
                    merged = sorted({b[0]: b for b in list(s.bars) + new}.values())
                    s.bars = deque(merged[-MEM_SECONDS:], maxlen=MEM_SECONDS)
                s.pending.extend(new)
            if live and acc:
                s.last_rx = now
                s.clock_offset = now - s.last_ts
                self.last_data_at[source] = now
                if not live_fill:
                    self._notify(market, source, new[-1][0], now)
            s.accepted += acc
        return {"accepted": acc, "rejected": len(bars) - acc}

    def _close_bar(self, s: Series) -> None:
        b = tuple(s.cur)
        s.bars.append(b)
        s.pending.append(b)
        s.cur = None
        self._notify(s.market, s.source, b[0], s.last_rx)

    def _notify(self, market: str, source: str, bar_ts: int, rx: float) -> None:
        for fn in list(self.listeners):
            try:
                fn(market, source, bar_ts, rx)
            except Exception:
                log.exception("bar listener failed")

    # ------------------------------------------------------------------ maintenance
    def tick(self, now: float | None = None) -> None:
        """Close tick-built bars whose second has passed, update freshness, flush to DB."""
        now = now or time.time()
        with self._lock:
            for s in self.series.values():
                if s.cur is not None and now - s.cur[0] >= 2.0:
                    self._close_bar(s)
                old = s.state
                s.state = self._state(s, now)
                if old != s.state and (old == "LIVE" or s.state == "LIVE"):
                    self.db.event("info" if s.state == "LIVE" else "warning", "freshness",
                                  f"{s.market} [{s.source}]: {STATES_AR.get(old, old)} ← {STATES_AR[s.state]}")
                if s.state == "LIVE":
                    self._check_frozen(s)
                pend, s.pending = s.pending, []
                if pend:
                    try:
                        self.db.upsert_bars(s.market, s.source, [tuple(b) for b in pend])
                    except Exception:
                        log.exception("flush failed; will retry")
                        s.pending = pend + s.pending

        self._check_mismatch()

    def _check_frozen(self, s: Series) -> None:
        tail = list(s.bars)[-self.frozen_after:]
        q = self.quality.setdefault(s.market, {})
        frozen = (len(tail) >= self.frozen_after and tail[-1][0] - tail[0][0] == len(tail) - 1
                  and len({b[1:5] for b in tail}) == 1)
        key = f"frozen_{s.source}"
        if frozen != q.get(key, False):
            self.db.event("warning" if frozen else "info", "quality",
                          f"{s.market} [{s.source}]: " + ("السعر ثابت تمامًا منذ دقيقتين — بيانات مجمدة محتملة"
                                                         if frozen else "عادت حركة السعر"))
        q[key] = frozen

    def _check_mismatch(self) -> None:
        """Compare ExpertOption bridge prices with the reference feed at identical seconds."""
        markets = {m for (m, src) in self.series if src == "expertoption"} & {m for (m, src) in self.series if src == "binance"}
        for m in markets:
            a = {b[0]: b[4] for b in list(self.series[(m, "expertoption")].bars)[-120:]}
            b = {x[0]: x[4] for x in list(self.series[(m, "binance")].bars)[-120:]}
            common = sorted(set(a) & set(b))[-60:]
            if len(common) < 10:
                continue
            diffs = sorted(abs(a[t] / b[t] - 1) * 100 for t in common)
            med = diffs[len(diffs) // 2]
            q = self.quality.setdefault(m, {})
            mism = med > self.mismatch_pct
            if mism != q.get("mismatch", False):
                self.db.event("warning" if mism else "info", "quality",
                              f"{m}: فرق بين سعر ExpertOption والمصدر المرجعي {med:.3f}%"
                              + (" — عدم تطابق" if mism else " — عاد التطابق"))
            q.update(mismatch=mism, mismatch_median_pct=round(med, 4), mismatch_samples=len(common))

    def _state(self, s: Series, now: float) -> str:
        if not s.last_rx:
            return "OFFLINE"
        age = now - s.last_rx
        if age <= self.live_max_age:
            return "LIVE"
        if age <= self.delayed_max_age:
            return "DELAYED"
        if age <= self.stale_max_age:
            return "STALE"
        return "OFFLINE"

    # ------------------------------------------------------------------ read side
    def status(self, market: str, now: float | None = None) -> list[dict]:
        now = now or time.time()
        out = []
        with self._lock:
            for (m, src), s in self.series.items():
                if m != market:
                    continue
                out.append({
                    "source": src, "state": self._state(s, now),
                    "age": round(now - s.last_rx, 2) if s.last_rx else None,
                    "last_price": s.last_price, "last_ts": s.last_ts or None,
                    "bars_in_memory": len(s.bars), "accepted": s.accepted, "rejected": dict(s.rejected),
                    "clock_offset": round(s.clock_offset, 2) if s.clock_offset is not None else None,
                    "provider": dict(self.provider_state.get(src, {})),
                })
        return out

    def best_source(self, market: dict, now: float | None = None) -> tuple[str | None, str]:
        """Highest-priority allowed source and its freshness state."""
        from ..markets import allowed_sources
        now = now or time.time()
        with self._lock:
            best = (None, "OFFLINE")
            for src in allowed_sources(market):
                s = self.series.get((market["id"], src))
                if s is None:
                    continue
                st = self._state(s, now)
                if st == "LIVE":
                    return src, st
                if best[0] is None and (s.bars or s.cur is not None):
                    best = (src, st)
            return best

    def bars(self, market: str, source: str, seconds: int, include_current: bool = False) -> np.ndarray:
        """Last ``seconds`` of 1s bars as an array [[ts,o,h,l,c,n], ...] (gaps not filled)."""
        with self._lock:
            s = self.series.get((market, source))
            if s is None:
                s = self._series(market, source)
            # Timestamps are unique and increasing, so every bar inside the window is among the
            # last ``seconds`` entries: copy only that tail (was: the whole 6-hour deque, ~5 ms).
            k = min(len(s.bars), int(seconds) + 1)
            rows = list(itertools.islice(reversed(s.bars), k))[::-1]
            if include_current and s.cur is not None:
                rows.append(tuple(s.cur))
        if not rows:
            return np.empty((0, 6))
        arr = np.asarray(rows, dtype=float)
        cutoff = arr[-1, 0] - seconds
        return arr[arr[:, 0] > cutoff]

    def last_price(self, market: str, source: str) -> tuple[float | None, float | None]:
        with self._lock:
            s = self.series.get((market, source))
            return (s.last_price, s.last_rx) if s else (None, None)

    def overview(self, now: float | None = None) -> list[dict]:
        now = now or time.time()
        with self._lock:
            return [{"market": m, "source": src, "state": self._state(s, now),
                     "age": round(now - s.last_rx, 1) if s.last_rx else None, "last_price": s.last_price}
                    for (m, src), s in self.series.items()]


def resample(bars: np.ndarray, period: int) -> np.ndarray:
    """Aggregate 1s bars into ``period``-second candles aligned to the epoch.
    Returns [[start_ts,o,h,l,c,n_seconds_present], ...]. Buckets with no data are absent."""
    if bars.size == 0:
        return np.empty((0, 6))
    keys = (bars[:, 0] // period).astype(np.int64)
    starts = np.flatnonzero(np.concatenate(([True], keys[1:] != keys[:-1])))   # vectorised (was a Python loop)
    ends = np.concatenate((starts[1:], [len(keys)])) - 1
    out = np.empty((len(starts), 6))
    out[:, 0] = keys[starts] * period
    out[:, 1] = bars[starts, 1]
    out[:, 2] = np.maximum.reduceat(bars[:, 2], starts)
    out[:, 3] = np.minimum.reduceat(bars[:, 3], starts)
    out[:, 4] = bars[ends, 4]
    out[:, 5] = ends - starts + 1
    return out
