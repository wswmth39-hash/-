import numpy as np

from conftest import random_walk_bars
from eoplatform.engine.model import _build_dataset_delayed, build_dataset


def test_delay_one_second_reads_exact_1s_prices():
    bars = np.array(random_walk_bars(6000, end=1_800_000_000, seed=3), float)
    close = {int(t): c for t, c in zip(bars[:, 0], bars[:, 4])}
    for delay in (1, 2, 5):
        ds = build_dataset(bars, 30, delay_s=delay)
        assert len(ds.y) > 500
        for ts, entry, y in list(zip(ds.ts, ds.entry, ds.y))[:300]:
            e = int(ts) - 1 + delay
            assert close[e] == entry and (close[e + 30] > entry) == bool(y)


def test_delay_zero_path_matches_original_labels():
    bars = np.array(random_walk_bars(6000, end=1_800_000_000, seed=4), float)
    a = build_dataset(bars, 60)
    # the delayed builder with delay 0 must agree with the original candle-based labels
    b = _build_dataset_delayed(bars, 60, 0)
    common = np.intersect1d(a.ts, b.ts)
    ya = dict(zip(a.ts, a.y))
    yb = dict(zip(b.ts, b.y))
    assert len(common) > 0.95 * len(a.ts) and all(ya[t] == yb[t] for t in common)


def test_missing_seconds_are_dropped_not_interpolated():
    bars = np.array(random_walk_bars(6000, end=1_800_000_000, seed=5), float)
    holes = bars[(bars[:, 0] % 97) != 0]           # remove ~1% of seconds
    ds = build_dataset(holes, 30, delay_s=1)
    present = set(holes[:, 0].astype(int))
    assert all((int(t) - 1 + 1) in present and (int(t) + 30) in present for t in ds.ts)
