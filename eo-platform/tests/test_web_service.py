import asyncio
import json
import time

import pytest
from fastapi.testclient import TestClient

from conftest import random_walk_bars
from eoplatform.data.providers.bridge import new_token
from eoplatform.web.app import create_app
from eoplatform.web.auth import create_user


@pytest.fixture
def client(settings):
    app = create_app(settings, start_services=False)
    create_user(app.state.core.db, "admin", "correct-horse-1")
    with TestClient(app) as c:
        c.app_ref = app
        yield c


def login(c):
    r = c.post("/api/login", json={"username": "admin", "password": "correct-horse-1"})
    assert r.status_code == 200
    return c.get("/api/me").json()["csrf"]


def test_auth_and_security_headers(client):
    assert client.get("/api/overview").status_code == 401
    assert client.get("/", follow_redirects=False).status_code == 303
    assert client.post("/api/login", json={"username": "admin", "password": "wrong-password"}).status_code == 401
    csrf = login(client)
    r = client.get("/api/overview")
    assert r.status_code == 200 and "script-src 'self'" in r.headers["content-security-policy"]
    assert r.headers["cache-control"] == "no-store"
    assert client.post("/api/monitor", json={"enabled": True}).status_code == 403          # no CSRF header
    assert client.post("/api/monitor", json={"enabled": True}, headers={"X-CSRF-Token": csrf}).json()["enabled"]
    assert client.get("/static/..%2Fapp.py").status_code == 404
    page = client.get("/").text
    assert 'dir="rtl"' in page and "<script>" not in page                                 # no inline script
    js = client.get("/static/app.js").text + client.get("/static/login.js").text
    settings_ = client.app_ref.state.core.s
    assert settings_.session_secret not in js and "eob_" not in js        # no secret shipped to the browser
    assert "session_secret" not in json.dumps(client.get("/api/settings").json())


def test_login_throttling(client):
    for _ in range(5):
        client.post("/api/login", json={"username": "admin", "password": "nope-nope-nope"})
    assert client.post("/api/login", json={"username": "admin", "password": "correct-horse-1"}).status_code == 401


def test_bridge_off_by_default(client):
    tok = new_token(client.app_ref.state.core.db)
    r = client.post("/api/bridge/ingest", json={"assets": []}, headers={"Authorization": "Bearer " + tok})
    assert r.status_code == 403          # opt-in only (ExpertOption T&C §6.2)


def test_bridge_ingest_and_analyze(client):
    core = client.app_ref.state.core
    core.s.bridge_enabled = True
    tok = new_token(core.db)
    assert client.post("/api/bridge/ingest", json={"assets": []}).status_code == 401
    now = time.time()
    ticks = [[now - 1500 + i, 1.1 + 1e-5 * ((i * 7919) % 13 - 6)] for i in range(1500)]
    r = client.post("/api/bridge/ingest", json={"client": "test", "assets": [{"asset": "EURUSD_OTC", "otc": True, "ticks": ticks}]},
                    headers={"Authorization": "Bearer " + tok})
    assert r.json()["accepted"] == 1500
    core.hub.tick()
    csrf = login(client)
    sig = client.post("/api/analyze", json={"market": "EURUSD_OTC", "duration": 30, "deep": False},
                      headers={"X-CSRF-Token": csrf}).json()
    for k in ("market_name", "decision", "duration", "timestamp", "confidence", "reasons", "trend", "data_age", "data_state"):
        assert k in sig
    assert sig["data_source"] == "expertoption" and sig["kind"] == "otc"
    assert client.post("/api/analyze", json={"market": "NOPE", "duration": 30}, headers={"X-CSRF-Token": csrf}).status_code == 404
    assert client.post("/api/analyze", json={"market": "EURUSD", "duration": 45}, headers={"X-CSRF-Token": csrf}).status_code == 400
    c = client.get("/api/candles?market=EURUSD_OTC&period=10").json()
    assert c["source"] == "expertoption" and len(c["candles"]) > 50
    hist = client.get("/api/signals").json()
    assert hist[0]["id"] == sig["id"]
    assert client.get("/api/performance").status_code == 200 and client.get("/api/health").json()["llm"]["ok"] is False


def test_supervisor_restarts_crashed_service(settings):
    from eoplatform.db import DB
    from eoplatform.service.core import Supervisor

    async def go():
        sup = Supervisor(DB(settings.db_path))
        runs = []

        async def flaky():
            runs.append(1)
            if len(runs) < 3:
                raise RuntimeError("boom")
            await asyncio.sleep(10)
        sup.spawn("flaky", flaky)
        await asyncio.sleep(3.5)
        st = dict(sup.status["flaky"])
        await sup.shutdown()
        return runs, st
    runs, st = asyncio.run(go())
    assert len(runs) == 3 and st["restarts"] == 2 and st["state"] == "running"


def test_graceful_stop_flushes_bars(settings):
    app = create_app(settings, start_services=True)
    core = app.state.core
    with TestClient(app):
        now = time.time()
        core.hub.ingest_ticks("EURUSD_OTC", "expertoption", [(now - 3, 1.1), (now - 2, 1.1001)])
    # after shutdown the DB is closed; reopen and verify the data was persisted
    from eoplatform.db import DB
    assert len(DB(settings.db_path).bars("EURUSD_OTC", "expertoption", 0)) >= 1
