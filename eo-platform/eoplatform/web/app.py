"""FastAPI application: Arabic dashboard + JSON API + bridge ingestion."""
from __future__ import annotations

import asyncio
import json
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse

from ..config import ANALYSIS_PERIOD, DURATIONS, Settings
from ..data.hub import resample
from ..data.providers import bridge
from ..learning import stats, trainer
from ..markets import allowed_sources, get_market, list_markets
from ..service.core import Core
from .auth import COOKIE, SESSION_MAX_AGE, Auth

STATIC = Path(__file__).parent / "static"
MAX_BODY = 2 * 2**20


def create_app(settings: Settings, start_services: bool = True) -> FastAPI:
    core = Core(settings)
    auth = Auth(core.db, settings.session_secret)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if start_services:
            await core.start()
        yield
        await core.stop()

    app = FastAPI(title="ExpertOption AI Platform", lifespan=lifespan, docs_url=None, redoc_url=None,
                  openapi_url=None)
    app.state.core, app.state.auth = core, auth

    @app.middleware("http")
    async def security(request: Request, call_next):
        if int(request.headers.get("content-length") or 0) > MAX_BODY:
            return JSONResponse({"error": "body too large"}, 413)
        resp = await call_next(request)
        resp.headers["Content-Security-Policy"] = ("default-src 'self'; img-src 'self' data:; style-src 'self'; "
                                                   "script-src 'self'; connect-src 'self'; frame-ancestors 'none'")
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Referrer-Policy"] = "no-referrer"
        resp.headers["X-Frame-Options"] = "DENY"
        if request.url.path.startswith("/api/"):
            resp.headers["Cache-Control"] = "no-store"
        return resp

    # ------------------------------------------------------------------ auth deps
    def user(request: Request) -> dict:
        sess = auth.session(request.cookies.get(COOKIE))
        if not sess:
            raise HTTPException(401, "not authenticated")
        if request.method in ("POST", "PUT", "DELETE", "PATCH"):
            if request.headers.get("x-csrf-token") != sess["csrf"]:
                raise HTTPException(403, "bad csrf token")
        return sess

    def client_key(request: Request) -> str:
        return request.client.host if request.client else "?"

    # ------------------------------------------------------------------ pages
    @app.get("/")
    async def index(request: Request):
        if not auth.session(request.cookies.get(COOKIE)):
            return RedirectResponse("/login", 303)
        return FileResponse(STATIC / "index.html")

    @app.get("/login")
    async def login_page():
        return FileResponse(STATIC / "login.html")

    @app.get("/static/{name}")
    async def static(name: str):
        p = (STATIC / name).resolve()
        if p.parent != STATIC.resolve() or not p.is_file():
            raise HTTPException(404)
        return FileResponse(p)

    @app.get("/healthz")
    async def healthz():
        h = core.health()
        return JSONResponse({"status": h["status"], "uptime": h["uptime"]}, 200 if h["status"] == "ok" else 503)

    # ------------------------------------------------------------------ session
    @app.post("/api/login")
    async def login(request: Request):
        body = await request.json()
        if not auth.has_users():
            raise HTTPException(409, "no admin user yet: run `python -m eoplatform create-admin`")
        await asyncio.sleep(0.2)
        tok = auth.login(str(body.get("username", ""))[:64], str(body.get("password", ""))[:256], client_key(request))
        if not tok:
            raise HTTPException(401, "invalid credentials or too many attempts")
        resp = JSONResponse({"ok": True})
        resp.set_cookie(COOKIE, tok, max_age=SESSION_MAX_AGE, httponly=True, samesite="strict",
                        secure=settings.cookie_secure, path="/")
        return resp

    @app.post("/api/logout")
    async def logout(u=Depends(user)):
        resp = JSONResponse({"ok": True})
        resp.delete_cookie(COOKIE, path="/")
        return resp

    @app.get("/api/me")
    async def me(u=Depends(user)):
        return {"username": u["u"], "csrf": u["csrf"]}

    # ------------------------------------------------------------------ markets & data
    def _market_view(m: dict) -> dict:
        st = core.hub.status(m["id"])
        src, state = core.hub.best_source(m)
        return {**m, "allowed_sources": allowed_sources(m), "sources": st, "best_source": src, "state": state}

    @app.get("/api/markets")
    async def markets(u=Depends(user)):
        return [_market_view(m) for m in list_markets(core.db)]

    @app.get("/api/markets/availability")
    async def markets_availability(u=Depends(user)):
        """Markets that can be analysed now (genuine fresh data) vs. unavailable ones with the reason."""
        from ..data.quality import split_markets
        avail, unavail = split_markets(core, list_markets(core.db))
        return {"available": avail, "unavailable": unavail, "time": time.time()}

    @app.get("/api/data/health")
    async def data_health(u=Depends(user)):
        from ..data.quality import health
        return [health(core.hub, m, src) for (m, src) in sorted(core.hub.series)]

    @app.post("/api/markets/{mid}")
    async def update_market(mid: str, request: Request, u=Depends(user)):
        m = get_market(core.db, mid)
        if not m:
            raise HTTPException(404)
        body = await request.json()
        if "enabled" in body:
            core.db.execute("UPDATE markets SET enabled=? WHERE id=?", (int(bool(body["enabled"])), mid))
        if "bridge_asset_id" in body:
            v = str(body["bridge_asset_id"] or "").strip()[:64] or None
            core.db.execute("UPDATE markets SET bridge_asset_id=? WHERE id=?", (v, mid))
        return _market_view(get_market(core.db, mid))

    @app.get("/api/candles")
    async def candles(market: str, period: int = 10, limit: int = 120, source: str | None = None,
                      u=Depends(user)):
        m = get_market(core.db, market)
        if not m:
            raise HTTPException(404)
        src = source if source in allowed_sources(m) else core.hub.best_source(m)[0]
        if src is None:
            return {"market": market, "source": None, "candles": []}
        period = max(1, min(300, period))
        bars = core.hub.bars(market, src, seconds=period * min(limit, 500), include_current=True)
        c = resample(bars, period)
        return {"market": market, "source": src, "period": period,
                "candles": [[int(r[0]), r[1], r[2], r[3], r[4]] for r in c[-limit:]]}

    @app.get("/api/overview")
    async def overview(u=Depends(user)):
        mk = [_market_view(m) for m in list_markets(core.db, enabled_only=True)]
        return {
            "time": time.time(), "markets": mk, "health": core.health(), "monitor": core.monitor_cfg(),
            "breakeven": settings.breakeven, "payout": settings.payout, "durations": DURATIONS,
            "require_validated_model": settings.require_validated_model,
            "signals": _signals(limit=15), "agents": core.agent_activity[:10],
            "unknown_bridge_assets": core.db.kv_get("bridge_unknown_assets", []),
            "bridge_enabled": settings.bridge_enabled,
            "auto": {k: core.auto.board.get(k) for k in ("at", "why", "chosen", "evaluated")},
            "execution": {"mode": core.execution.config()["mode"], "auto_enabled": core.execution.config()["auto_enabled"],
                          **core.execution.state()},
        }

    # ------------------------------------------------------------------ analysis
    @app.post("/api/analyze")
    async def do_analyze(request: Request, u=Depends(user)):
        body = await request.json()
        try:
            sig = await core.analyze(str(body.get("market")), int(body.get("duration", 60)),
                                     trigger="manual", deep=bool(body.get("deep", True)))
        except KeyError:
            raise HTTPException(404, "unknown market") from None
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
        return {k: v for k, v in sig.items() if k != "features"}  # copy: agents still read sig

    def _signals(limit=50, market=None, source=None, offset=0) -> list[dict]:
        q, p = "SELECT * FROM signals WHERE 1=1", []
        if market:
            q += " AND market=?"; p.append(market)
        if source:
            q += " AND source=?"; p.append(source)
        q += " ORDER BY id DESC LIMIT ? OFFSET ?"
        p += [min(limit, 500), offset]
        rows = core.db.all(q, p)
        for r in rows:
            r["reasons"] = json.loads(r["reasons"] or "[]")
            r.pop("payload", None)
        return rows

    @app.get("/api/signals")
    async def signals(limit: int = 50, offset: int = 0, market: str | None = None, source: str | None = None,
                      u=Depends(user)):
        return _signals(limit, market, source, offset)

    @app.get("/api/signals/{sid}")
    async def signal(sid: int, u=Depends(user)):
        r = core.db.one("SELECT * FROM signals WHERE id=?", (sid,))
        if not r:
            raise HTTPException(404)
        r["reasons"] = json.loads(r["reasons"] or "[]")
        r["payload"] = json.loads(r["payload"] or "{}")
        return r

    @app.get("/api/agents")
    async def agents(u=Depends(user)):
        runs = core.db.all("SELECT id,signal_id,market,duration,started_at,finished_at,llm_used,llm_model,decision,error "
                           "FROM agent_runs ORDER BY id DESC LIMIT 30")
        return {"activity": core.agent_activity, "runs": runs, "llm": core.llm.health(),
                "llm_calls": core.llm.calls[-40:][::-1], "profile": settings.llm_profile}

    @app.get("/api/agents/{rid}")
    async def agent_run(rid: int, u=Depends(user)):
        r = core.db.one("SELECT * FROM agent_runs WHERE id=?", (rid,))
        if not r:
            raise HTTPException(404)
        r["transcript"] = json.loads(r["transcript"] or "{}")
        return r

    # ------------------------------------------------------------------ learning
    @app.get("/api/performance")
    async def performance(days: float = 30, u=Depends(user)):
        return stats.performance(core.db, settings.breakeven, since=time.time() - days * 86400, payout_for=settings.payout_for)

    @app.get("/api/models")
    async def models(u=Depends(user)):
        rows = core.db.all("SELECT id,market,duration,created_at,algo,metrics,status,promoted_at,note FROM models "
                           "ORDER BY id DESC LIMIT 100")
        for r in rows:
            m = json.loads(r["metrics"] or "{}")
            r["metrics"] = {k: m.get(k) for k in ("source", "train_samples", "test_samples", "test_accuracy",
                                                   "threshold", "calibration", "walk_forward", "breakeven",
                                                   "promotion_note", "test_range")}
        return {"models": rows, "last_retrain": core.db.kv_get("last_retrain")}

    @app.get("/api/models/summary")
    async def models_summary(u=Depends(user)):
        from ..learning.models_view import summary
        return summary(core.db)

    # ---------------------------------------------------------------- Telegram access control (owner)
    def _access():
        from ..telegram_bot.access import AccessControl
        return core.telegram.access if getattr(core, "telegram", None) else AccessControl(core)

    @app.get("/api/telegram/access")
    async def tg_access(u=Depends(user)):
        return _access().summary()                       # never includes the code, only code_required

    @app.post("/api/telegram/access/code")
    async def tg_set_code(request: Request, u=Depends(user)):
        body = await request.json()
        code = str(body.get("code") or "")
        try:
            _access().set_code(code)
        except ValueError:
            raise HTTPException(400, "الرمز قصير جدًا (4 أحرف على الأقل)") from None
        return {"ok": True, "code_required": True}

    @app.post("/api/telegram/access/clear-code")
    async def tg_clear_code(u=Depends(user)):
        _access().clear_code()
        return {"ok": True, "code_required": False}

    @app.post("/api/telegram/access/{action}/{uid}")
    async def tg_user_action(action: str, uid: int, u=Depends(user)):
        acc = _access()
        if action == "ban":
            acc.ban(uid)
        elif action == "unban":
            acc.unban(uid)
        elif action == "revoke":
            acc.revoke(uid)
        else:
            raise HTTPException(404)
        return {"ok": True, "status": acc.status(uid)}

    @app.get("/api/scanner")
    async def scanner(u=Depends(user)):
        """AUTO SCANNER statistics + the last board (no execution happens here)."""
        return {"stats": core.auto.stats_view(), "board": core.auto.board}

    @app.post("/api/scanner/scan")
    async def scanner_scan(u=Depends(user)):
        """On-demand scan of available markets (analysis only)."""
        r = await asyncio.get_running_loop().run_in_executor(core.signal_pool, core.auto.scan_report)
        for d in r["decisions"]:
            d.pop("panel", None)
        return r

    @app.get("/api/strategies")
    async def strategies(u=Depends(user)):
        return core.db.all("SELECT * FROM strategy_results WHERE id IN (SELECT max(id) FROM strategy_results "
                           "GROUP BY market,duration,strategy) ORDER BY market,duration,accuracy DESC")

    @app.post("/api/retrain")
    async def retrain(u=Depends(user)):
        if (core.db.kv_get("research_status") or {}).get("state") == "running":
            raise HTTPException(409, "a research cycle is already running")
        from ..learning import research

        async def go():
            async with core.agent_lock:
                await asyncio.get_running_loop().run_in_executor(core.pool, research.run_cycle, core)
        task = asyncio.create_task(go())
        core._bg.add(task)
        task.add_done_callback(core._bg.discard)
        return {"started": True}

    @app.get("/api/research")
    async def research_state(u=Depends(user)):
        return {"status": core.db.kv_get("research_status"), "last": core.db.kv_get("research_last")}

    # ------------------------------------------------------------------ monitor & settings
    @app.get("/api/monitor")
    async def monitor_get(u=Depends(user)):
        return core.monitor_cfg()

    @app.post("/api/monitor")
    async def monitor_set(request: Request, u=Depends(user)):
        return core.set_monitor_cfg(await request.json())

    @app.get("/api/settings")
    async def get_settings(u=Depends(user)):
        s = settings
        return {"llm": {"enabled": s.llm_enabled, "provider": s.llm_provider, "model": s.llm_model,
                        "base_url": s.llm_base_url, "debate_rounds": s.llm_debate_rounds, "risk_rounds": s.llm_risk_rounds},
                "data": {"binance_enabled": s.enable_binance, "bridge_enabled": s.bridge_enabled,
                         "retention_days": s.retention_days, "live_max_age": s.live_max_age,
                         "delayed_max_age": s.delayed_max_age, "stale_max_age": s.stale_max_age},
                "policy": {"payout": s.payout, "breakeven": s.breakeven,
                           "require_validated_model": s.require_validated_model,
                           "min_validation_samples": s.min_validation_samples},
                "durations": DURATIONS, "analysis_period": ANALYSIS_PERIOD,
                "note": "تُغيَّر هذه القيم من ملف ‎.env‎ ثم إعادة تشغيل الخدمة (لا تُرسل أي أسرار إلى المتصفح)."}

    @app.get("/api/events")
    async def events(limit: int = 100, u=Depends(user)):
        return core.db.all("SELECT * FROM events ORDER BY id DESC LIMIT ?", (min(limit, 500),))

    @app.get("/api/health")
    async def health(u=Depends(user)):
        return core.health()

    # ------------------------------------------------------------------ AUTO mode & execution
    @app.get("/api/metrics")
    async def metrics(window: float | None = None, u=Depends(user)):
        from ..engine import features as F_
        return {**core.metrics.summary(window), "feature_cache": dict(F_.CACHE_STATS)}

    # ------------------------------------------------------------------ prediction intelligence
    @app.get("/api/intel")
    async def intel(u=Depends(user)):
        """Everything the prediction-intelligence page shows, each item tagged verified/experimental."""
        from ..engine.model import wilson_lb
        rows = core.db.all("SELECT decision, status, market, duration, payload FROM signals WHERE source='fast' "
                           "AND created_at > ?", (time.time() - 7 * 86400,))
        dist = {"BUY": 0, "SELL": 0, "WAIT": 0}
        for r in rows:
            dist[r["decision"]] = dist.get(r["decision"], 0) + 1
        res = [r for r in rows if r["status"] in ("win", "loss")]
        acted = [r for r in res if r["decision"] != "WAIT"]

        def acc(rs):
            n = len(rs)
            w = sum(1 for r in rs if r["status"] == "win")
            return {"n": n, "wins": w, "accuracy": w / n if n else None, "ci95": [wilson_lb(w, n), 1 - wilson_lb(n - w, n)]
                    if n else None, "verified": n >= 30}
        failed = []
        for r in core.db.all("SELECT id, created_at, market, duration, candidate, decision, entry_price, exit_price, "
                             "payload FROM signals WHERE status='loss' ORDER BY id DESC LIMIT 25"):
            p = json.loads(r.pop("payload") or "{}")
            r.update(regime=p.get("regime"), signal_class=p.get("signal_class"),
                     against=[e["agent"] for e in (p.get("evidence_against") or [])][:3],
                     model_state=(p.get("model_status") or {}).get("state"))
            failed.append(r)
        ledger = core.db.all("SELECT id, created_at, market, duration, spec, algo, proposer, trades, accuracy, lb, "
                             "required, validated, outcome, reasons FROM hypothesis_ledger ORDER BY id DESC LIMIT 60")
        for r in ledger:
            r["reasons"] = json.loads(r["reasons"] or "[]")
        return {
            "distribution_7d": dist, "live_published": acc(acted), "live_candidates": acc(res),
            "by_market_duration": stats.performance(core.db, settings.breakeven, since=time.time() - 30 * 86400, payout_for=settings.payout_for)
            ["by_market_duration"],
            "by_regime": stats.performance(core.db, settings.breakeven, since=time.time() - 30 * 86400, payout_for=settings.payout_for)["by_regime"],
            "failed_predictions": failed, "ledger": ledger,
            "ledger_total": core.db.one("SELECT count(*) n FROM hypothesis_ledger")["n"],
            "forward_tests": core.db.all("SELECT * FROM forward_tests ORDER BY id DESC"),
            "proposals": core.db.all("SELECT id, created_at, proposer, weaknesses, accepted, rejected, secs, error "
                                     "FROM research_proposals ORDER BY id DESC LIMIT 15"),
            "champions": [{"id": m["id"], "market": m["market"], "duration": m["duration"],
                           "algo": json.loads(m["metrics"] or "{}").get("algo"),
                           "gates": json.loads(m["metrics"] or "{}").get("gates"),
                           "walk_forward": json.loads(m["metrics"] or "{}").get("walk_forward")}
                          for m in core.db.all("SELECT * FROM models WHERE status='champion'")],
            "required_accuracy": settings.breakeven + settings.cost_buffer, "breakeven": settings.breakeven,
            "exec_delay_s": settings.exec_delay_s, "cost_buffer": settings.cost_buffer,
            "data_sources": {"providers": core.hub.provider_view(), "quality": core.hub.quality,
                             "crosscheck": core.db.kv_get("crosscheck_last")},
        }

    @app.post("/api/forward-tests")
    async def new_forward_test(request: Request, u=Depends(user)):
        from ..learning import forward, trainer as T
        body = await request.json()
        m = get_market(core.db, str(body.get("market")))
        d = int(body.get("duration", 0))
        spec = str(body.get("spec", "base"))
        if m is None or d not in DURATIONS or spec not in T.SPECS:
            raise HTTPException(400, "unknown market, duration or spec")
        try:
            return await asyncio.get_running_loop().run_in_executor(
                core.pool, lambda: forward.register(core.db, core.registry, settings, m, d, spec,
                                                    str(body.get("rationale", ""))[:300],
                                                    int(body.get("target_n", forward.DEFAULT_TARGET_N))))
        except ValueError as e:
            raise HTTPException(400, str(e)) from None

    @app.get("/api/auto/board")
    async def auto_board(u=Depends(user)):
        return core.auto.board

    @app.get("/api/execution")
    async def execution_state(u=Depends(user)):
        ex = core.execution
        return {"config": ex.config(), "state": ex.state(), "stats": ex.stats(), "brokers": ex.brokers(),
                "payout": settings.payout}

    @app.post("/api/execution/config")
    async def execution_config(request: Request, u=Depends(user)):
        try:
            return core.execution.set_config(await request.json())
        except ValueError as e:
            raise HTTPException(400, str(e)) from None

    @app.post("/api/execution/kill")
    async def kill(u=Depends(user)):
        return core.execution.kill("زر الإيقاف الطارئ من لوحة التحكم")

    @app.post("/api/execution/resume")
    async def resume(u=Depends(user)):
        return core.execution.resume()

    @app.post("/api/execution/reset-paper")
    async def reset_paper(u=Depends(user)):
        return core.execution.reset_paper_balance()

    @app.get("/api/orders")
    async def orders(limit: int = 100, status: str | None = None, u=Depends(user)):
        q, p = "SELECT * FROM orders", []
        if status == "open":
            q += " WHERE status IN ('submitted','confirmed')"
        elif status:
            q += " WHERE status=?"; p.append(status)
        return core.db.all(q + " ORDER BY id DESC LIMIT ?", [*p, min(limit, 500)])

    @app.get("/api/execution/log")
    async def exec_log(limit: int = 100, u=Depends(user)):
        rows = core.db.all("SELECT * FROM execution_log ORDER BY id DESC LIMIT ?", (min(limit, 500),))
        for r in rows:
            r["detail"] = json.loads(r["detail"]) if r["detail"] else None
        return rows

    @app.post("/api/models/{mid}/rollback")
    async def rollback(mid: int, u=Depends(user)):
        try:
            core.registry.rollback(mid)
        except KeyError:
            raise HTTPException(404) from None
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
        return {"ok": True}

    @app.get("/api/news")
    async def news(u=Depends(user)):
        if core.news is None:
            return {"status": {"ok": False, "error": "disabled"}, "upcoming": []}
        now = time.time()
        return {"status": core.news.status(),
                "upcoming": [e for e in core.news.events if now - 3600 <= e["ts"] <= now + 86400
                             and e["impact"] in ("High", "Medium")][:40]}

    @app.get("/api/verify/{market}")
    async def verify(market: str, seconds: int = 120, u=Depends(user)):
        """Re-download the reference source's own klines and compare them second-by-second
        with what we stored. A real end-to-end check that our prices match the source."""
        from ..data.verify import verify_binance
        m = get_market(core.db, market)
        if not m or not m.get("reference_symbol") or m["kind"] != "regular":
            raise HTTPException(400, "verification is available for regular markets with a reference feed")
        return await asyncio.get_running_loop().run_in_executor(
            core.pool, verify_binance, core.db, settings.binance_rest, m, min(max(seconds, 30), 900))

    # ------------------------------------------------------------------ bridge
    @app.get("/api/bridge/tokens")
    async def tokens(u=Depends(user)):
        return core.db.all("SELECT id,label,created_at,last_used,revoked FROM bridge_tokens ORDER BY id DESC")

    @app.post("/api/bridge/tokens")
    async def new_tok(request: Request, u=Depends(user)):
        body = await request.json()
        tok = bridge.new_token(core.db, str(body.get("label", "bridge"))[:40])
        return {"token": tok, "note": "يُعرض مرة واحدة فقط. ضعه في إعدادات سكربت الجسر."}

    @app.post("/api/bridge/tokens/{tid}/revoke")
    async def revoke(tid: int, u=Depends(user)):
        core.db.execute("UPDATE bridge_tokens SET revoked=1 WHERE id=?", (tid,))
        return {"ok": True}

    @app.post("/api/bridge/ingest")
    async def ingest(request: Request):
        if not settings.bridge_enabled:
            raise HTTPException(403, "bridge disabled")
        authz = request.headers.get("authorization", "")
        tok = authz[7:] if authz.lower().startswith("bearer ") else None
        if not bridge.verify_token(core.db, tok):
            raise HTTPException(401, "invalid bridge token")
        try:
            return bridge.ingest(core.db, core.hub, await request.json())
        except (ValueError, TypeError) as e:
            raise HTTPException(400, str(e)[:200]) from None

    return app
