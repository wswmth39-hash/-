"""Alerts: persisted as events (level 'alert'/'critical', shown on the dashboard) and,
when EO_ALERT_WEBHOOK is set, POSTed as JSON to that URL (e.g. a private ntfy.sh topic).
Identical alerts are rate-limited to one per 5 minutes."""
from __future__ import annotations

import logging
import threading
import time

import httpx

log = logging.getLogger("eo.alerts")


class Alerter:
    def __init__(self, db, webhook: str = ""):
        self.db, self.webhook = db, webhook
        self._last: dict[str, float] = {}
        self.sent = 0
        self.failed = 0
        self.sinks: list = []          # extra delivery channels, e.g. Telegram (fn(level, kind, message))
        self.suppressed = 0

    def __call__(self, level: str, kind: str, message: str, data=None) -> None:
        key = f"{kind}:{message}"
        now = time.time()
        if now - self._last.get(key, 0) < 300:
            self.suppressed += 1
            return
        self._last[key] = now
        self.db.event(level, kind, message, data)
        log.warning("ALERT [%s] %s", kind, message)
        if self.webhook:
            threading.Thread(target=self._post, args=(level, kind, message), daemon=True).start()
        for sink in list(self.sinks):
            try:
                sink(level, kind, message)
            except Exception as e:          # a broken channel must never break the caller
                log.warning("alert sink failed: %s", type(e).__name__)

    def _post(self, level, kind, message) -> None:
        try:
            r = httpx.post(self.webhook, json={"level": level, "kind": kind, "message": message,
                                               "ts": time.time(), "app": "eoplatform"},
                           headers={"Title": f"eoplatform {level}"}, timeout=10)
            r.raise_for_status()
            self.sent += 1
        except Exception as e:
            self.failed += 1
            log.warning("alert webhook failed: %s", e)

    def status(self) -> dict:
        return {"webhook_configured": bool(self.webhook), "sent": self.sent, "failed": self.failed,
                "suppressed_duplicates": self.suppressed, "channels": len(self.sinks)}
