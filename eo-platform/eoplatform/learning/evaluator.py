"""Resolve every recorded signal against the genuine price at expiry.

* Uses the SAME source the signal was computed from (never mixes feeds).
* Entry = the last genuine price at analysis time (stored with the signal).
* Exit  = close of the last 1-second bar strictly before expiry, and that bar must
  be within 2 seconds of expiry; otherwise the signal is VOID (not counted), never guessed.
* The candidate direction is evaluated even when the decision was WAIT, so the
  system learns from everything it considered; reports separate the two.
"""
from __future__ import annotations

import json
import time

from ..db import DB

GRACE = 5  # seconds after expiry before resolving (late bars may still arrive)


def resolve_pending(db: DB, now: float | None = None) -> dict:
    now = now or time.time()
    rows = db.all("SELECT * FROM signals WHERE status='pending' AND created_at + duration + ? < ? "
                  "ORDER BY created_at LIMIT 2000", (GRACE, now))
    counts = {"win": 0, "loss": 0, "draw": 0, "void": 0}
    for s in rows:
        status, exit_price, reason = _resolve(db, s)
        counts[status] += 1
        db.execute("UPDATE signals SET status=?, exit_price=?, resolved_at=?, void_reason=? WHERE id=?",
                   (status, exit_price, now, reason, s["id"]))
    return counts


def _resolve(db: DB, s: dict) -> tuple[str, float | None, str | None]:
    if not s["candidate"]:
        return "void", None, "no candidate direction"
    if s["entry_price"] is None or s["entry_ts"] is None or not s["data_source"]:
        return "void", None, "no genuine entry price"
    if s["data_state"] != "LIVE":
        return "void", None, "data not live at signal time"
    expiry = s["entry_ts"] + s["duration"]
    bars = db.bars(s["market"], s["data_source"], expiry - 3, expiry - 1)
    if not bars:
        return "void", None, "no genuine price at expiry"
    exit_price = bars[-1][4]
    if exit_price == s["entry_price"]:
        return "draw", exit_price, None
    up = exit_price > s["entry_price"]
    won = up if s["candidate"] == "BUY" else not up
    return ("win" if won else "loss"), exit_price, None


def record_signal(db: DB, sig: dict, trigger: str = "manual") -> int:
    payload = {k: sig.get(k) for k in ("evidence", "features", "ensemble_score", "confidence_detail",
                                       "warnings", "latency_ms", "analysis_period", "agents", "signal_class",
                                       "quality_score", "quality_parts", "regime", "auto_choice")}
    cur = db.execute(
        "INSERT INTO signals(created_at,market,kind,duration,source,decision,candidate,prob,confidence,validated,"
        "model_id,entry_ts,entry_price,data_source,data_age,data_state,trend,reasons,payload,trigger) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (sig["timestamp"], sig["market"], sig["kind"], sig["duration"], sig["source"], sig["decision"],
         sig.get("candidate"), sig.get("prob"), sig.get("confidence"), int(bool(sig.get("validated"))),
         sig.get("model_id"), sig.get("entry_ts"), sig.get("entry_price"), sig.get("data_source"),
         sig.get("data_age"), sig.get("data_state"), sig.get("trend"),
         json.dumps(sig.get("reasons", []), ensure_ascii=False), json.dumps(payload, ensure_ascii=False, default=float),
         trigger))
    return cur.lastrowid
