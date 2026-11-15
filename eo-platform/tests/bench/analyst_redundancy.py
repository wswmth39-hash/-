"""Measure how much the rule-based directional analysts repeat each other (real data).
Usage: python tests/bench/analyst_redundancy.py <db> <out.json> [period=10]
Writes the Pearson correlation matrix used by eoplatform/engine/analysts.py (MEASURED_CORR)."""
import json
import sqlite3
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from eoplatform.data.hub import resample  # noqa: E402
from eoplatform.engine import analysts as AN, features as F  # noqa: E402

db_path, out = sys.argv[1], sys.argv[2]
period = int(sys.argv[3]) if len(sys.argv) > 3 else 10
db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
keys = list(AN.RULE_BASED)
rows_all, per_market = [], {}
for m in ("BTCUSD", "ETHUSD", "LTCUSD", "XRPUSD"):
    b = np.array(db.execute("SELECT ts,o,h,l,c,n FROM bars1s WHERE market=? AND source='binance' ORDER BY ts",
                            (m,)).fetchall(), float)
    if len(b) < 5000:
        continue
    c = resample(b, period)
    f = F.compute(c)
    S = []
    for i in range(100, len(c), 3):
        row = f.iloc[i].to_dict()
        win = c[max(0, i - 239):i + 1]
        S.append([getattr(AN, k)(row, win)["score"] for k in keys])
    S = np.array(S)
    per_market[m] = len(S)
    rows_all.append(S)
S = np.vstack(rows_all)
C = np.corrcoef(S.T)
res = {"period_s": period, "samples": int(len(S)), "per_market": per_market, "keys": keys,
       "corr": {f"{a}|{b}": round(float(C[i, j]), 2) for i, a in enumerate(keys) for j, b in enumerate(keys) if i < j}}
Path(out).write_text(json.dumps(res, indent=2))
print(json.dumps(res, indent=2))
