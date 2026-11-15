"""Phase-3 audit: why did a model that passed validation score 50% live?

    python tests/bench/audit_phase3.py <real eoplatform.db> [cutoff_unix] [out.json]

Uses a COPY of the real database. Everything before ``cutoff`` (default: when the Phase-1
champion #139 was promoted) is the "past"; everything after is GENUINELY UNSEEN by any model.
"""
from __future__ import annotations

import json
import math
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("EO_HOME", tempfile.mkdtemp())

from eoplatform.config import ANALYSIS_PERIOD  # noqa: E402
from eoplatform.engine.model import DirectionModel, build_dataset, calibration_table, wilson_lb  # noqa: E402

BE = 1 / 1.8  # break-even at 80% payout


def acc(pred, y):
    n = len(y)
    k = int((pred == y).sum())
    return {"n": n, "acc": round(k / n, 4) if n else None, "wilson_lb": round(wilson_lb(k, n), 4) if n else None}


def block_bootstrap_lb(hit: np.ndarray, block: int, reps: int = 2000, seed: int = 0) -> float | None:
    """2.5th percentile of accuracy under a moving-block bootstrap (respects overlap)."""
    n = len(hit)
    if n < block * 5:
        return None
    rng = np.random.default_rng(seed)
    nb = math.ceil(n / block)
    starts = rng.integers(0, n - block + 1, size=(reps, nb))
    idx = (starts[:, :, None] + np.arange(block)).reshape(reps, -1)[:, :n]
    return round(float(np.percentile(hit[idx].mean(axis=1), 2.5)), 4)


def main(db_path: str, cutoff: float | None, out: str | None):
    con = sqlite3.connect(db_path)
    if cutoff is None:
        r = con.execute("SELECT promoted_at FROM models WHERE id=139").fetchone()
        cutoff = float(r[0]) if r and r[0] else None
    res = {"cutoff": cutoff, "markets": {}}
    markets = [m for (m,) in con.execute("SELECT DISTINCT market FROM bars1s WHERE source='binance'")]
    for m in markets:
        bars = np.array(con.execute("SELECT ts,o,h,l,c,n FROM bars1s WHERE market=? AND source='binance' ORDER BY ts",
                                    (m,)).fetchall(), float)
        r1 = np.diff(bars[:, 4])
        nz = r1[r1 != 0]
        micro = {"bars": len(bars), "hours": round((bars[-1, 0] - bars[0, 0]) / 3600, 1),
                 "zero_1s_returns": round(float((r1 == 0).mean()), 4),
                 "lag1_autocorr_nonzero_1s": round(float(np.corrcoef(nz[:-1], nz[1:])[0, 1]), 4)}
        out_m = {"microstructure": micro, "durations": {}}
        for d in (30, 60, 120):
            P = ANALYSIS_PERIOD[d]
            steps = d // P
            ds = build_dataset(bars, d)
            past, fut = ds.ts < cutoff, ds.ts >= cutoff + d
            Xp, yp = ds.X[past], ds.y[past]
            if len(yp) < 1500 or fut.sum() < 300:
                continue
            cut = int(len(yp) * 0.7)
            purge = steps + 60
            mdl = DirectionModel.train(Xp[:cut], yp[:cut])
            pt = mdl.predict(Xp[cut + purge:])
            yt = yp[cut + purge:]
            table = calibration_table(pt, yt)
            # the "validated" view: best threshold chosen ON the test window (as the old trainer did)
            best = max((r for r in table if r["n"] >= 200), key=lambda r: r["acc"] or 0)
            thr = best["edge"]
            sel = np.abs(pt - 0.5) >= thr
            hit_sel = ((pt[sel] > 0.5).astype(int) == yt[sel]).astype(float)
            ov = {"threshold": thr, "naive": {"n": int(sel.sum()), "acc": round(float(hit_sel.mean()), 4),
                                              "wilson_lb": round(wilson_lb(int(hit_sel.sum()), int(sel.sum())), 4)},
                  "block_bootstrap_lb": block_bootstrap_lb(hit_sel, steps)}
            # non-overlapping subsample of the thresholded trades (one per `duration`)
            ts_sel = ds.ts[past][cut + purge:][sel]
            keep, last = [], -1e18
            for i, t in enumerate(ts_sel):
                if t - last >= d:
                    keep.append(i)
                    last = t
            hk = hit_sel[keep]
            ov["non_overlapping"] = {"n": len(hk), "acc": round(float(hk.mean()), 4) if len(hk) else None,
                                     "wilson_lb": round(wilson_lb(int(hk.sum()), len(hk)), 4) if len(hk) else None}
            # genuinely unseen period, several execution delays
            fwd = {}
            for delay in (0, 1, 2, 3):
                dsd = build_dataset(bars, d, delay_s=delay)
                fm = dsd.ts >= cutoff + d
                pf = mdl.predict(dsd.X[fm])
                yf = dsd.y[fm]
                s2 = np.abs(pf - 0.5) >= thr
                fwd[f"delay_{delay}s"] = {"all": acc((pf > 0.5).astype(int), yf),
                                          "thresholded": acc((pf[s2] > 0.5).astype(int), yf[s2])}
            # a trivial rule that only exploits last-trade bounce: bet against the last 1s move
            dsr = build_dataset(bars, d)
            fm = dsr.ts >= cutoff + d
            last_ret = []
            idx_of = {int(t): i for i, t in enumerate(bars[:, 0])}
            for t in dsr.ts[fm]:
                i = idx_of.get(int(t) - 1)
                last_ret.append(bars[i, 4] - bars[i - 1, 4] if i is not None and i > 0 else 0)
            last_ret = np.array(last_ret)
            mr = last_ret != 0
            out_m["durations"][d] = {"in_sample_view": ov, "unseen_forward": fwd,
                                     "bounce_rule_unseen": acc((last_ret[mr] < 0).astype(int), dsr.y[fm][mr])}
        res["markets"][m] = out_m
    print(json.dumps(res, indent=1))
    if out:
        Path(out).write_text(json.dumps(res, indent=1))
    return res


if __name__ == "__main__":
    main(sys.argv[1], float(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] != "-" else None,
         sys.argv[3] if len(sys.argv) > 3 else None)
