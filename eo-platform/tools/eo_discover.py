"""ExpertOption READ-ONLY discovery tool — run on YOUR computer (your network reaches ExpertOption).

What it does (nothing else):
  1. connects to ExpertOption's quote WebSocket with your own account token (from .env),
  2. asks for the asset list and finds the 8 requested markets,
  3. asks for a short sample of recent candles for each of them,
  4. saves everything to eo_discovery.json WITH THE TOKEN REMOVED, and prints a summary.

It never trades: every outgoing message is checked against a read-only allow-list, and there is
no buy/sell code in this file. Prefer a DEMO account token.

Usage (inside the eo-platform folder, venv active):
    python tools/eo_discover.py                 # region defaults to Europe
    python tools/eo_discover.py --region us     # eu | us | in | sg | hk

.env must contain:  EO_EXPERTOPTION_TOKEN=<token>   (never commit or share it)
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path

REGIONS = {k: f"wss://fr24g1{k}.expertoption.com/" for k in ("eu", "us", "in", "sg", "hk")}
ORIGIN = "https://app.expertoption.com"
READ_ONLY_ACTIONS = {"multipleAction", "assets", "environment", "getCandlesTimeframes", "assetHistoryCandles",
                     "subscribeCandles", "unsubscribeCandles", "ping", "setTimeZone"}
TARGETS = {   # requested market → name patterns to look for in ExpertOption's own asset list
    "Football Index": [r"football"],
    "Smarty": [r"smarty"],
    "USD/NGN (OTC)": [r"usd.?ngn"],
    "EUR/USD (OTC)": [r"eur.?usd"],
    "GBP/USD (OTC)": [r"gbp.?usd"],
    "USD/JPY (OTC)": [r"usd.?jpy"],
    "Gold": [r"\bgold\b", r"xau"],
    "Silver": [r"\bsilver\b", r"xag"],
}


def load_token(env_path: Path) -> str:
    tok = os.environ.get("EO_EXPERTOPTION_TOKEN", "").strip()
    if not tok and env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            if line.strip().startswith("EO_EXPERTOPTION_TOKEN="):
                tok = line.split("=", 1)[1].strip().strip('"').strip("'")
    if not tok:
        sys.exit("EO_EXPERTOPTION_TOKEN is not set in .env")
    return tok


def scrub(obj, token: str):
    """Remove the token (and anything token-like) from data before saving/printing."""
    s = json.dumps(obj, ensure_ascii=False)
    s = s.replace(token, "<TOKEN>")
    s = re.sub(r'"token"\s*:\s*"[^"]*"', '"token": "<TOKEN>"', s)
    return json.loads(s)


class Session:
    def __init__(self, ws, token: str):
        self.ws, self.token, self.ns = ws, token, 0
        self.received: list[dict] = []

    async def send(self, action: str, message) -> None:
        if action not in READ_ONLY_ACTIONS:
            raise RuntimeError(f"refused: '{action}' is not a read-only action")
        if action == "multipleAction":
            for a in message["actions"]:
                if a["action"] not in READ_ONLY_ACTIONS:
                    raise RuntimeError(f"refused: '{a['action']}' is not a read-only action")
        self.ns += 1
        await self.ws.send(json.dumps({"action": action, "message": message, "token": self.token,
                                       "ns": self.ns, "v": 18}))

    async def collect(self, seconds: float) -> None:
        end = time.time() + seconds
        while time.time() < end:
            try:
                raw = await asyncio.wait_for(self.ws.recv(), timeout=max(0.1, end - time.time()))
            except asyncio.TimeoutError:
                break
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8", "replace")
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            self.received.append(msg)
            if msg.get("action") == "multipleAction":
                self.received.extend((msg.get("message") or {}).get("actions") or [])


def find_assets(received: list[dict]) -> list[dict]:
    out = []
    for m in received:
        if m.get("action") != "assets":
            continue
        body = m.get("message")
        items = body.get("assets") if isinstance(body, dict) else body
        for a in items or []:
            if isinstance(a, dict):
                out.append(a)
    return out


def match(assets: list[dict]) -> dict[str, list[dict]]:
    res = {}
    for label, pats in TARGETS.items():
        want_otc = "(OTC)" in label
        hits = []
        for a in assets:
            text = " ".join(str(a.get(k, "")) for k in ("name", "symbol", "title", "fullname")).lower()
            if any(re.search(p, text) for p in pats):
                is_otc = "otc" in text or bool(a.get("is_otc"))
                if "(OTC)" not in label or is_otc == want_otc or want_otc and is_otc:
                    hits.append({k: a.get(k) for k in a if k not in ("icon", "image")})
        res[label] = hits
    return res


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--region", default="eu", choices=sorted(REGIONS))
    ap.add_argument("--env", default=str(Path(__file__).resolve().parents[1] / ".env"))
    ap.add_argument("--out", default="eo_discovery.json")
    a = ap.parse_args()
    token = load_token(Path(a.env))
    import websockets
    url = REGIONS[a.region]
    print(f"connecting (read-only) to {url} ...")
    async with websockets.connect(url, origin=ORIGIN, max_size=2**24, open_timeout=20) as ws:
        s = Session(ws, token)
        await s.send("multipleAction", {"token": token, "actions": [
            {"action": "assets", "message": None, "ns": None, "v": 18, "token": token},
            {"action": "getCandlesTimeframes", "message": None, "ns": None, "v": 18, "token": token},
            {"action": "environment", "message": None, "ns": None, "v": 18, "token": token}]})
        await s.collect(12)
        assets = find_assets(s.received)
        found = match(assets)
        now = int(time.time())
        for label, hits in found.items():
            for h in hits[:2]:
                if h.get("id") is None:
                    continue
                await s.send("assetHistoryCandles", {"assetid": h["id"], "periods": [[now - 600, now]],
                                                      "timeframes": [5, 60]})
        await s.collect(10)
    report = scrub({"at": time.time(), "region": a.region, "assets_total": len(assets), "matches": found,
                    "actions_seen": sorted({m.get("action") for m in s.received if m.get("action")}),
                    "history_samples": [m for m in s.received if m.get("action") == "assetHistoryCandles"][:16],
                    "timeframes": [m for m in s.received if m.get("action") == "getCandlesTimeframes"][:1],
                    "errors": [m for m in s.received if m.get("action") == "error"][:10],
                    "assets_sample": assets[:400]}, token)
    Path(a.out).write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nassets received: {len(assets)}")
    for label, hits in found.items():
        print(f"  {label:16s}: " + (", ".join(f"id={h.get('id')} {h.get('name') or h.get('symbol')}" for h in hits)
                                    or "NOT FOUND in the asset list"))
    print(f"history responses: {len(report['history_samples'])} | errors: {len(report['errors'])}")
    print(f"\nsaved {a.out} (token removed). Send this file back — it contains no secrets.")


if __name__ == "__main__":
    asyncio.run(main())
