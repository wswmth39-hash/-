"""Controlled research & improvement cycle.

  1. collect: inventory of verified stored data per market
  2. evaluate: previous predictions vs real outcomes (stats.performance)
  3. errors: recurring failure patterns, failing regimes, why models were rejected
  4. hypotheses: rule-based proposals + (optional) Qwen proposals — chosen ONLY from the
     fixed SPECS catalog, so the LLM can't inject untested code or parameters
  5-8. train candidates, purged walk-forward, compare with champion, promote only
     statistically validated improvements (family-wise correction covers all candidates)
  9. rollback stays available (manual button; automatic on live degradation)

Testing more hypotheses makes every gate stricter (Bonferroni over all candidates), so the
cycle deliberately caps the number of specs per run.
"""
from __future__ import annotations

import json
import logging
import time
from collections import Counter

from . import stats, trainer

log = logging.getLogger("eo.research")
MAX_SPECS = 3


def _status(db, **kw) -> None:
    cur = db.kv_get("research_status", {}) or {}
    cur.update(kw, updated=time.time())
    db.kv_set("research_status", cur)


def rule_hypotheses(last_retrain: dict | None, perf: dict) -> list[tuple[str, str]]:
    hyps = [("base", "النموذج الأساسي بكل المؤشرات (خط مقارنة دائم)")]
    notes = Counter()
    for r in (last_retrain or {}).get("results", []):
        n = str(r.get("note") or "")
        if "walk-forward inconsistent" in n:
            notes["unstable"] += 1
        elif "no threshold" in n:
            notes["weak"] += 1
    if notes["unstable"]:
        hyps.append(("regularised", f"{notes['unstable']} نموذجًا غير مستقر عبر الطيّات ← تنظيم أقوى"))
    if notes["weak"] >= 3:
        hyps.append(("shallow", f"{notes['weak']} نموذجًا دون أفضلية ← أشجار أبسط لتقليل الإفراط في التعلم"))
    bad_regimes = [g["group"] for g in perf.get("by_regime", []) if g.get("verified") and (g.get("accuracy") or 1) < 0.5]
    if bad_regimes:
        hyps.append(("trend_momentum", f"أداء ضعيف مُتحقق في الحالات {bad_regimes} ← تجربة مؤشرات الاتجاه والزخم فقط"))
    hyps.append(("no_structure", "اختبار إسهام مؤشرات الهيكل/FVG/الإطار الأعلى (مقارنة بدونها)"))
    return hyps


def llm_hypotheses(llm, summary: dict) -> tuple[list[tuple[str, str]], dict]:
    """Ask the local model to pick up to 2 specs from the catalog. Output is validated."""
    if llm is None or not llm.health().get("ok"):
        return [], {"used": False, "reason": "local LLM unavailable"}
    catalog = {k: v["features"] + " " + json.dumps(v["params"]) for k, v in trainer.SPECS.items()}
    prompt = ("You review a trading model research summary and pick at most 2 candidate model specs to test next, "
              f"ONLY from this catalog: {json.dumps(catalog)}.\nSummary: {json.dumps(summary)[:2500]}\n"
              'Return {"specs":["name",...],"reasoning":"one short sentence in Arabic"}')
    t = time.time()
    try:
        out = llm.ask_json(prompt)
    except Exception as e:
        return [], {"used": False, "reason": f"{type(e).__name__}: {e}"[:200]}
    picked = [s for s in out.get("specs", []) if isinstance(s, str) and s in trainer.SPECS][:2]
    why = str(out.get("reasoning", ""))[:300]
    return [(s, f"اقتراح Qwen: {why}") for s in picked], {"used": True, "secs": round(time.time() - t, 1),
                                                          "raw_specs": out.get("specs"), "accepted": picked}


def run_cycle(core, use_llm: bool = True) -> dict:
    db, s = core.db, core.s
    started = time.time()
    _status(db, state="running", stage="1/9 جمع البيانات المُتحقق منها", started=started, progress=0)
    inventory = db.all("SELECT market, source, count(*) n, min(ts) first, max(ts) last FROM bars1s GROUP BY market, source")

    _status(db, stage="2/9 تقييم التوقعات السابقة")
    perf = stats.performance(db, s.breakeven, since=time.time() - 7 * 86400)

    _status(db, stage="3/9 تحليل الأخطاء المتكررة")
    last = db.kv_get("last_retrain")
    errors = {"failure_patterns": perf.get("failure_patterns", [])[:5], "by_regime": perf.get("by_regime", []),
              "rejections": Counter(str(r.get("note", ""))[:60] for r in (last or {}).get("results", [])).most_common(5)}

    _status(db, stage="4/9 توليد الفرضيات")
    rule = rule_hypotheses(last, perf)
    llm_info, extra = {"used": False}, []
    if use_llm:
        summary = {"published_signals": perf["overall_signals"], "candidates": perf["overall_candidates"],
                   "errors": errors, "rule_hypotheses": [h[0] for h in rule]}
        extra, llm_info = llm_hypotheses(core.llm, summary)
    # Slot order: the permanent 'base' comparison, then ONE LLM proposal not already covered (so
    # Qwen's suggestion is actually tested — found in production that rule hypotheses filled every
    # slot), then rule hypotheses, capped at MAX_SPECS (each spec tightens the correction).
    chosen, seen = [], set()

    def add(spec, why):
        if spec not in seen and len(chosen) < MAX_SPECS:
            chosen.append({"spec": spec, "why": why})
            seen.add(spec)
    add(*rule[0])
    rule_specs = {r[0] for r in rule}
    for spec, why in extra:
        if spec not in seen:
            add(spec, why + ("" if spec not in rule_specs else " (يتفق مع فرضية قاعدية)"))
            break
    for spec, why in rule[1:]:
        add(spec, why)

    def progress(done, total, what):
        _status(db, stage=f"5-8/9 تدريب واختبار المرشحين ({done}/{total}): {what}", progress=round(done / total, 3))

    _status(db, stage="5-8/9 تدريب واختبار المرشحين")
    results = trainer.retrain_all(db, core.registry, s, specs=tuple(c["spec"] for c in chosen), progress=progress)
    promoted = [r for r in results if r.get("status") == "champion"]

    report = {"started": started, "finished": time.time(), "inventory": inventory, "evaluation": {
        "signals": perf["overall_signals"], "candidates": perf["overall_candidates"]}, "errors": errors,
        "hypotheses": chosen, "llm": llm_info, "family_size": (db.kv_get("last_retrain") or {}).get("family_size"),
        "results": [{k: r.get(k) for k in ("market", "duration", "spec", "status", "validated", "test_accuracy",
                                           "threshold", "note", "samples")} for r in results],
        "promoted": [{k: r.get(k) for k in ("market", "duration", "spec", "model_id", "note")} for r in promoted],
        "rollback": "متاح يدويًا (صفحة الأداء) وتلقائيًا عند تدهور الأداء الحي"}
    db.kv_set("research_last", report)
    _status(db, state="idle", stage="9/9 اكتملت الدورة", progress=1.0, finished=report["finished"],
            promoted=len(promoted), tested=len(results))
    db.event("info", "research", f"اكتملت دورة البحث: {len(results)} اختبارًا، {len(promoted)} ترقية")
    return report
