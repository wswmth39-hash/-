"""Smart alerts (V4 phase 12): turns STATE TRANSITIONS into alerts, never repeated states.

Watched every ``INTERVAL`` seconds:
* per market: genuine data became available / was lost / came back; a recent abnormal price jump
* models: a model became champion (passed validation); a champion was withdrawn (e.g. live
  performance below break-even)
* AUTO SCANNER: a qualified opportunity appeared (passed every gate)

Anti-noise: a market state must hold for ``CONFIRM`` consecutive checks before it counts
(no flapping), the Alerter drops identical messages within 5 minutes, and each market has its
own cooldown. Service failures needing intervention are alerted by the Supervisor; Telegram
409 conflicts by the bot itself.
"""
from __future__ import annotations

import time

from ..data.quality import availability
from ..markets import list_markets

INTERVAL = 15
CONFIRM = 2
MARKET_COOLDOWN_S = 600


class Watcher:
    def __init__(self, core):
        self.core = core
        self.state: dict[str, str] = {}          # market → confirmed state code
        self.pending: dict[str, tuple[str, int]] = {}
        self.cooldown: dict[str, float] = {}
        self.models: set[int] | None = None
        self.last_qualified = 0
        self.alerts = 0

    def _alert(self, level: str, kind: str, msg: str, key: str | None = None) -> None:
        now = time.time()
        if key and now - self.cooldown.get(key, 0) < MARKET_COOLDOWN_S:
            return
        if key:
            self.cooldown[key] = now
        self.alerts += 1
        self.core.alert(level, kind, msg)

    def check_markets(self, now: float | None = None) -> None:
        for m in list_markets(self.core.db, enabled_only=True):
            a = availability(self.core, m, now)
            code = "ok" if a["available"] else a["code"]
            if code in ("otc_requires_bridge", "no_allowed_source", "provider_disabled", "disabled", "loading"):
                self.state.setdefault(m["id"], code)       # structural / start-up: nothing to announce
                continue
            prev_pending = self.pending.get(m["id"])
            n = prev_pending[1] + 1 if prev_pending and prev_pending[0] == code else 1
            self.pending[m["id"]] = (code, n)
            if n < CONFIRM or self.state.get(m["id"]) == code:
                continue
            old = self.state.get(m["id"])
            self.state[m["id"]] = code
            name = m.get("name_ar") or m["name"]
            if old is None:
                continue                                  # first confirmed state after start: baseline only
            if code == "ok":
                if old == "no_data_yet":
                    self._alert("alert", "data", f"توفرت بيانات حقيقية حية لـ {name} ({m['id']})", f"{m['id']}:ok")
                elif old in ("not_live", "frozen", "data_anomaly"):
                    self._alert("alert", "data", f"عاد تدفق البيانات الحية لـ {name} ({m['id']})", f"{m['id']}:ok")
            elif code == "not_live" and old == "ok":
                self._alert("critical", "data", f"انقطعت البيانات الحية لـ {name} ({m['id']}) — لا تحليل حتى تعود",
                            f"{m['id']}:lost")
            elif code in ("data_anomaly", "frozen") and old == "ok":
                what = "قفزة سعرية غير طبيعية" if code == "data_anomaly" else "سعر مجمّد"
                self._alert("alert", "data", f"خلل في بيانات {name} ({m['id']}): {what} — التحليل متوقف مؤقتًا",
                            f"{m['id']}:{code}")

    def check_models(self) -> None:
        now_ids = {r["id"]: r for r in self.core.db.all(
            "SELECT id, market, duration FROM models WHERE status='champion'")}
        if self.models is None:                   # first run: remember, announce nothing
            self.models = set(now_ids)
            return
        for i in set(now_ids) - self.models:
            r = now_ids[i]
            self._alert("alert", "model", f"اعتُمد النموذج #{i} لـ {r['market']} {r['duration']} ث بعد اجتياز "
                                          "التحقق الإحصائي")
        for i in self.models - set(now_ids):
            r = self.core.db.one("SELECT market, duration, status, note FROM models WHERE id=?", (i,)) or {}
            self._alert("critical", "model", f"سُحب النموذج المعتمد #{i} لـ {r.get('market')} {r.get('duration')} ث: "
                                             f"{r.get('note') or 'تراجع الأداء'}")
        self.models = set(now_ids)

    def check_opportunities(self) -> None:
        st = self.core.auto.stats
        q = st.get("last_qualified_at") or 0
        if q > self.last_qualified:
            self.last_qualified = q
            chosen = (self.core.auto.board or {}).get("chosen") or (self.core.auto.board or {}).get("best") or {}
            what = f" ({chosen.get('market')} {chosen.get('decision')} {chosen.get('duration')} ث)" if chosen else ""
            self._alert("alert", "opportunity", f"ظهرت فرصة اجتازت كل الشروط{what} — تحليل فقط، لا تنفيذ",
                        f"opp:{chosen.get('market')}:{chosen.get('duration')}")

    def run_once(self, now: float | None = None) -> None:
        self.check_markets(now)
        self.check_models()
        self.check_opportunities()
