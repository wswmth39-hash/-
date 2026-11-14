"""Market-structure features (NumPy, causal — no look-ahead):

* Fair Value Gaps: 3-candle imbalance. Bullish FVG at i when low[i] > high[i-2]; bearish when
  high[i] < low[i-2]. A gap is "filled" once price trades back through it.
* Swing points: fractal high/low with 2 candles each side. A swing at j is only KNOWN at j+2,
  so features at row i use swings confirmed at or before i (no look-ahead).
* BOS / CHoCH: close breaks the last confirmed swing high (bullish) or low (bearish).
  A break against the prevailing structure is a change of character (CHoCH).
* Multi-timeframe: higher-timeframe candles = 6 base candles. Row i only sees HTF candles
  that had fully closed by the close of row i.
* Regime: label derived from trend strength and relative volatility (used for filters/stats).

Every function is tested for causality in tests/test_structure.py (appending future candles
must not change any past value).
"""
from __future__ import annotations

import numpy as np

STRUCT_FEATURES = ["fvg_net10", "fvg_into", "structure", "bos", "choch", "htf_trend", "htf_rsi", "mtf_align"]
HTF_MULT = 6


def _ema(x: np.ndarray, alpha: float) -> np.ndarray:
    y = np.empty_like(x)
    acc = x[0]
    for i, v in enumerate(x):
        acc = acc if i == 0 else (1 - alpha) * acc + alpha * v
        y[i] = acc
    return y


def structure_features(c: np.ndarray, atr: np.ndarray, period: int) -> dict[str, np.ndarray]:
    ts, h, l, cl = c[:, 0], c[:, 2], c[:, 3], c[:, 4]
    n = len(cl)
    out = {k: np.full(n, np.nan) for k in STRUCT_FEATURES}
    if n < 5:
        return out

    # ---- Fair Value Gaps
    bull = np.zeros(n, bool)
    bear = np.zeros(n, bool)
    bull[2:] = l[2:] > h[:-2]
    bear[2:] = h[2:] < l[:-2]
    net = bull.astype(float) - bear.astype(float)
    cs = np.concatenate([[0.0], np.cumsum(net)])
    idx = np.arange(n)
    lo = np.maximum(0, idx - 9)
    out["fvg_net10"] = cs[idx + 1] - cs[lo]
    # trading back into the most recent still-open gap (retest): +1 into bullish gap, -1 into bearish
    fvg_into = np.zeros(n)
    last_bull = last_bear = None           # (top, bottom) of most recent open gaps
    for i in range(n):
        if last_bull is not None:
            top, bot = last_bull
            if l[i] <= top and cl[i] >= bot:
                fvg_into[i] = 1.0
            if cl[i] < bot:
                last_bull = None           # filled through
        if last_bear is not None:
            top, bot = last_bear
            if h[i] >= bot and cl[i] <= top:
                fvg_into[i] = -1.0 if fvg_into[i] == 0 else 0.0
            if cl[i] > top:
                last_bear = None
        if bull[i]:
            last_bull = (l[i], h[i - 2])
        if bear[i]:
            last_bear = (l[i - 2], h[i])
    out["fvg_into"] = fvg_into

    # ---- swings (confirmed 2 candles later), BOS / CHoCH
    structure = np.zeros(n)
    bos = np.zeros(n)
    choch = np.zeros(n)
    sh = sl = None
    state = 0.0
    for i in range(n):
        j = i - 2                          # swing at j becomes known at i
        if j >= 2:
            if h[j] == h[j - 2:j + 3].max():
                sh = h[j]
            if l[j] == l[j - 2:j + 3].min():
                sl = l[j]
        if sh is not None and cl[i] > sh and (i == 0 or cl[i - 1] <= sh):
            bos[i] = 1.0
            if state < 0:
                choch[i] = 1.0
            state = 1.0
        elif sl is not None and cl[i] < sl and (i == 0 or cl[i - 1] >= sl):
            bos[i] = -1.0
            if state > 0:
                choch[i] = -1.0
            state = -1.0
        structure[i] = state
    out["structure"], out["bos"], out["choch"] = structure, bos, choch

    # ---- higher timeframe (6 × period), only fully closed HTF candles are visible
    hp = period * HTF_MULT
    bucket = (ts // hp).astype(np.int64)
    closes_bucket = (ts + period) % hp == 0          # this base candle closes its HTF candle
    htf_close_idx = np.flatnonzero(closes_bucket)
    if len(htf_close_idx) >= 3:
        hc = cl[htf_close_idx]
        hema = _ema(hc, 2 / 9)                        # EMA8 on HTF closes
        slope = np.concatenate([[np.nan], np.diff(hema)])
        d = np.diff(hc, prepend=hc[0])
        up, dn = np.maximum(d, 0), np.maximum(-d, 0)
        au, ad = _ema(up, 1 / 7), _ema(dn, 1 / 7)
        with np.errstate(all="ignore"):
            hrsi = np.where(ad == 0, 100.0, 100 - 100 / (1 + au / ad)) / 100 - 0.5
        # for each base row: index of the latest HTF candle closed at or before it
        k = np.searchsorted(htf_close_idx, idx, side="right") - 1
        ok = k >= 1
        with np.errstate(all="ignore"):
            out["htf_trend"] = np.where(ok, slope[np.clip(k, 0, None)] / atr, np.nan)
        out["htf_rsi"] = np.where(k >= 7, hrsi[np.clip(k, 0, None)], np.nan)
        del bucket
    # alignment of base EMA trend with HTF trend: +1 both up, -1 both down, 0 disagree/unknown
    base_up = np.sign(_ema(cl, 2 / 10) - _ema(cl, 2 / 22))
    htf = np.sign(np.nan_to_num(out["htf_trend"]))
    out["mtf_align"] = np.where((base_up == htf) & (htf != 0), htf, 0.0)
    return out


def regime(row: dict) -> str:
    """trend_up / trend_down / range / volatile / quiet — from ADX, EMA slope and ATR ratio."""
    def g(k, d=0.0):
        v = row.get(k)
        return d if v is None or v != v else float(v)
    atr_ratio, adx, slope = g("atr_ratio", 1.0), g("adx"), g("ema_slope")
    if atr_ratio > 1.8:
        return "volatile"
    if atr_ratio < 0.4:
        return "quiet"
    if adx >= 0.25 and abs(slope) > 0.3:
        return "trend_up" if slope > 0 else "trend_down"
    return "range"


REGIME_AR = {"trend_up": "اتجاه صاعد", "trend_down": "اتجاه هابط", "range": "نطاق عرضي",
             "volatile": "تقلب مرتفع", "quiet": "هدوء شديد"}
