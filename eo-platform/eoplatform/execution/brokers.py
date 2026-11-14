"""Broker adapters.

PaperBroker — simulated execution on GENUINE live prices. "Confirmed" means the
paper broker accepted the order at a live price it could verify at submission
time (data fresher than EO_LIVE_MAX_AGE). It is labelled paper everywhere.

ExpertOptionBroker — deliberately NOT implemented:
  * ExpertOption publishes no trading API (checked 2026-11-14: /api and /developers
    return 404; no developer documentation exists).
  * ExpertOption's Terms & Conditions §6.2 (read from expertoption.com on
    2026-11-14) prohibit "any implantations to the client–server relationship ...
    the use of automated players (also known as 'bots')", with account blocking,
    cancelled payments and seized funds.
  Automating real orders would therefore require either an unofficial protocol
  client or UI automation — both forbidden by the platform. The adapter exists so
  the UI can show the reason, and so an official API could be plugged in if
  ExpertOption ever provides one (it would have to confirm each order, see
  ``Confirmation`` below).
"""
from __future__ import annotations

import time
from dataclasses import dataclass

EO_TERMS_URL = "https://expertoption.com/company/policy/terms/"


class BrokerUnavailable(Exception):
    pass


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


class ExpertOptionBroker:
    name = "expertoption"
    live = True

    def status(self) -> dict:
        return {"name": self.name, "available": False, "live_money": True,
                "detail": ("غير متاح: لا توجد واجهة تداول رسمية من ExpertOption، وشروطها (البند 6.2) تحظر "
                           "الروبوتات وأي تدخل في الاتصال بين العميل والخادم، مع حظر الحساب ومصادرة الأموال."),
                "terms_url": EO_TERMS_URL}

    def submit(self, order: dict, now: float | None = None) -> Confirmation:
        raise BrokerUnavailable(self.status()["detail"])
