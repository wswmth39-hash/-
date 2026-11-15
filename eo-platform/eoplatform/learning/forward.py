"""Pre-registered forward tests — the strongest evidence this platform can produce.

A hypothesis ("model M with threshold T on market/duration will reach the required accuracy")
is frozen at registration time and scored ONLY on market data that arrives afterwards, on
non-overlapping trades, until a fixed sample size is reached. Then a single test decides
(family-wise corrected over all forward tests registered in the ledger window). Nothing about
the model or threshold can change after registration, so there is no selection effect.

Passing makes the model eligible for activation; failing retires the hypothesis.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np

from ..config import ANALYSIS_PERIOD
from ..engine import features as F
from ..engine.model import DirectionModel, build_dataset, wilson_lb
from . import trainer
from . import validation as V

DEFAULT_TARGET_N = 400


def register(db, registry, settings, market: dict, duration: int, spec: str, rationale: str = "",
             target_n: int = DEFAULT_TARGET_N) -> dict:
    """Freeze a candidate trained on all data available NOW (v3 walk-forward, last fold model,
    inner-validation threshold) and start its forward test from the current time."""
    src = trainer.pick_source(db, market)
    if src is None:
        raise ValueError("no data for this market")
    bars = np.asarray(db.bars(market["id"], src, 0), dtype=float)
    ds = build_dataset(bars, duration, delay_s=settings.exec_delay_s)
    sp = trainer.SPECS[spec]
    required = settings.breakeven + settings.cost_buffer
    purge = duration // ANALYSIS_PERIOD[duration] + F.MIN_CANDLES
    wf = V.walk_forward(ds.X, ds.y, ds.ts, duration, purge, required, algo=sp.get("algo", "xgboost"),
                        params=sp["params"], feature_idx=trainer.feature_idx(sp["features"]),
                        interactions=trainer.interaction_idx(sp.get("interactions")))
    if wf.model is None:
        raise ValueError("not enough data to fit a candidate")
    thr = wf.threshold if wf.threshold is not None else 0.0
    start = float(bars[-1, 0]) + 1          # strictly after every bar the model could have seen
    meta = {"protocol": "v3-walkforward-nonoverlap", "source": src, "spec": spec, "algo": sp.get("algo", "xgboost"),
            "feature_idx": trainer.feature_idx(sp["features"]), "interactions": trainer.interaction_idx(sp.get("interactions")),
            "features": F.FEATURES, "threshold": thr, "validated": False, "forward_test": True,
            "exec_delay_s": settings.exec_delay_s, "required_accuracy": required, "walk_forward": wf.folds,
            "analysis_period": ANALYSIS_PERIOD[duration], "breakeven": settings.breakeven}
    mid = registry.register(market["id"], duration, wf.model, meta, "candidate", "forward test (pre-registered)")
    running = db.one("SELECT count(*) n FROM forward_tests WHERE created_at > ?",
                     (time.time() - settings.ledger_days * 86400,))["n"]
    fid = db.execute("INSERT INTO forward_tests(created_at,market,duration,source,spec,model_id,threshold,start_ts,"
                     "target_n,required,family,rationale) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                     (time.time(), market["id"], duration, src, spec, mid, thr, start, target_n, required,
                      running + 1, rationale[:300])).lastrowid
    db.event("info", "research", f"تسجيل اختبار مستقبلي #{fid}: {market['id']} {duration}ث ({spec}) — "
                                 f"يُقيَّم فقط على بيانات ما بعد التسجيل حتى {target_n} صفقة مستقلة")
    return {"forward_test_id": fid, "model_id": mid, "threshold": thr, "start_ts": start, "target_n": target_n}


def evaluate_all(db, registry, settings) -> list[dict]:
    out = []
    for ft in db.all("SELECT * FROM forward_tests WHERE status='running'"):
        out.append(evaluate(db, registry, settings, ft))
    return out


def evaluate(db, registry, settings, ft: dict) -> dict:
    row = db.one("SELECT * FROM models WHERE id=?", (ft["model_id"],))
    model = DirectionModel.load(Path(row["path"]))
    P = ANALYSIS_PERIOD[ft["duration"]]
    warmup = F.LIVE_CANDLES * P + 600            # same feature warm-up the live engine uses
    bars = np.asarray(db.bars(ft["market"], ft["source"], int(ft["start_ts"]) - warmup), dtype=float)
    ds = build_dataset(bars, ft["duration"], delay_s=settings.exec_delay_s)
    fut = np.flatnonzero(ds.ts >= ft["start_ts"])                 # only post-registration entries
    fut = fut[V.non_overlapping(ds.ts[fut], ft["duration"])]
    p = model.predict(ds.X[fut]) if len(fut) else np.empty(0)
    sel = np.abs(p - 0.5) >= ft["threshold"]
    hits = ((p[sel] > 0.5).astype(int) == ds.y[fut][sel])
    n, k = int(sel.sum()), int(hits.sum())
    n_used = min(n, ft["target_n"])                              # fixed sample size: no peeking past it
    k_used = int(hits[:n_used].sum())
    z = V.z_family(ft["family"])
    lb = wilson_lb(k_used, n_used, z) if n_used else None
    status, decided = "running", None
    if n_used >= ft["target_n"]:
        status = "passed" if (lb is not None and lb > ft["required"]) else "failed"
        decided = time.time()
        meta = json.loads(row["metrics"] or "{}")
        meta["forward_result"] = {"n": n_used, "wins": k_used, "acc": k_used / n_used, "lb": lb, "z": z,
                                  "required": ft["required"], "status": status}
        if status == "passed":
            meta["validated"] = True
            meta["gates"] = {"trades": n_used, "wins": k_used, "accuracy": k_used / n_used, "lb": lb,
                             "forward_test": True}
        db.execute("UPDATE models SET metrics=? WHERE id=?", (json.dumps(meta, default=float), ft["model_id"]))
        if status == "passed":
            registry.promote(ft["model_id"])
        else:
            db.execute("UPDATE models SET status='rejected', note=? WHERE id=?",
                       (f"forward test failed: {k_used}/{n_used}", ft["model_id"]))
        db.event("warning" if status == "failed" else "info", "research",
                 f"نتيجة الاختبار المستقبلي #{ft['id']} ({ft['market']} {ft['duration']}ث): "
                 f"{'نجح' if status == 'passed' else 'فشل'} — {k_used}/{n_used}")
    db.execute("UPDATE forward_tests SET n=?, wins=?, accuracy=?, lb=?, status=?, updated_at=?, decided_at=? WHERE id=?",
               (n_used, k_used, (k_used / n_used) if n_used else None, lb, status, time.time(), decided, ft["id"]))
    return {"id": ft["id"], "status": status, "n": n_used, "target_n": ft["target_n"], "wins": k_used, "lb": lb}
