"""Telegram secret-code access gate: locked until the correct code, all features gated, owner bypass,
ban/revoke, code changeable, code never shown or logged."""
import asyncio
import logging
import threading
import time

from conftest import random_walk_bars
from fake_telegram import FakeTelegram
from eoplatform.service.core import Core
from eoplatform.telegram_bot.access import AccessControl
from eoplatform.telegram_bot.bot import EOTelegramBot

TOKEN = "123456:TEST-token-not-real"
OWNER, STRANGER = 111, 777
CODE = "Secret-2026"


def test_accesscontrol_unit(settings):
    core = Core(settings)
    ac = AccessControl(core)
    assert not ac.code_required()
    ac.set_code(CODE)
    assert ac.code_required() and ac.check_code(CODE) and not ac.check_code("wrong")
    assert core.db.kv_get("tg_access_code_hash") and CODE not in str(core.db.kv_get("tg_access_code_hash"))
    assert ac.status(STRANGER) == "locked"
    ac.grant(STRANGER); assert ac.status(STRANGER) == "granted" and ac.is_granted(STRANGER)
    ac.ban(STRANGER); assert ac.status(STRANGER) == "banned" and not ac.is_granted(STRANGER)
    ac.unban(STRANGER); ac.revoke(STRANGER); assert ac.status(STRANGER) == "locked"
    try:
        ac.set_code("ab"); assert False
    except ValueError:
        pass


def _run(core, allowed):
    fake = FakeTelegram(TOKEN)
    loop = asyncio.new_event_loop()
    th = threading.Thread(target=loop.run_forever, daemon=True); th.start()
    bot = EOTelegramBot(core, TOKEN, allowed, base_url=fake.base_url)
    asyncio.run_coroutine_threadsafe(bot.start(), loop).result(15)
    return fake, loop, th, bot


def _stop(fake, loop, th, bot):
    asyncio.run_coroutine_threadsafe(bot.stop(), loop).result(15)
    loop.call_soon_threadsafe(loop.stop); th.join(5); fake.close()


def test_gate_blocks_every_feature_until_code_then_owner_bypasses(settings, caplog):
    core = Core(settings)
    _live = lambda m="BTCUSD": core.hub.ingest_bars(m, "binance", random_walk_bars(4000, end=int(time.time()), seed=5, p0=65000.0), now=time.time())
    _live()
    core.telegram_blocked = False
    bot_access = AccessControl(core)
    bot_access.set_code(CODE)
    fake, loop, th, bot = _run(core, {OWNER})
    try:
        with caplog.at_level(logging.WARNING):
            # stranger: every entry point is blocked and asks for the code
            fake.command(STRANGER, "/start")
            m = fake.wait_for(lambda m: m["chat_id"] == STRANGER and "الرمز السري" in m["text"])
            assert "مرحبا" not in m["text"]
            fake.command(STRANGER, "/scan")
            fake.wait_for(lambda m: "الرمز السري" in m["text"] and m["chat_id"] == STRANGER)
            fake.press(STRANGER, "sig:BTCUSD")                          # buttons gated too
            n = len([x for x in fake.sent if x["chat_id"] == STRANGER])
            # wrong code rejected
            fake.text(STRANGER, "nope")
            fake.wait_for(lambda m: "رمز غير صحيح" in m["text"])
            assert core.db.one("SELECT count(*) n FROM telegram_access WHERE uid=? AND granted_at IS NOT NULL", (STRANGER,))["n"] == 0
            # correct code unlocks
            fake.text(STRANGER, CODE)
            fake.wait_for(lambda m: "تم التحقق" in m["text"])
            assert bot.access.status(STRANGER) == "granted"
            # now the stranger can actually use a feature
            fake.command(STRANGER, "/scan")
            fake.wait_for(lambda m: "AUTO SCANNER" in m["text"] and m["chat_id"] == STRANGER)
        # the code never appears in logs
        assert CODE not in caplog.text
        assert not any(m["text"] == CODE or CODE in m["text"] for m in fake.sent)
        # owner never needs the code
        fake.command(OWNER, "/start")
        fake.wait_for(lambda m: m["chat_id"] == OWNER and "اختر السوق" not in m["text"] and "الرمز السري" not in m["text"]
                      or "مرحبا" in m["text"] or "Bitcoin" in m["text"] or "السوق" in m["text"])
    finally:
        _stop(fake, loop, th, bot)


def test_ban_and_revoke_take_effect_immediately(settings):
    core = Core(settings)
    AccessControl(core).set_code(CODE)
    fake, loop, th, bot = _run(core, {OWNER})
    try:
        fake.text(STRANGER, CODE)
        fake.wait_for(lambda m: "تم التحقق" in m["text"])
        assert bot.access.status(STRANGER) == "granted"
        bot.access.ban(STRANGER)                                       # owner bans from the dashboard
        fake.command(STRANGER, "/start")
        fake.wait_for(lambda m: "تم حظرك" in m["text"] and m["chat_id"] == STRANGER)
        bot.access.unban(STRANGER); bot.access.revoke(STRANGER)        # revoke → must re-enter code
        fake.command(STRANGER, "/start")
        fake.wait_for(lambda m: "الرمز السري" in m["text"] and m["chat_id"] == STRANGER)
    finally:
        _stop(fake, loop, th, bot)


def test_access_api_never_returns_the_code(settings):
    from fastapi.testclient import TestClient
    from eoplatform.web.app import create_app
    core = Core(settings)
    core.telegram = EOTelegramBot(core, TOKEN, {OWNER}, base_url="http://127.0.0.1:9/bot")
    app = create_app(settings, start_services=False)
    app.state.core.telegram = core.telegram
    with TestClient(app) as c:
        r = c.post("/api/login", json={"username": "admin", "password": "x"})     # no admin → login fails
        assert c.get("/api/telegram/access").status_code in (401, 403)            # owner-only
