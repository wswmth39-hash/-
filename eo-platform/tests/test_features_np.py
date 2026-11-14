"""The NumPy feature engine must equal the pandas/ta reference (live and training use it)."""
import numpy as np
import pytest

from conftest import random_walk_bars, trending_regime_bars
from eoplatform.data.hub import resample
from eoplatform.engine import features as F
from eoplatform.engine.features_np import compute_np


@pytest.mark.parametrize("gen,seed,period,rows", [
    (random_walk_bars, 1, 5, 140), (random_walk_bars, 2, 10, 900), (trending_regime_bars, 3, 20, 400),
    (trending_regime_bars, 4, 60, 140), (random_walk_bars, 5, 5, 3000)])
def test_numpy_features_equal_pandas_reference(gen, seed, period, rows):
    bars = np.array(gen(rows * period + 50, seed=seed), float)
    c = resample(bars, period)[-rows:]
    a, n = F.compute_pandas(c).to_numpy(), compute_np(c).to_numpy()
    assert np.array_equal(np.isnan(a), np.isnan(n))
    ok = ~np.isnan(a)
    assert np.max(np.abs(a[ok] - n[ok])) < 1e-6


def test_gaps_and_flat_candles_match():
    bars = np.array(random_walk_bars(3000, seed=9), float)
    bars[500:800, 1:5] = bars[499, 4]            # perfectly flat stretch (zero ranges)
    bars = np.delete(bars, slice(1200, 1260), axis=0)   # a missing minute
    c = resample(bars, 10)
    a, n = F.compute_pandas(c).to_numpy(), compute_np(c).to_numpy()
    assert np.array_equal(np.isnan(a), np.isnan(n))
    ok = ~np.isnan(a)
    assert np.max(np.abs(a[ok] - n[ok])) < 1e-6
