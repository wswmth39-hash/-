"""Market-structure / MTF features must be causal: appending future candles never changes the past."""
import numpy as np

from conftest import random_walk_bars, trending_regime_bars
from eoplatform.data.hub import resample
from eoplatform.engine import features as F
from eoplatform.engine.structure import STRUCT_FEATURES, regime, structure_features


def test_all_features_causal_including_structure():
    for gen, seed, P in ((random_walk_bars, 3, 10), (trending_regime_bars, 4, 5), (random_walk_bars, 6, 60)):
        c = resample(np.array(gen(400 * P, seed=seed), float), P)
        full = F.compute(c)
        for cut in (120, 200, 333):
            part = F.compute(c[:cut])
            a, b = full.iloc[:cut].to_numpy(), part.to_numpy()
            assert np.array_equal(np.isnan(a), np.isnan(b)), cut
            ok = ~np.isnan(a)
            # recursive indicators (EMA/ADX) start from the first row in both, so values match exactly
            assert np.max(np.abs(a[ok] - b[ok])) < 1e-9, cut


def test_fvg_and_bos_detect_constructed_patterns():
    # candles: [ts,o,h,l,c,n]; a clean bullish FVG at index 2 (low[2] > high[0])
    rows = [[0, 1.0, 1.01, 0.99, 1.0, 1], [10, 1.0, 1.05, 1.0, 1.05, 1], [20, 1.05, 1.08, 1.02, 1.07, 1]]
    rows += [[30 + 10 * i, 1.07, 1.075, 1.065, 1.07, 1] for i in range(5)]
    c = np.array(rows, float)
    f = structure_features(c, np.full(len(c), 0.01), 10)
    assert f["fvg_net10"][2] == 1
    # BOS: swing high confirmed, then a close above it
    up = [[i * 10, 1, 1 + (0.02 if i == 3 else 0.0), 0.99, 1.0, 1] for i in range(8)]
    up += [[80, 1.0, 1.05, 1.0, 1.04, 1]]
    g = structure_features(np.array(up, float), np.full(9, 0.01), 10)
    assert g["bos"][-1] == 1 and g["structure"][-1] == 1


def test_htf_uses_only_closed_htf_candles():
    c = resample(np.array(trending_regime_bars(6000, seed=8), float), 10)
    f1 = structure_features(c, np.ones(len(c)), 10)["htf_trend"]
    # a base candle that does NOT close its 60s bucket must see the same HTF value as the previous row
    for i in range(50, len(c)):
        if (c[i, 0] + 10) % 60 != 0 and (c[i - 1, 0] + 10) % 60 != 0 and c[i, 0] - c[i - 1, 0] == 10:
            assert f1[i] == f1[i - 1] or (np.isnan(f1[i]) and np.isnan(f1[i - 1]))


def test_regime_labels():
    assert regime({"atr_ratio": 2.5}) == "volatile"
    assert regime({"atr_ratio": 0.2}) == "quiet"
    assert regime({"atr_ratio": 1, "adx": 0.4, "ema_slope": 1.0}) == "trend_up"
    assert regime({"atr_ratio": 1, "adx": 0.1, "ema_slope": 0.0}) == "range"
    assert set(STRUCT_FEATURES) <= set(F.FEATURES)
