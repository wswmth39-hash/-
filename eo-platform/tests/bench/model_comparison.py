"""Phase-3 model comparison on REAL data with an untouched lockbox.

    python tests/bench/model_comparison.py <real eoplatform.db> [lockbox_start_unix] [out.json]

Development = data before ``lockbox_start``: each candidate goes through the v3 walk-forward
(thresholds from inner validation, non-overlapping trades, delay-aware labels).
Lockbox = data after it: the candidate's final model + threshold are scored ONCE there.
Family-wise correction covers every (market, duration, candidate) in this comparison.
Rule baselines are scored on the same lockbox trades.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("EO_HOME", tempfile.mkdtemp())

from eoplatform.config import ANALYSIS_PERIOD, load_settings  # noqa: E402
from eoplatform.engine import features as F  # noqa: E402
from eoplatform.engine.model import build_dataset, wilson_lb  # noqa: E402
from eoplatform.learning import trainer  # noqa: E402
from eoplatform.learning import validation as V  # noqa: E402

CANDIDATES = ["base", "shallow", "regularised", "no_structure", "trend_momentum", "structure_mtf",
              "interactions", "lightgbm", "catboost", "logistic"]


def summarise(hit: np.ndarray, z: float) -> dict:
    n, k = len(hit), int(hit.sum())
    return {"n": n, "acc": round(k / n, 4) if n else None, "lb95": round(wilson_lb(k, n), 4) if n else None,
            "lb_family": round(wilson_lb(k, n, z), 4) if n else None}


def main(db_path: str, lockbox_start: float | None, out: str | None):
    s = load_settings("/nonexistent")
    required = s.breakeven + s.cost_buffer
    con = sqlite3.connect(db_path)
    if lockbox_start is None:
        lockbox_start = float(con.execute("SELECT promoted_at FROM models WHERE id=139").fetchone()[0])
    markets = [m for (m,) in con.execute("SELECT DISTINCT market FROM bars1s WHERE source='binance'")]
    durations = (30, 60, 120, 300)
    family = len(markets) * len(durations) * len(CANDIDATES)
    z = V.z_family(family)
    res = {"lockbox_start": lockbox_start, "required_accuracy": required, "family": family, "z": z,
           "exec_delay_s": s.exec_delay_s, "rows": []}
    t0 = time.time()
    for m in markets:
        bars = np.array(con.execute("SELECT ts,o,h,l,c,n FROM bars1s WHERE market=? AND source='binance' ORDER BY ts",
                                    (m,)).fetchall(), float)
        for d in durations:
            ds = build_dataset(bars, d, delay_s=s.exec_delay_s)
            dev = ds.ts < lockbox_start - d          # labels must resolve before the lockbox begins
            lock = ds.ts >= lockbox_start
            if dev.sum() < trainer.MIN_SAMPLES or lock.sum() < 200:
                res["rows"].append({"market": m, "duration": d, "status": "insufficient data",
                                    "dev": int(dev.sum()), "lockbox": int(lock.sum())})
                continue
            purge = d // ANALYSIS_PERIOD[d] + F.MIN_CANDLES
            li = np.flatnonzero(lock)
            li = li[V.non_overlapping(ds.ts[li], d)]           # independent lockbox trades
            Xl, yl = ds.X[li], ds.y[li]
            # rule baselines on the same lockbox trades
            rules = {}
            for name, pred in trainer.strategy_predictions(Xl).items():
                k = pred >= 0
                rules[name] = summarise((pred[k] == yl[k]).astype(float), z)
            rules["always_majority_of_dev"] = summarise((np.full(len(yl), int(ds.y[dev].mean() > 0.5)) == yl)
                                                        .astype(float), z)
            for spec in CANDIDATES:
                sp = trainer.SPECS[spec]
                wf = V.walk_forward(ds.X[dev], ds.y[dev], ds.ts[dev], d, purge, required, algo=sp.get("algo", "xgboost"),
                                    params=sp["params"], feature_idx=trainer.feature_idx(sp["features"]),
                                    interactions=trainer.interaction_idx(sp.get("interactions")))
                g = V.gates(wf, required, z, s.min_validation_samples)
                row = {"market": m, "duration": d, "spec": spec, "dev_validated": g["validated"],
                       "dev_trades": wf.trades_n, "dev_acc": round(wf.acc, 4) if wf.acc else None,
                       "dev_lb_family": round(g["lb"], 4) if g["lb"] else None, "dev_reasons": g["reasons"],
                       "folds": [(f.get("n"), round(f["acc"], 3) if f.get("acc") else None) for f in wf.folds],
                       "lockbox_threshold": wf.threshold}
                if wf.model is not None:
                    pl = wf.model.predict(Xl)
                    row["lockbox_all"] = summarise(((pl > 0.5).astype(int) == yl).astype(float), z)
                    if wf.threshold is not None:
                        sel = np.abs(pl - 0.5) >= wf.threshold
                        row["lockbox_selected"] = summarise(((pl[sel] > 0.5).astype(int) == yl[sel]).astype(float), z)
                res["rows"].append(row)
            res["rows"].append({"market": m, "duration": d, "spec": "RULE_BASELINES", "lockbox": rules,
                                "lockbox_trades": int(len(yl))})
            print(f"{m} {d}s done ({time.time()-t0:.0f}s)", file=sys.stderr, flush=True)
    res["elapsed_s"] = round(time.time() - t0)
    if out:
        Path(out).write_text(json.dumps(res, indent=1, default=float))
    return res


if __name__ == "__main__":
    main(sys.argv[1], float(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] != "-" else None,
         sys.argv[3] if len(sys.argv) > 3 else None)
