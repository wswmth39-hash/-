"""Execution engine: risk checks → idempotent order → broker confirmation → settlement.

Order lifecycle (every transition is written to execution_log):
  risk_rejected                      (never sent)
  submitted → confirmed → settled    (win / loss / draw / void)
  submitted → rejected               (broker refused; never counted as a trade)
A request is NOT a success: only ``confirmed`` orders are positions.
"""
from __future__ import annotations

import hashlib
import json
import time

from ..db import DB
from ..engine.model import wilson_lb
from .brokers import OUT_OF_SCOPE, PaperBroker

SCHEMA = """
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, client_order_id TEXT UNIQUE NOT NULL, created_at REAL NOT NULL,
  mode TEXT NOT NULL, broker TEXT NOT NULL, signal_id INTEGER, market TEXT NOT NULL, kind TEXT, duration INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('BUY','SELL')), stake REAL NOT NULL, payout REAL NOT NULL,
  data_source TEXT, status TEXT NOT NULL, broker_ref TEXT, entry_price REAL, entry_ts REAL, expiry_ts REAL,
  exit_price REAL, result TEXT, pnl REAL, reason TEXT, settled_at REAL, trigger TEXT
);
CREATE INDEX IF NOT EXISTS ix_orders_status ON orders(status, expiry_ts);
CREATE TABLE IF NOT EXISTS execution_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, order_id INTEGER, event TEXT NOT NULL, detail TEXT
);
"""

DEFAULT_RISK = {
    "mode": "analysis",              # 'analysis' | 'paper'   (live is not selectable: no permitted broker)
    "auto_enabled": False,
    "stake": 1.0,
    "max_stake": 10.0,
    "max_stake_pct": 2.0,            # % of balance per trade
    "max_daily_loss": 20.0,          # realised loss today (UTC) that halts trading
    "max_consecutive_losses": 4,
    "max_open": 1,
    "max_trades_per_hour": 10,
    "cooldown_s": 60,                # per market
    "min_edge": 0.0,                 # required lower-bound expected return per unit staked
    "max_signal_age_s": 3.0,
    "markets": [],                   # empty = every enabled market
    "durations": [30, 60, 120, 300],
    "paper_initial_balance": 1000.0,
}
GRACE = 5


class ExecutionEngine:
    def __init__(self, db: DB, hub, settings, alert=None):
        self.db, self.hub, self.s = db, hub, settings
        self.alert = alert or (lambda *a, **k: None)
        with db._lock:
            db.conn.executescript(SCHEMA)
        self.paper = PaperBroker(hub, settings.live_max_age)
        if db.kv_get("exec_state") is None:
            db.kv_set("exec_state", {"halted": False, "halt_reason": None, "kill_switch": False,
                                     "paper_balance": DEFAULT_RISK["paper_initial_balance"]})

    # ------------------------------------------------------------------ config/state
    def config(self) -> dict:
        return {**DEFAULT_RISK, **(self.db.kv_get("risk_config", {}) or {})}

    def set_config(self, new: dict) -> dict:
        cur = self.config()
        for k, v in new.items():
            if k not in DEFAULT_RISK:
                continue
            if k == "mode":
                if v not in ("analysis", "paper"):
                    raise ValueError("real-money execution is outside the scope of this project")
                cur[k] = v
            elif k in ("markets", "durations"):
                cur[k] = [int(x) if k == "durations" else str(x) for x in v][:50]
            elif k == "auto_enabled":
                cur[k] = bool(v)
            else:
                x = float(v)
                if x < 0:
                    raise ValueError(f"{k} must be >= 0")
                cur[k] = int(x) if isinstance(DEFAULT_RISK[k], int) and not isinstance(DEFAULT_RISK[k], bool) else x
        if cur["stake"] > cur["max_stake"]:
            raise ValueError("stake exceeds max_stake")
        self.db.kv_set("risk_config", cur)
        self.log(None, "config", cur)
        return cur

    def state(self) -> dict:
        return self.db.kv_get("exec_state")

    def _set_state(self, **kw) -> dict:
        st = {**self.state(), **kw}
        self.db.kv_set("exec_state", st)
        return st

    def log(self, order_id, event: str, detail=None) -> None:
        self.db.execute("INSERT INTO execution_log(ts,order_id,event,detail) VALUES(?,?,?,?)",
                        (time.time(), order_id, event, json.dumps(detail, ensure_ascii=False, default=str)
                         if detail is not None else None))

    # ------------------------------------------------------------------ controls
    def kill(self, reason: str = "زر الإيقاف الطارئ") -> dict:
        cfg = self.config()
        cfg["auto_enabled"] = False
        self.db.kv_set("risk_config", cfg)
        st = self._set_state(kill_switch=True, halted=True, halt_reason=reason)
        self.log(None, "kill_switch", {"reason": reason})
        self.alert("critical", "execution", f"إيقاف طارئ للتداول: {reason}")
        return st

    def resume(self) -> dict:
        st = self._set_state(kill_switch=False, halted=False, halt_reason=None)
        self.log(None, "resume", None)
        self.db.event("info", "execution", "استئناف التداول يدويًا")
        return st

    def reset_paper_balance(self) -> dict:
        bal = self.config()["paper_initial_balance"]
        self.log(None, "paper_balance_reset", {"balance": bal})
        return self._set_state(paper_balance=bal)

    # ------------------------------------------------------------------ stats
    @staticmethod
    def _day_start() -> float:
        now = time.time()
        return now - now % 86400  # UTC midnight

    def stats(self) -> dict:
        settled = self.db.all("SELECT result,pnl,stake,settled_at FROM orders WHERE status='settled' ORDER BY settled_at")
        wins = sum(1 for o in settled if o["result"] == "win")
        losses = sum(1 for o in settled if o["result"] == "loss")
        n = wins + losses
        eq, peak, mdd = 0.0, 0.0, 0.0
        for o in settled:
            eq += o["pnl"] or 0
            peak = max(peak, eq)
            mdd = max(mdd, peak - eq)
        gross_w = sum(o["pnl"] for o in settled if (o["pnl"] or 0) > 0)
        gross_l = -sum(o["pnl"] for o in settled if (o["pnl"] or 0) < 0)
        today = [o for o in settled if (o["settled_at"] or 0) >= self._day_start()]
        streak = 0
        for o in reversed(settled):
            if o["result"] == "loss":
                streak += 1
            elif o["result"] == "win":
                break
        return {"settled": len(settled), "wins": wins, "losses": losses,
                "draws_or_void": len(settled) - n, "win_rate": wins / n if n else None,
                "win_rate_lb": wilson_lb(wins, n) if n else None, "net_pnl": round(eq, 2),
                "max_drawdown": round(mdd, 2), "profit_factor": round(gross_w / gross_l, 3) if gross_l else None,
                "avg_pnl_per_trade": round(eq / len(settled), 4) if settled else None,
                "today_pnl": round(sum(o["pnl"] or 0 for o in today), 2), "consecutive_losses": streak,
                "open": self.db.one("SELECT count(*) n FROM orders WHERE status IN ('submitted','confirmed')")["n"]}

    # ------------------------------------------------------------------ risk
    def risk_check(self, sig: dict, cfg: dict, now: float) -> list[str]:
        st, stt = self.state(), self.stats()
        r = []
        if st["kill_switch"]:
            r.append("الإيقاف الطارئ مفعّل")
        if st["halted"]:
            r.append(f"التداول موقوف: {st['halt_reason']}")
        if cfg["mode"] != "paper":
            r.append("وضع التحليل فقط — لا تُرسل أوامر")
        if sig.get("decision") not in ("BUY", "SELL") or not sig.get("validated"):
            r.append("الإشارة ليست قرار شراء/بيع مُتحققًا منه")
        if sig.get("data_state") != "LIVE":
            r.append("البيانات ليست حية")
        if now - sig.get("timestamp", 0) > cfg["max_signal_age_s"]:
            r.append("الإشارة قديمة")
        if cfg["markets"] and sig.get("market") not in cfg["markets"]:
            r.append("السوق غير مسموح في إعدادات المخاطر")
        if sig.get("duration") not in cfg["durations"]:
            r.append("المدة غير مسموحة")
        stake, bal = cfg["stake"], st["paper_balance"]
        if stake <= 0 or stake > cfg["max_stake"]:
            r.append("المبلغ خارج الحدود")
        if stake > bal * cfg["max_stake_pct"] / 100:
            r.append(f"المبلغ يتجاوز {cfg['max_stake_pct']}% من الرصيد")
        if stake > bal:
            r.append("الرصيد غير كافٍ")
        if -stt["today_pnl"] >= cfg["max_daily_loss"]:
            r.append("تم بلوغ حد الخسارة اليومي")
        if stt["consecutive_losses"] >= cfg["max_consecutive_losses"]:
            r.append("تم بلوغ حد الخسائر المتتالية")
        if stt["open"] >= cfg["max_open"]:
            r.append("عدد الصفقات المفتوحة بلغ الحد")
        hour = self.db.one("SELECT count(*) n FROM orders WHERE status IN ('confirmed','settled') AND created_at>?",
                           (now - 3600,))["n"]
        if hour >= cfg["max_trades_per_hour"]:
            r.append("تم بلوغ حد الصفقات في الساعة")
        last = self.db.one("SELECT max(created_at) t FROM orders WHERE market=? AND status IN ('confirmed','settled')",
                           (sig.get("market"),))["t"]
        if last and now - last < cfg["cooldown_s"]:
            r.append("فترة تهدئة لهذا السوق")
        cd = sig.get("confidence_detail") or {}
        lb = cd.get("wilson_lb")
        if lb is None:
            r.append("لا يوجد حد أدنى مُتحقق للدقة")
        else:
            edge = lb * (1 + self.s.payout_for(sig.get("market"))) - 1
            if edge <= cfg["min_edge"]:
                r.append(f"العائد المتوقع المتحفظ {edge:+.3f} لا يتجاوز الحد {cfg['min_edge']}")
        return r

    # ------------------------------------------------------------------ submit
    def submit_from_signal(self, sig: dict, trigger: str = "auto", now: float | None = None) -> dict:
        cfg, now = self.config(), now or time.time()
        if cfg["mode"] == "analysis":
            self.log(None, "analysis_only", {"signal_id": sig.get("id"), "market": sig.get("market"),
                                             "decision": sig.get("decision")})
            return {"status": "analysis_only"}
        direction = sig.get("decision")
        coid = hashlib.sha1(f"{sig.get('id')}|{sig.get('market')}|{sig.get('duration')}|{direction}".encode()).hexdigest()
        if self.db.one("SELECT id FROM orders WHERE client_order_id=?", (coid,)):
            self.log(None, "duplicate_blocked", {"client_order_id": coid})
            return {"status": "duplicate_blocked"}
        reasons = self.risk_check(sig, cfg, now)
        status = "risk_rejected" if reasons else "submitted"
        try:
            oid = self.db.execute(
                "INSERT INTO orders(client_order_id,created_at,mode,broker,signal_id,market,kind,duration,direction,stake,"
                "payout,data_source,status,reason,trigger) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (coid, now, cfg["mode"], self.paper.name, sig.get("id"), sig["market"], sig.get("kind"), sig["duration"],
                 direction if direction in ("BUY", "SELL") else (sig.get("candidate") or "BUY"), cfg["stake"],
                 self.s.payout, sig.get("data_source"), status, "؛ ".join(reasons) or None, trigger)).lastrowid
        except Exception:  # UNIQUE race: another submit got there first
            self.log(None, "duplicate_blocked", {"client_order_id": coid})
            return {"status": "duplicate_blocked"}
        if reasons:
            self.log(oid, "risk_rejected", reasons)
            return {"status": "risk_rejected", "order_id": oid, "reasons": reasons}
        order = self.db.one("SELECT * FROM orders WHERE id=?", (oid,))
        self.log(oid, "submitted", {"broker": self.paper.name, "stake": cfg["stake"]})
        conf = self.paper.submit(order, now=now)
        if not conf.accepted:
            self.db.execute("UPDATE orders SET status='rejected', reason=? WHERE id=?", (conf.reason, oid))
            self.log(oid, "rejected", conf.reason)
            return {"status": "rejected", "order_id": oid, "reason": conf.reason}
        expiry = int(conf.entry_ts) + sig["duration"]
        self.db.execute("UPDATE orders SET status='confirmed', broker_ref=?, entry_price=?, entry_ts=?, expiry_ts=? "
                        "WHERE id=?", (conf.broker_ref, conf.entry_price, int(conf.entry_ts), expiry, oid))
        self._set_state(paper_balance=round(self.state()["paper_balance"] - cfg["stake"], 6))
        self.log(oid, "confirmed", {"broker_ref": conf.broker_ref, "entry_price": conf.entry_price})
        return {"status": "confirmed", "order_id": oid, "broker_ref": conf.broker_ref, "entry_price": conf.entry_price}

    # ------------------------------------------------------------------ settlement
    def settle(self, now: float | None = None) -> int:
        now = now or time.time()
        n = 0
        for o in self.db.all("SELECT * FROM orders WHERE status='confirmed' AND expiry_ts + ? < ?", (GRACE, now)):
            bars = self.db.bars(o["market"], o["data_source"], int(o["expiry_ts"]) - 3, int(o["expiry_ts"]) - 1)
            if not bars:
                result, exit_price, pnl = "void", None, 0.0
            else:
                exit_price = bars[-1][4]
                if exit_price == o["entry_price"]:
                    result, pnl = "draw", 0.0
                else:
                    won = (exit_price > o["entry_price"]) == (o["direction"] == "BUY")
                    result, pnl = ("win", o["stake"] * o["payout"]) if won else ("loss", -o["stake"])
            self.db.execute("UPDATE orders SET status='settled', result=?, exit_price=?, pnl=?, settled_at=? WHERE id=?",
                            (result, exit_price, round(pnl, 6), now, o["id"]))
            self._set_state(paper_balance=round(self.state()["paper_balance"] + o["stake"] + pnl, 6))
            self.log(o["id"], "settled", {"result": result, "exit_price": exit_price, "pnl": pnl})
            n += 1
        if n:
            self._auto_halt()
        return n

    def _auto_halt(self) -> None:
        cfg, st, stt = self.config(), self.state(), self.stats()
        if st["halted"]:
            return
        reason = None
        if -stt["today_pnl"] >= cfg["max_daily_loss"]:
            reason = f"بلوغ حد الخسارة اليومي ({stt['today_pnl']})"
        elif stt["consecutive_losses"] >= cfg["max_consecutive_losses"]:
            reason = f"{stt['consecutive_losses']} خسائر متتالية"
        if reason:
            self._set_state(halted=True, halt_reason=reason)
            cfg["auto_enabled"] = False
            self.db.kv_set("risk_config", cfg)
            self.log(None, "auto_halt", reason)
            self.alert("critical", "execution", f"إيقاف تلقائي للتداول: {reason}")

    def brokers(self) -> list[dict]:
        return [self.paper.status(), dict(OUT_OF_SCOPE)]
