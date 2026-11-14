"""Vectorised indicator / pattern features computed on analysis candles.

Every feature at row i uses candles 0..i only (no look-ahead). This is tested in
tests/test_engine.py by checking that features at i don't change when future
candles are appended.
"""
from __future__ import annotations

import hashlib
import threading
from collections import OrderedDict

import numpy as np
import pandas as pd
from ta.momentum import RSIIndicator, ROCIndicator, StochasticOscillator
from ta.trend import ADXIndicator, MACD
from ta.volatility import AverageTrueRange, BollingerBands

MIN_CANDLES = 60  # need this many analysis candles before features are meaningful

FEATURES = [
    # momentum
    "ret1", "ret3", "ret6", "ret12", "rsi14", "rsi7", "roc6", "stoch_k", "stoch_d", "streak",
    # trend
    "ema_fast_slow", "ema_slope", "macd_hist", "adx", "di_diff", "trend_up_frac",
    # volatility / structure
    "atr_rel", "bb_pctb", "bb_width", "atr_ratio",
    # candles
    "body", "upper_wick", "lower_wick", "prev_body", "engulf", "hammer", "star", "doji", "three",
    # price action
    "dist_hi20", "dist_lo20", "breakout", "hh_hl",
    # liquidity
    "sweep", "equal_levels", "activity", "activity_ratio",
    # market structure / multi-timeframe (engine/structure.py)
    "fvg_net10", "fvg_into", "structure", "bos", "choch", "htf_trend", "htf_rsi", "mtf_align",
]
LIVE_CANDLES = 240   # live analysis window (HTF EMA needs ~40 closed 6x candles to match training)


def infer_period(c: np.ndarray) -> int:
    d = np.diff(c[:, 0])
    return int(np.median(d)) if len(d) else 1


def candles_df(c: np.ndarray) -> pd.DataFrame:
    return pd.DataFrame(c[:, :6], columns=["ts", "open", "high", "low", "close", "n"])


def compute(c: np.ndarray) -> pd.DataFrame:
    """c: candles [[ts,o,h,l,c,n],...] -> DataFrame of FEATURES aligned with c.
    Uses the NumPy implementation (features_np, ~7-10× faster); compute_pandas() below is the
    reference it is tested against (max |difference| 3e-7 on 24 h of real data)."""
    from .features_np import compute_np
    return compute_np(c)


def compute_pandas(c: np.ndarray) -> pd.DataFrame:
    """Reference implementation (pandas + ta). Used by tests to validate compute_np."""
    df = candles_df(c)
    o, h, l, cl, n = df.open, df.high, df.low, df.close, df.n
    eps = 1e-12
    atr = AverageTrueRange(h, l, cl, window=14, fillna=False).average_true_range().replace(0, np.nan)
    atr = atr.fillna((h - l).rolling(14, min_periods=1).mean()).replace(0, eps)
    f = pd.DataFrame(index=df.index)

    for k in (1, 3, 6, 12):
        f[f"ret{k}"] = (cl - cl.shift(k)) / atr
    f["rsi14"] = RSIIndicator(cl, 14).rsi() / 100 - 0.5
    f["rsi7"] = RSIIndicator(cl, 7).rsi() / 100 - 0.5
    f["roc6"] = ROCIndicator(cl, 6).roc()
    st = StochasticOscillator(h, l, cl, 14, 3)
    f["stoch_k"] = st.stoch() / 100 - 0.5
    f["stoch_d"] = st.stoch_signal() / 100 - 0.5
    d = np.sign(cl.diff().fillna(0)).to_numpy()
    streak = np.zeros(len(d))
    for i in range(1, len(d)):
        streak[i] = streak[i - 1] + d[i] if d[i] != 0 and np.sign(streak[i - 1]) in (0, d[i]) else d[i]
    f["streak"] = streak

    ema9, ema21 = cl.ewm(span=9, adjust=False).mean(), cl.ewm(span=21, adjust=False).mean()
    f["ema_fast_slow"] = (ema9 - ema21) / atr
    f["ema_slope"] = (ema21 - ema21.shift(5)) / atr
    f["macd_hist"] = MACD(cl, 26, 12, 9).macd_diff() / atr
    adx = ADXIndicator(h, l, cl, 14)
    f["adx"] = adx.adx() / 100
    f["di_diff"] = (adx.adx_pos() - adx.adx_neg()) / 100
    f["trend_up_frac"] = (cl.diff() > 0).rolling(20).mean() - 0.5

    f["atr_rel"] = atr / cl * 1e4
    bb = BollingerBands(cl, 20, 2)
    f["bb_width"] = bb.bollinger_wband()
    flat = (cl.rolling(20).max() - cl.rolling(20).min()) == 0
    f["bb_pctb"] = (bb.bollinger_pband() - 0.5).where(~flat)   # flat closes: %b undefined
    f["atr_ratio"] = atr / atr.rolling(50, min_periods=14).mean()

    rng = (h - l).replace(0, eps)
    body = cl - o
    f["body"] = body / rng
    f["upper_wick"] = (h - np.maximum(o, cl)) / rng
    f["lower_wick"] = (np.minimum(o, cl) - l) / rng
    f["prev_body"] = f["body"].shift(1)
    pb, po, pc = body.shift(1), o.shift(1), cl.shift(1)
    bull_eng = (pb < 0) & (body > 0) & (cl >= po) & (o <= pc)
    bear_eng = (pb > 0) & (body < 0) & (cl <= po) & (o >= pc)
    f["engulf"] = bull_eng.astype(float) - bear_eng.astype(float)
    small_body = body.abs() <= 0.35 * rng
    f["hammer"] = (small_body & (f["lower_wick"] >= 0.55)).astype(float)
    f["star"] = (small_body & (f["upper_wick"] >= 0.55)).astype(float)
    f["doji"] = (body.abs() <= 0.1 * rng).astype(float)
    up3 = (body > 0) & (body.shift(1) > 0) & (body.shift(2) > 0) & (cl > cl.shift(1)) & (cl.shift(1) > cl.shift(2))
    dn3 = (body < 0) & (body.shift(1) < 0) & (body.shift(2) < 0) & (cl < cl.shift(1)) & (cl.shift(1) < cl.shift(2))
    f["three"] = up3.astype(float) - dn3.astype(float)

    hi20, lo20 = h.shift(1).rolling(20).max(), l.shift(1).rolling(20).min()
    f["dist_hi20"] = (hi20 - cl) / atr
    f["dist_lo20"] = (cl - lo20) / atr
    f["breakout"] = (cl > hi20).astype(float) - (cl < lo20).astype(float)
    hh = (h > h.shift(1)) & (l > l.shift(1))
    ll = (h < h.shift(1)) & (l < l.shift(1))
    f["hh_hl"] = (hh.astype(float) - ll.astype(float)).rolling(5).sum()

    # liquidity sweep: wick pierces the prior 20-candle extreme, close returns inside
    sweep_hi = (h > hi20) & (cl < hi20)
    sweep_lo = (l < lo20) & (cl > lo20)
    f["sweep"] = sweep_lo.astype(float) - sweep_hi.astype(float)
    tol = 0.15 * atr
    eq_hi = ((h - h.shift(1)).abs() < tol) | ((h - h.shift(2)).abs() < tol)
    eq_lo = ((l - l.shift(1)).abs() < tol) | ((l - l.shift(2)).abs() < tol)
    f["equal_levels"] = eq_hi.astype(float) - eq_lo.astype(float)
    f["activity"] = n
    f["activity_ratio"] = n / n.rolling(30, min_periods=5).mean()
    from .structure import structure_features
    for k, v in structure_features(np.asarray(c, float), atr.to_numpy(), infer_period(c)).items():
        f[k] = v
    return f[FEATURES].replace([np.inf, -np.inf], np.nan)


_CACHE: "OrderedDict[bytes, pd.DataFrame]" = OrderedDict()
_CACHE_MAX = 512
CACHE_STATS = {"hits": 0, "misses": 0}
_cache_lock = threading.Lock()


def compute_cached(c: np.ndarray) -> pd.DataFrame:
    """compute() memoised on the exact candle bytes: identical inputs → identical outputs,
    and any change to any candle (new candle, late correction) changes the key."""
    key = hashlib.blake2b(np.ascontiguousarray(c).tobytes(), digest_size=16).digest()
    with _cache_lock:
        hit = _CACHE.get(key)
        if hit is not None:
            _CACHE.move_to_end(key)
            CACHE_STATS["hits"] += 1
            return hit
    f = compute(c)
    with _cache_lock:
        CACHE_STATS["misses"] += 1
        _CACHE[key] = f
        while len(_CACHE) > _CACHE_MAX:
            _CACHE.popitem(last=False)
    return f


def contiguous(c: np.ndarray, period: int) -> np.ndarray:
    """Boolean mask: candle i and the previous MIN_CANDLES-1 candles are gap-free."""
    gaps = np.diff(c[:, 0], prepend=c[0, 0] - period) != period
    last_gap = np.maximum.accumulate(np.where(gaps, np.arange(len(c)), 0))
    return (np.arange(len(c)) - last_gap) >= MIN_CANDLES - 1
