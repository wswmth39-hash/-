"""Read-only summary of the model registry for the dashboard and Telegram (V4 phase 4).
Explains WHY each model is (not) in use, from the stored validation gates — nothing is recomputed."""
from __future__ import annotations

import json
import re

_AR = [
    (re.compile(r"only (\d+) independent out-of-sample trades \(< (\d+)\)"),
     lambda m: f"{m[1]} صفقة مستقلة فقط خارج العينة (المطلوب {m[2]} على الأقل)"),
    (re.compile(r"lower bound (\S+) ≤ required (\S+)"),
     lambda m: f"الحد الأدنى للدقة {m[1]} ≤ المطلوب {m[2]}"),
    (re.compile(r"walk-forward inconsistent \((\d+)/(\d+) trading folds at/above required\)"),
     lambda m: f"غير مستقر عبر الفترات الزمنية ({m[1]} من {m[2]} فترات بلغت المطلوب)"),
    (re.compile(r"does not beat the no-model baseline"), lambda m: "لا يتفوق على خط الأساس البسيط"),
]


def reason_ar(text: str) -> str:
    for rx, fn in _AR:
        m = rx.search(text or "")
        if m:
            return fn(m)
    return text

STATUS_AR = {"champion": "معتمد (اجتاز التحقق)", "candidate": "مرشح — قيد الاختبار المستقبلي",
             "rejected": "مرفوض", "retired": "مسحوب", "challenger": "منافس"}


def _meta(r: dict) -> dict:
    m = r.get("metrics")
    return m if isinstance(m, dict) else json.loads(m or "{}")


def model_row(r: dict) -> dict:
    m = _meta(r)
    g = m.get("gates") or {}
    return {"id": r["id"], "market": r["market"], "duration": r["duration"], "status": r["status"],
            "status_ar": STATUS_AR.get(r["status"], r["status"]), "algo": m.get("algo", r.get("algo")),
            "spec": m.get("spec"), "created_at": r.get("created_at"), "protocol": m.get("protocol"),
            "validated": bool(m.get("validated")), "independent_oos_trades": g.get("trades"),
            "oos_accuracy": g.get("accuracy"), "oos_lower_bound": g.get("lb"),
            "required_accuracy": m.get("required_accuracy"), "payout": m.get("payout"),
            "fold_consistent": g.get("consistent"), "beats_baseline": g.get("beats_baseline"),
            "family_size": m.get("family_size"), "z_gate": m.get("z_gate"),
            "reasons": g.get("reasons") or ([m["gate_note"]] if m.get("gate_note") else []),
            "reasons_ar": [reason_ar(x) for x in (g.get("reasons") or ([m["gate_note"]] if m.get("gate_note") else []))],
            "note": r.get("note"), "training_data": m.get("training_data"),
            "expected_value": m.get("expected_value")}


def summary(db, limit: int = 30) -> dict:
    counts = {x["status"]: x["n"] for x in db.all("SELECT status, count(*) n FROM models GROUP BY status")}
    keep = db.all("SELECT * FROM models WHERE status IN ('champion','candidate','challenger') ORDER BY id DESC")
    recent = db.all("SELECT * FROM models ORDER BY id DESC LIMIT ?", (limit,))
    fwd = db.all("SELECT id,market,duration,spec,model_id,status,n,wins,accuracy,lb,required,target_n,updated_at "
                 "FROM forward_tests ORDER BY id DESC LIMIT 10")
    ledger = db.one("SELECT count(*) n, coalesce(sum(validated),0) v FROM hypothesis_ledger")
    return {"counts": counts, "counts_ar": {STATUS_AR.get(k, k): v for k, v in counts.items()},
            "active": [model_row(r) for r in keep], "recent": [model_row(r) for r in recent],
            "forward_tests": fwd, "hypotheses_tested": ledger["n"], "hypotheses_validated": ledger["v"],
            "champions": counts.get("champion", 0)}
