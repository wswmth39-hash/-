"""In-process latency/throughput metrics (ring buffers). Every number on the
performance dashboard comes from here — measured, never estimated."""
from __future__ import annotations

import threading
import time
from collections import Counter, deque


class Metrics:
    def __init__(self, size: int = 2000):
        self._lock = threading.Lock()
        self.series: dict[str, deque] = {}
        self.counters: Counter = Counter()
        self.size = size
        self.started = time.time()

    def observe(self, name: str, value: float) -> None:
        with self._lock:
            self.series.setdefault(name, deque(maxlen=self.size)).append((time.time(), float(value)))

    def inc(self, name: str, n: int = 1) -> None:
        with self._lock:
            self.counters[name] += n

    @staticmethod
    def _pct(vals: list[float], q: float) -> float:
        i = min(len(vals) - 1, max(0, round(q * (len(vals) - 1))))
        return vals[i]

    def summary(self, window_s: float | None = None) -> dict:
        now = time.time()
        out = {}
        with self._lock:
            items = {k: list(v) for k, v in self.series.items()}
            counters = dict(self.counters)
        for k, pts in items.items():
            vals = sorted(v for t, v in pts if window_s is None or now - t <= window_s)
            if not vals:
                continue
            out[k] = {"n": len(vals), "p50": round(self._pct(vals, 0.5), 3), "p95": round(self._pct(vals, 0.95), 3),
                      "max": round(vals[-1], 3), "last": round(pts[-1][1], 3)}
        return {"series": out, "counters": counters, "since": self.started}
