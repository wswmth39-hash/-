"""Broker adapters.

PaperBroker — simulated execution on GENUINE live prices. "Confirmed" means the
paper broker accepted the order at a live price it could verify at submission
time (data fresher than EO_LIVE_MAX_AGE). It is labelled paper everywhere.

Real-money execution is OUTSIDE THE SCOPE of this project (V4 decision): there is no real
broker adapter, no "live" mode and no code path that could place a financial order.
Background: ExpertOption publishes no trading API (checked 2026-11-14), and its Terms &
Conditions §6.2 prohibit bots and any interference with the client–server relationship.
"""
from __future__ import annotations

import time
from dataclasses import dataclass

EO_TERMS_URL = "https://expertoption.com/company/policy/terms/"


OUT_OF_SCOPE = {"name": "real_money", "available": False, "live_money": True,
                "detail": "التنفيذ المالي الحقيقي خارج نطاق هذا المشروع: لا يوجد وسيط حقيقي ولا وضع حقيقي في الكود. "
                          "(ExpertOption لا توفر واجهة تداول، وشروطها البند 6.2 تحظر الروبوتات.)",
                "terms_url": EO_TERMS_URL}


@dataclass
class Confirmation:
    accepted: bool
    broker_ref: str | None
    entry_price: float | None
    entry_ts: float | None
    reason: str = ""


class PaperBroker:
    name = "paper"
    live = False

    def __init__(self, hub, live_max_age: float):
        self.hub, self.live_max_age = hub, live_max_age

    def status(self) -> dict:
        return {"name": self.name, "available": True, "live_money": False,
                "detail": "تداول تجريبي على أسعار حقيقية حية — لا أموال حقيقية"}

    def submit(self, order: dict, now: float | None = None) -> Confirmation:
        price, rx = self.hub.last_price(order["market"], order["data_source"])
        now = now or time.time()
        if price is None or rx is None or now - rx > self.live_max_age:
            return Confirmation(False, None, None, None, "لا يوجد سعر حي يمكن التحقق منه لحظة الإرسال")
        return Confirmation(True, f"paper-{order['id']}", price, now)
