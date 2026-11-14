"""Reproducible benchmarks on REAL stored data.

    python tests/bench/run_benchmarks.py <path to eoplatform.db> [out.json]

Copies the database (never touches the live one), then measures each stage of the real-time
engine, the pandas/ta reference vs the NumPy feature engine, and resample old vs new.
Results are printed and saved as JSON; docs/BENCHMARKS.md quotes them.
"""
from __future__ import annotations

import json
import os
import platform
import shutil
import sqlite3
import statistics
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))


def pct(v, q):
    v = sorted(v)
    return v[min(len(v) - 1, int(q * (len(v) - 1)))]


def timeit(fn, n):
    out = []
    for _ in range(n):
        t = time.perf_counter()
        fn()
        out.append((time.perf_counter() - t) * 1000)
    return {"p50_ms": round(statistics.median(out), 3), "p95_ms": round(pct(out, 0.95), 3), "n": n}


def main(src_db: str, out_json: str | None) -> dict:
    import numpy as np
    home = tempfile.mkdtemp()
    sqlite3.connect(src_db).backup(sqlite3.connect(os.path.join(home, "eoplatform.db")))
    os.environ.update(EO_HOME=home, EO_ENABLE_BINANCE="false", EO_LLM_ENABLED="false")
    from eoplatform.config import load_settings
    from eoplatform.data.hub import resample
    from eoplatform.engine import features as F
    from eoplatform.engine.fast import analyze
    from eoplatform.engine.features_np import compute_np
    from eoplatform.markets import get_market
    from eoplatform.service.core import Core
    s = load_settings("/nonexistent")
    core = Core(s)
    res = {"machine": {"cpu_count": os.cpu_count(), "python": platform.python_version(), "platform": platform.platform()},
           "data": core.db.all("SELECT market, source, count(*) bars, min(ts) first, max(ts) last FROM bars1s GROUP BY market, source")}
    markets = [r["market"] for r in res["data"] if r["source"] == "binance"]
    m = markets[0]
    last = core.db.one("SELECT max(ts) t FROM bars1s WHERE market=?", (m,))["t"]
    core.hub.bars(m, "binance", 10)
    core.hub.series[(m, "binance")].last_rx = last + 1
    mk = get_market(core.db, m)
    full = np.asarray(core.db.bars(m, "binance", 0), float)

    def old_resample(bars, period):
        keys = (bars[:, 0] // period).astype(np.int64)
        o, start = [], 0
        for i in range(1, len(keys) + 1):
            if i == len(keys) or keys[i] != keys[start]:
                seg = bars[start:i]
                o.append((keys[start] * period, seg[0, 1], seg[:, 2].max(), seg[:, 3].min(), seg[-1, 4], len(seg)))
                start = i
        return np.asarray(o, float)

    res["resample_full_series"] = {f"P{P}": {"old_loop": timeit(lambda P=P: old_resample(full, P), 5),
                                             "vectorised": timeit(lambda P=P: resample(full, P), 5)} for P in (5, 60)}
    live = resample(full[-2400:], 10)[-240:]
    res["features_240_candles"] = {"pandas_ta_reference": timeit(lambda: F.compute_pandas(live), 30),
                                   "numpy_engine": timeit(lambda: compute_np(live), 30)}
    c5 = resample(full, 5)
    res["features_full_series"] = {"candles": len(c5), "pandas_ta_reference": timeit(lambda: F.compute_pandas(c5), 2),
                                   "numpy_engine": timeit(lambda: compute_np(c5), 2)}
    res["fast_analysis"] = {}
    for d in (30, 60, 120, 300):
        F._CACHE.clear()
        cold = []
        for _ in range(30):
            F._CACHE.clear()
            t = time.perf_counter()
            analyze(mk, d, core.hub, core.registry, s, now=last + 1.5, news=core.news)
            cold.append((time.perf_counter() - t) * 1000)
        warm = timeit(lambda d=d: analyze(mk, d, core.hub, core.registry, s, now=last + 1.5, news=core.news), 30)
        res["fast_analysis"][f"{d}s"] = {"cold_p50_ms": round(statistics.median(cold), 3),
                                          "cold_p95_ms": round(pct(cold, 0.95), 3), "warm": warm}
    shutil.rmtree(home, ignore_errors=True)
    print(json.dumps(res, indent=1, ensure_ascii=False))
    if out_json:
        Path(out_json).write_text(json.dumps(res, indent=1, ensure_ascii=False))
    return res


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
