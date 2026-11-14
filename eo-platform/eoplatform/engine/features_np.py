"""NumPy port of features.compute() — same outputs, ~10× faster.

Mirrors the `ta` library algorithms exactly, including its quirks (e.g. ADX's
Wilder sums leave their last element 0, DI is skipped at index 0, early ADX values
are 0 rather than NaN; pandas ewm with min_periods masks output but the recursion
starts at the first observation). Equality with the pandas reference is enforced
by tests/test_features_np.py on real Binance data (rtol 1e-9).
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view as _swv

from .features import FEATURES

EPS = 1e-12


def _shift(x: np.ndarray, k: int) -> np.ndarray:
    out = np.full_like(x, np.nan, dtype=float)
    if k < len(x):
        out[k:] = x[:len(x) - k]
    return out


def _rolling(x: np.ndarray, w: int, minp: int, fn) -> np.ndarray:
    """pandas-like rolling with NaN-skipping reducer and a min_periods count."""
    n = len(x)
    out = np.full(n, np.nan)
    if n == 0:
        return out
    pad = np.concatenate([np.full(w - 1, np.nan), x])
    win = _swv(pad, w)
    cnt = np.sum(~np.isnan(win), axis=1)
    with np.errstate(all="ignore"):
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            val = fn(win, axis=1)
    ok = cnt >= minp
    out[ok] = val[ok]
    return out


def _rmean(x, w, minp=None):
    return _rolling(x, w, w if minp is None else minp, np.nanmean)


def _rmax(x, w, minp=None):
    return _rolling(x, w, w if minp is None else minp, np.nanmax)


def _rmin(x, w, minp=None):
    return _rolling(x, w, w if minp is None else minp, np.nanmin)


def _rstd0(x, w):
    return _rolling(x, w, w, lambda a, axis: np.nanstd(a, axis=axis, ddof=0))


def _rsum(x, w):
    return _rolling(x, w, w, np.nansum)


def _ewm(x: np.ndarray, alpha: float, minp: int = 0) -> np.ndarray:
    """pandas ewm(alpha, adjust=False, min_periods=minp).mean(); recursion from first non-NaN."""
    n = len(x)
    y = np.full(n, np.nan)
    valid = ~np.isnan(x)
    if not valid.any():
        return y
    f = int(np.argmax(valid))
    acc = x[f]
    y[f] = acc
    cnt = np.cumsum(valid)
    for t in range(f + 1, n):
        xt = x[t]
        if xt == xt:  # not NaN
            acc = (1 - alpha) * acc + alpha * xt
        y[t] = acc
    y[cnt < max(minp, 1)] = np.nan
    return y


def _true_range(h, l, cl):
    pc = _shift(cl, 1)
    tr = np.vstack([h - l, np.abs(h - pc), np.abs(l - pc)])
    with np.errstate(all="ignore"):
        return np.nanmax(tr, axis=0)


def _atr_ta(h, l, cl, w=14):
    tr = _true_range(h, l, cl)
    atr = np.zeros(len(cl))
    if len(cl) >= w:
        atr[w - 1] = tr[0:w].mean()
        for i in range(w, len(atr)):
            atr[i] = (atr[i - 1] * (w - 1) + tr[i]) / float(w)
    return atr


def _rsi_ta(cl, w):
    d = np.diff(cl, prepend=np.nan)
    up = np.where(d > 0, d, 0.0)
    dn = np.where(d < 0, -d, 0.0)
    eu, ed = _ewm(up, 1 / w, w), _ewm(dn, 1 / w, w)
    with np.errstate(all="ignore"):
        rs = eu / ed
        return np.where(ed == 0, 100.0, 100 - (100 / (1 + rs)))


def _wilder_sum(x: np.ndarray, w: int, n: int) -> np.ndarray:
    """ta ADX smoothing: first = sum of first w non-NaN values; last element left at 0."""
    out = np.zeros(n - (w - 1))
    vals = x[~np.isnan(x)]
    out[0] = vals[0:w].sum()
    for i in range(1, len(out) - 1):
        out[i] = out[i - 1] - (out[i - 1] / float(w)) + x[w + i]
    return out


def _adx_ta(h, l, cl, w=14):
    n = len(cl)
    cs = _shift(cl, 1)
    with np.errstate(all="ignore"):
        pdm = np.amax([h, cs], axis=0)
        pdn = np.amin([l, cs], axis=0)
    trs = _wilder_sum(pdm - pdn, w, n)
    du = h - _shift(h, 1)
    dd = _shift(l, 1) - l
    with np.errstate(invalid="ignore"):
        pos = np.abs(np.where(np.isnan(du), np.nan, ((du > dd) & (du > 0)) * du))
        neg = np.abs(np.where(np.isnan(dd), np.nan, ((dd > du) & (dd > 0)) * dd))
    dip, din = _wilder_sum(pos, w, n), _wilder_sum(neg, w, n)
    with np.errstate(all="ignore"):
        dpi = np.where(trs != 0, 100 * dip / np.where(trs != 0, trs, 1), 0.0)
        dni = np.where(trs != 0, 100 * din / np.where(trs != 0, trs, 1), 0.0)
        s = dpi + dni
        dx = np.where(s != 0, 100 * np.abs((dpi - dni) / np.where(s != 0, s, 1)), 0.0)
    adx = np.zeros(len(trs))
    if len(trs) > w:
        adx[w] = dx[0:w].mean()
        for i in range(w + 1, len(adx)):
            adx[i] = ((adx[i - 1] * (w - 1)) + dx[i - 1]) / float(w)
    adx = np.concatenate((np.zeros(w - 1), adx))
    pos_s, neg_s = np.zeros(n), np.zeros(n)
    for i in range(1, len(trs) - 1):
        pos_s[i + w] = 100 * (dip[i] / trs[i]) if trs[i] != 0 else 0
        neg_s[i + w] = 100 * (din[i] / trs[i]) if trs[i] != 0 else 0
    return adx, pos_s, neg_s


def compute_np(c: np.ndarray) -> pd.DataFrame:
    c = np.asarray(c, dtype=float)
    o, h, l, cl, nn = c[:, 1], c[:, 2], c[:, 3], c[:, 4], c[:, 5]
    N = len(cl)
    f: dict[str, np.ndarray] = {}
    with np.errstate(all="ignore"):
        atr = _atr_ta(h, l, cl, 14)
        atr = np.where(atr == 0, np.nan, atr)
        atr = np.where(np.isnan(atr), _rmean(h - l, 14, 1), atr)
        atr = np.where(atr == 0, EPS, atr)

        for k in (1, 3, 6, 12):
            f[f"ret{k}"] = (cl - _shift(cl, k)) / atr
        f["rsi14"] = _rsi_ta(cl, 14) / 100 - 0.5
        f["rsi7"] = _rsi_ta(cl, 7) / 100 - 0.5
        c6 = _shift(cl, 6)
        f["roc6"] = ((cl - c6) / c6) * 100
        smin, smax = _rmin(l, 14), _rmax(h, 14)
        sk = 100 * (cl - smin) / (smax - smin)
        f["stoch_k"] = sk / 100 - 0.5
        f["stoch_d"] = _rmean(sk, 3) / 100 - 0.5
        d = np.sign(np.nan_to_num(np.diff(cl, prepend=np.nan)))
        streak = np.zeros(N)
        for i in range(1, N):
            streak[i] = streak[i - 1] + d[i] if d[i] != 0 and np.sign(streak[i - 1]) in (0, d[i]) else d[i]
        f["streak"] = streak

        ema9, ema21 = _ewm(cl, 2 / 10), _ewm(cl, 2 / 22)
        f["ema_fast_slow"] = (ema9 - ema21) / atr
        f["ema_slope"] = (ema21 - _shift(ema21, 5)) / atr
        efast, eslow = _ewm(cl, 2 / 13, 12), _ewm(cl, 2 / 27, 26)
        macd = efast - eslow
        f["macd_hist"] = (macd - _ewm(macd, 2 / 10, 9)) / atr
        adx, dpos, dneg = _adx_ta(h, l, cl, 14)
        f["adx"] = adx / 100
        f["di_diff"] = (dpos - dneg) / 100
        up = (np.diff(cl, prepend=np.nan) > 0).astype(float)
        f["trend_up_frac"] = _rmean(up, 20) - 0.5

        f["atr_rel"] = atr / cl * 1e4
        mavg, mstd = _rmean(cl, 20), _rstd0(cl, 20)
        hb, lb = mavg + 2 * mstd, mavg - 2 * mstd
        f["bb_width"] = ((hb - lb) / mavg) * 100
        # zero-width bands (flat closes over the window): %b is undefined. Without this guard pandas
        # and numpy return ratios of different rounding residues (found by test_gaps_and_flat...).
        flat = (_rmax(cl, 20) - _rmin(cl, 20)) == 0      # exact, implementation-independent
        f["bb_pctb"] = np.where(flat, np.nan, (cl - lb) / np.where(hb != lb, hb - lb, np.nan) - 0.5)
        f["atr_ratio"] = atr / _rmean(atr, 50, 14)

        rng = np.where((h - l) == 0, EPS, h - l)
        body = cl - o
        f["body"] = body / rng
        f["upper_wick"] = (h - np.maximum(o, cl)) / rng
        f["lower_wick"] = (np.minimum(o, cl) - l) / rng
        f["prev_body"] = _shift(f["body"], 1)
        pb, po, pc = _shift(body, 1), _shift(o, 1), _shift(cl, 1)
        bull_eng = (pb < 0) & (body > 0) & (cl >= po) & (o <= pc)
        bear_eng = (pb > 0) & (body < 0) & (cl <= po) & (o >= pc)
        f["engulf"] = bull_eng.astype(float) - bear_eng.astype(float)
        small = np.abs(body) <= 0.35 * rng
        f["hammer"] = (small & (f["lower_wick"] >= 0.55)).astype(float)
        f["star"] = (small & (f["upper_wick"] >= 0.55)).astype(float)
        f["doji"] = (np.abs(body) <= 0.1 * rng).astype(float)
        b1, b2, c1, c2 = _shift(body, 1), _shift(body, 2), _shift(cl, 1), _shift(cl, 2)
        up3 = (body > 0) & (b1 > 0) & (b2 > 0) & (cl > c1) & (c1 > c2)
        dn3 = (body < 0) & (b1 < 0) & (b2 < 0) & (cl < c1) & (c1 < c2)
        f["three"] = up3.astype(float) - dn3.astype(float)

        hi20, lo20 = _rmax(_shift(h, 1), 20), _rmin(_shift(l, 1), 20)
        f["dist_hi20"] = (hi20 - cl) / atr
        f["dist_lo20"] = (cl - lo20) / atr
        f["breakout"] = (cl > hi20).astype(float) - (cl < lo20).astype(float)
        h1, l1 = _shift(h, 1), _shift(l, 1)
        hh = (h > h1) & (l > l1)
        ll = (h < h1) & (l < l1)
        f["hh_hl"] = _rsum(hh.astype(float) - ll.astype(float), 5)
        sweep_hi = (h > hi20) & (cl < hi20)
        sweep_lo = (l < lo20) & (cl > lo20)
        f["sweep"] = sweep_lo.astype(float) - sweep_hi.astype(float)
        tol = 0.15 * atr
        eq_hi = (np.abs(h - h1) < tol) | (np.abs(h - _shift(h, 2)) < tol)
        eq_lo = (np.abs(l - l1) < tol) | (np.abs(l - _shift(l, 2)) < tol)
        f["equal_levels"] = eq_hi.astype(float) - eq_lo.astype(float)
        f["activity"] = nn
        f["activity_ratio"] = nn / _rmean(nn, 30, 5)
        from .features import infer_period
        from .structure import structure_features
        f.update(structure_features(c, atr, infer_period(c)))

    out = pd.DataFrame({k: f[k] for k in FEATURES})
    return out.replace([np.inf, -np.inf], np.nan)
