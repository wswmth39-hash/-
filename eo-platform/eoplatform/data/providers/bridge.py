"""ExpertOption bridge: the only path for genuine ExpertOption (incl. OTC) prices.

ExpertOption publishes no official API (checked Nov 2026). The available
"ExpertOption API" libraries are unofficial clients that re-use your session
token to talk to the private trading WebSocket, and several can place trades.
This project does not use them.

Instead, the companion userscript (bridge/expertoption-bridge.user.js) runs inside
YOUR logged-in ExpertOption tab, passively reads the quotes that the page already
receives for you, and posts them to this server. It never sends anything to
ExpertOption, never reads balance/account data, and never clicks or trades.
Check that this use is acceptable under ExpertOption's terms for your account.

Payload accepted by POST /api/bridge/ingest (Authorization: Bearer <bridge token>):
{
  "client": "eo-bridge/1.0",
  "assets": [
    {"asset": "<market id | platform asset id | platform asset name>",
     "otc": true|false|null,
     "ticks": [[unix_seconds, price], ...],
     "bars":  [[unix_seconds, o, h, l, c], ...]   # optional, 1-second bars only
    }
  ]
}
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import time

from ...db import DB
from ..hub import DataHub

SOURCE = "expertoption"
MAX_ITEMS = 5000


def new_token(db: DB, label: str = "bridge") -> str:
    tok = "eob_" + secrets.token_urlsafe(32)
    db.execute("INSERT INTO bridge_tokens(token_hash,label,created_at) VALUES(?,?,?)",
               (_hash(tok), label, time.time()))
    return tok


def _hash(tok: str) -> str:
    return hashlib.sha256(tok.encode()).hexdigest()


def verify_token(db: DB, tok: str | None) -> bool:
    if not tok:
        return False
    h = _hash(tok)
    row = db.one("SELECT id, token_hash FROM bridge_tokens WHERE token_hash=? AND revoked=0", (h,))
    if not row or not hmac.compare_digest(row["token_hash"], h):
        return False
    db.execute("UPDATE bridge_tokens SET last_used=? WHERE id=?", (time.time(), row["id"]))
    return True


def resolve_market(db: DB, asset: str, otc: bool | None) -> dict | None:
    a = str(asset).strip()
    m = db.one("SELECT * FROM markets WHERE id=? OR bridge_asset_id=?", (a, a))
    if m is None:
        norm = a.upper().replace("/", "").replace(" ", "").replace("-", "")
        is_otc = otc if otc is not None else norm.endswith("OTC")
        base = norm.removesuffix("OTC").removesuffix("_")
        for row in db.all("SELECT * FROM markets"):
            names = {row["id"].upper().removesuffix("_OTC"), row["name"].upper().replace("/", "").replace(" ", "")
                     .removesuffix("OTC")}
            if base in names and (row["kind"] == "otc") == bool(is_otc):
                m = row
                break
    if m is None:
        return None
    # Never let a payload flagged one way land on a market of the other kind.
    if otc is not None and (m["kind"] == "otc") != bool(otc):
        return None
    return m


def ingest(db: DB, hub: DataHub, payload: dict) -> dict:
    assets = payload.get("assets")
    if not isinstance(assets, list):
        raise ValueError("assets must be a list")
    result = {"accepted": 0, "rejected": 0, "unknown_assets": []}
    budget = MAX_ITEMS
    for item in assets[:50]:
        if not isinstance(item, dict):
            continue
        m = resolve_market(db, item.get("asset", ""), item.get("otc"))
        if m is None:
            result["unknown_assets"].append(str(item.get("asset"))[:64])
            continue
        ticks = [(float(t[0]), float(t[1])) for t in (item.get("ticks") or [])[:budget]
                 if isinstance(t, (list, tuple)) and len(t) >= 2]
        budget -= len(ticks)
        bars = [tuple(float(x) for x in b[:5]) for b in (item.get("bars") or [])[:max(budget, 0)]
                if isinstance(b, (list, tuple)) and len(b) >= 5]
        budget -= len(bars)
        r1 = hub.ingest_ticks(m["id"], SOURCE, ticks) if ticks else {"accepted": 0, "rejected": 0}
        r2 = hub.ingest_bars(m["id"], SOURCE, bars) if bars else {"accepted": 0, "rejected": 0}
        result["accepted"] += r1["accepted"] + r2["accepted"]
        result["rejected"] += r1["rejected"] + r2["rejected"]
        if (r1["accepted"] or r2["accepted"]) and not m["catalog_verified"]:
            db.execute("UPDATE markets SET catalog_verified=1 WHERE id=?", (m["id"],))
            db.event("info", "bridge", f"أول بيانات حقيقية من ExpertOption للسوق {m['id']}")
    if result["unknown_assets"]:
        unknown = set(db.kv_get("bridge_unknown_assets", []))
        unknown.update(result["unknown_assets"])
        db.kv_set("bridge_unknown_assets", sorted(unknown)[:200])
    hub.set_provider_state(SOURCE, True, f"last push from {str(payload.get('client', '?'))[:40]}")
    return result
