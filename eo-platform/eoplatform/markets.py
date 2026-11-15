"""Market catalog.

The seed list below is assembled from public descriptions of ExpertOption's
instruments. It has NOT been verified against your live account
(``catalog_verified=0``); the bridge marks a market as verified the first time
genuine ExpertOption data for it arrives, and you can add/disable markets in Settings.

Rules enforced elsewhere and repeated here because they matter:
* An OTC market only ever uses ExpertOption bridge data. OTC quotes are produced by
  the broker and do not exist anywhere else, so no external feed may stand in for them.
* A regular market may additionally use a *reference* feed (e.g. Binance spot for
  crypto). Reference data is labelled as such everywhere; it is close to, but not the
  same as, the quote ExpertOption shows you.
"""
from __future__ import annotations

from dataclasses import dataclass

from .db import DB


@dataclass(frozen=True)
class Market:
    id: str
    name: str
    name_ar: str
    kind: str          # 'regular' | 'otc'
    category: str      # forex | crypto | commodity | stock | index
    reference_symbol: str | None = None


_BASE = [
    # id, name, name_ar, category, binance reference (crypto only)
    ("EURUSD", "EUR/USD", "يورو/دولار", "forex", None),
    ("GBPUSD", "GBP/USD", "جنيه/دولار", "forex", None),
    ("USDJPY", "USD/JPY", "دولار/ين", "forex", None),
    ("AUDUSD", "AUD/USD", "أسترالي/دولار", "forex", None),
    ("USDCAD", "USD/CAD", "دولار/كندي", "forex", None),
    ("USDCHF", "USD/CHF", "دولار/فرنك", "forex", None),
    ("EURJPY", "EUR/JPY", "يورو/ين", "forex", None),
    ("EURGBP", "EUR/GBP", "يورو/جنيه", "forex", None),
    ("GBPJPY", "GBP/JPY", "جنيه/ين", "forex", None),
    ("NZDUSD", "NZD/USD", "نيوزيلندي/دولار", "forex", None),
    ("BTCUSD", "Bitcoin", "بيتكوين", "crypto", "BTCUSDT"),
    ("ETHUSD", "Ethereum", "إيثريوم", "crypto", "ETHUSDT"),
    ("LTCUSD", "Litecoin", "لايتكوين", "crypto", "LTCUSDT"),
    ("XRPUSD", "Ripple", "ريبل", "crypto", "XRPUSDT"),
    ("XAUUSD", "Gold", "الذهب", "commodity", None),
    ("XAGUSD", "Silver", "الفضة", "commodity", None),
    ("BRENT", "Brent Oil", "نفط برنت", "commodity", None),
]


def seed_catalog() -> list[Market]:
    out: list[Market] = []
    for mid, name, ar, cat, ref in _BASE:
        out.append(Market(mid, name, ar, "regular", cat, ref))
        if cat in ("forex", "crypto", "commodity"):
            # OTC twins never get a reference symbol — by design.
            out.append(Market(f"{mid}_OTC", f"{name} OTC", f"{ar} OTC", "otc", cat, None))
    return out


def ensure_catalog(db: DB) -> None:
    for m in seed_catalog():
        db.execute(
            "INSERT OR IGNORE INTO markets(id,name,name_ar,kind,category,reference_symbol) VALUES(?,?,?,?,?,?)",
            (m.id, m.name, m.name_ar, m.kind, m.category, m.reference_symbol))
    # Safety net: an OTC row can never carry a reference symbol, even if edited by hand.
    db.execute("UPDATE markets SET reference_symbol=NULL WHERE kind='otc'")


def list_markets(db: DB, enabled_only: bool = False) -> list[dict]:
    q = "SELECT * FROM markets" + (" WHERE enabled=1" if enabled_only else "") + " ORDER BY kind, category, id"
    return db.all(q)


def get_market(db: DB, market_id: str) -> dict | None:
    return db.one("SELECT * FROM markets WHERE id=?", (market_id,))


def allowed_sources(market: dict) -> list[str]:
    """Data sources that may legitimately back this market, in priority order."""
    if market["kind"] == "otc":
        return ["expertoption"]
    srcs = ["expertoption"]
    if market.get("reference_symbol"):
        srcs.append("binance")
    return srcs
