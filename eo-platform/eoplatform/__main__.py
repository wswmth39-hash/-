"""Command line: python -m eoplatform <command>

  serve                 run the website + all background services
  create-admin          create/update the dashboard login (password asked interactively)
  bridge-token          create a token for the ExpertOption browser bridge (shown once)
  check-system          inspect THIS computer: CPU/RAM/GPU/disk, Ollama, model speed
  check-sources         verify live data sources from THIS computer (Binance reference feed, LLM)
  import-csv            import genuine historical data: --market ID --source S file.csv
  retrain               walk-forward train/validate models on stored genuine data
  analyze               one fast analysis from the command line: --market ID --duration 60
"""
from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import os
import platform
import shutil
import subprocess
import sys
import time


def cmd_serve(a):
    import uvicorn

    from .config import load_settings
    from .logging_setup import setup
    from .web.app import create_app
    s = load_settings(a.env)
    setup(s.log_dir)
    app = create_app(s)
    uvicorn.run(app, host=a.host or s.host, port=a.port or s.port, log_config=None, timeout_graceful_shutdown=15,
                proxy_headers=True, forwarded_allow_ips="127.0.0.1")


def cmd_create_admin(a):
    from .config import load_settings
    from .db import DB
    from .web.auth import create_user
    s = load_settings(a.env)
    pw = os.environ.get("EO_ADMIN_PASSWORD") or getpass.getpass("Password (min 10 chars): ")
    if not os.environ.get("EO_ADMIN_PASSWORD") and getpass.getpass("Repeat: ") != pw:
        sys.exit("passwords differ")
    create_user(DB(s.db_path), a.username, pw)
    print(f"user '{a.username}' saved (scrypt hash only; the password is not stored)")


def cmd_bridge_token(a):
    from .config import load_settings
    from .data.providers.bridge import new_token
    from .db import DB
    s = load_settings(a.env)
    print(new_token(DB(s.db_path), a.label))
    print("^ shown once. Paste it into the bridge userscript settings.", file=sys.stderr)


def _ollama_generate_speed(base: str, model: str) -> dict:
    import httpx
    t = time.time()
    r = httpx.post(base.rstrip("/").removesuffix("/v1") + "/api/generate",
                   json={"model": model, "prompt": "Reply with the single word: ready", "stream": False,
                         "think": False, "options": {"num_predict": 64}}, timeout=600)
    r.raise_for_status()
    d = r.json()
    ev, dur = d.get("eval_count", 0), d.get("eval_duration", 1) / 1e9
    return {"answer": d.get("response", "")[:60], "tokens_per_sec": round(ev / dur, 1) if dur else None,
            "load_seconds": round(d.get("load_duration", 0) / 1e9, 1), "wall_seconds": round(time.time() - t, 1)}


def cmd_check_system(a):
    from .config import load_settings
    s = load_settings(a.env)
    rep: dict = {"os": platform.platform(), "python": sys.version.split()[0], "cpu_count": os.cpu_count()}
    try:
        mem = dict(line.split(":", 1) for line in open("/proc/meminfo"))
        rep["ram_gb"] = round(int(mem["MemTotal"].split()[0]) / 2**20, 1)
    except OSError:
        rep["ram_gb"] = None
    rep["disk_free_gb"] = round(shutil.disk_usage(s.home).free / 2**30, 1)
    gpu = shutil.which("nvidia-smi")
    rep["gpu"] = subprocess.run([gpu, "--query-gpu=name,memory.total", "--format=csv,noheader"], capture_output=True,
                                text=True).stdout.strip() if gpu else "none detected (nvidia-smi absent)"
    oll = shutil.which("ollama")
    rep["ollama_binary"] = oll or "not installed — https://ollama.com/download"
    if oll:
        rep["ollama_version"] = subprocess.run([oll, "--version"], capture_output=True, text=True).stdout.strip()
    from .agents.llm import LocalLLM
    h = LocalLLM(s).health(force=True)
    rep["llm_server"] = h["detail"]
    if h["ok"]:
        try:
            sp = _ollama_generate_speed(s.llm_base_url, s.llm_model)
            rep["llm_speed"] = sp
            if sp["tokens_per_sec"]:
                # 14 agent calls x ~180 output tokens (prompt processing excluded)
                rep["estimated_full_agent_run_seconds"] = round(14 * 180 / sp["tokens_per_sec"])
        except Exception as e:
            rep["llm_speed"] = f"failed: {e}"
    ram = rep.get("ram_gb") or 0
    rep["qwen3.5_9b_fit"] = ("OK (≥16 GB RAM)" if ram >= 16 else
                             "tight: 9B Q4 needs ~7 GB for weights; close other apps or use a smaller tag" if ram >= 10
                             else "insufficient RAM for 9B; use qwen3.5:4b or smaller and set EO_LLM_MODEL")
    print(json.dumps(rep, indent=2, ensure_ascii=False))


def cmd_check_sources(a):
    """Verifies sources from this machine; reports facts only, never claims success it did not see."""
    import httpx
    import websockets

    from .config import load_settings
    s = load_settings(a.env)
    rep = {}
    try:
        r = httpx.get(f"{s.binance_rest}/api/v3/klines", params={"symbol": "BTCUSDT", "interval": "1s", "limit": 5},
                      timeout=10)
        r.raise_for_status()
        k = r.json()[-1]
        rep["binance_rest"] = f"OK — last 1s kline {time.strftime('%H:%M:%S', time.gmtime(k[0]/1000))}Z close {k[4]}"
    except Exception as e:
        rep["binance_rest"] = f"FAILED: {type(e).__name__}: {e}"

    async def ws_probe():
        url = f"{s.binance_ws.removesuffix('/ws')}/stream?streams=btcusdt@kline_1s"
        n, t = 0, time.time()
        async with websockets.connect(url, open_timeout=10) as ws:
            while time.time() - t < 8:
                json.loads(await asyncio.wait_for(ws.recv(), 8))
                n += 1
        return n
    try:
        rep["binance_stream"] = f"OK — {asyncio.run(ws_probe())} messages in 8s"
    except Exception as e:
        rep["binance_stream"] = f"FAILED: {type(e).__name__}: {e}"
    rep["expertoption"] = ("No official API exists. Genuine ExpertOption/OTC quotes come only from the bridge "
                           "userscript in your logged-in tab: see bridge/README.md. Check bridge status on the dashboard.")
    from .agents.llm import LocalLLM
    rep["local_llm"] = LocalLLM(s).health(force=True)["detail"]
    print(json.dumps(rep, indent=2, ensure_ascii=False))


def cmd_import_csv(a):
    from .config import load_settings
    from .data.hub import DataHub
    from .data.providers.csv_import import import_csv
    from .db import DB
    from .markets import ensure_catalog
    s = load_settings(a.env)
    db = DB(s.db_path)
    ensure_catalog(db)
    print(import_csv(db, DataHub(db), a.file, a.market, a.source))


def cmd_retrain(a):
    from .config import load_settings
    from .db import DB
    from .engine.model import Registry
    from .learning.trainer import retrain_all
    from .markets import ensure_catalog, get_market
    s = load_settings(a.env)
    db = DB(s.db_path)
    ensure_catalog(db)
    mk = [get_market(db, a.market)] if a.market else None
    for r in retrain_all(db, Registry(db, s.model_dir), s, mk):
        print(json.dumps({k: r.get(k) for k in ("market", "duration", "source", "samples", "status",
                                                "test_accuracy", "threshold", "note")}, ensure_ascii=False))


def cmd_analyze(a):
    from .config import load_settings
    from .service.core import Core
    c = Core(load_settings(a.env))
    sig = c.analyze_fast(a.market, a.duration, trigger="cli")
    sig.pop("features", None)
    sig.pop("evidence", None)
    print(json.dumps(sig, indent=2, ensure_ascii=False, default=str))


def main():
    p = argparse.ArgumentParser(prog="eoplatform")
    p.add_argument("--env", default=None, help="path to .env file")
    sub = p.add_subparsers(dest="cmd", required=True)
    sp = sub.add_parser("serve"); sp.add_argument("--host"); sp.add_argument("--port", type=int); sp.set_defaults(f=cmd_serve)
    sp = sub.add_parser("create-admin"); sp.add_argument("--username", default="admin"); sp.set_defaults(f=cmd_create_admin)
    sp = sub.add_parser("bridge-token"); sp.add_argument("--label", default="bridge"); sp.set_defaults(f=cmd_bridge_token)
    sub.add_parser("check-system").set_defaults(f=cmd_check_system)
    sub.add_parser("check-sources").set_defaults(f=cmd_check_sources)
    sp = sub.add_parser("import-csv"); sp.add_argument("file"); sp.add_argument("--market", required=True)
    sp.add_argument("--source", required=True, choices=["expertoption", "binance", "import"]); sp.set_defaults(f=cmd_import_csv)
    sp = sub.add_parser("retrain"); sp.add_argument("--market"); sp.set_defaults(f=cmd_retrain)
    sp = sub.add_parser("analyze"); sp.add_argument("--market", required=True)
    sp.add_argument("--duration", type=int, default=60); sp.set_defaults(f=cmd_analyze)
    a = p.parse_args()
    a.f(a)


if __name__ == "__main__":
    main()
