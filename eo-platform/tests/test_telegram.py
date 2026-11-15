"""Telegram bot: commands, market selection, immediate analysis, WAIT/BUY/SELL formatting,
invalid markets, missing data, engine failure, concurrency, duplicates, rate limits, security.
Runs the REAL python-telegram-bot library against a local fake Bot API server and the REAL
platform Core (synthetic prices only, in temporary databases)."""
import asyncio
import logging
import threading
import time

import pytest

from conftest import random_walk_bars
from fake_telegram import FakeTelegram
from eoplatform.service.core import Core
from eoplatform.telegram_bot import texts as T
from eoplatform.telegram_bot.bot import EOTelegramBot, TokenRedactor
from eoplatform.telegram_bot.service import EngineUnavailable, RateLimited, TelegramService

TOKEN = "123456:TEST-token-not-real"
OWNER, STRANGER = 111, 222


def _live(core, market="BTCUSD", source="binance"):
    end = int(time.time())
    core.hub.ingest_bars(market, source, random_walk_bars(4000, end=end, seed=5, p0=65000.0), now=time.time())


@pytest.fixture
def running(settings):
    """Real Core + real bot (long polling) against the fake Telegram API, on a background loop."""
    core = Core(settings)
    _live(core)
    fake = FakeTelegram(TOKEN)
    loop = asyncio.new_event_loop()
    th = threading.Thread(target=loop.run_forever, daemon=True)
    th.start()
    bot = EOTelegramBot(core, TOKEN, {OWNER}, base_url=fake.base_url)
    asyncio.run_coroutine_threadsafe(bot.start(), loop).result(15)
    yield core, bot, fake
    asyncio.run_coroutine_threadsafe(bot.stop(), loop).result(15)
    loop.call_soon_threadsafe(loop.stop)
    th.join(5)
    fake.close()


def test_start_shows_welcome_and_dynamic_markets(running):
    core, bot, fake = running
    assert "setMyCommands" in fake.calls and "getMe" in fake.calls
    fake.command(OWNER, "/start")
    m = fake.wait_for(lambda m: "مرحباً بك في ExpertOption AI" in m["text"])
    assert "اختر السوق الذي تريد تحليله" in m["text"]
    btns = fake.buttons(m)
    names = [t for t, d in btns if d and d.startswith("an:")]
    assert names and names[0].startswith("🟢")                          # live market listed first
    ids = {d[3:] for _, d in btns if d and d.startswith("an:")}
    from eoplatform.markets import list_markets
    assert ids <= {r["id"] for r in list_markets(core.db, enabled_only=True)}   # nothing hard-coded
    assert any(d == "mk:1:all" for _, d in btns)                         # pagination
    assert {"hist", "status", "search"} <= {d for _, d in btns}


def test_market_click_runs_engine_immediately_and_answers_wait(running):
    core, bot, fake = running
    fake.press(OWNER, "an:BTCUSD")
    m = fake.wait_for(lambda m: "السوق:" in m["text"] and "Bitcoin" in m["text"])
    t = m["text"]
    assert "انتظار" in t and "لا مدة مدعومة" in t                       # no validated model → WAIT
    assert "Binance" in t and "ليست أسعار ExpertOption ولا OTC" in t
    assert "الثقة:</b> لا تُعرض" in t and "السعر المرجعي:</b> 6" in t
    evaluated = t.split("المدد التي فُحصت:</b>")[1].split("\n")[0]
    assert all(d in evaluated for d in ("30 ثانية", "دقيقة واحدة", "دقيقتان", "5 دقائق"))   # all horizons shown
    assert "تحليل سوق آخر" in [b for b, _ in fake.buttons(m)][0]
    rows = core.db.all("SELECT * FROM telegram_requests")
    assert rows and rows[0]["status"] == "ok" and str(OWNER) not in rows[0]["user_hash"]
    assert core.db.one("SELECT count(*) n FROM signals WHERE trigger='telegram'")["n"] == 4   # all horizons analysed


def test_market_without_data_and_invalid_market(running):
    core, bot, fake = running
    fake.press(OWNER, "an:EURUSD_OTC")
    m = fake.wait_for(lambda m: "EUR/USD OTC" in m["text"])
    assert "غير متاح" in m["text"] and "انتظار" in m["text"] and "لا يوجد مصدر بيانات حقيقي" in m["text"]
    fake.press(OWNER, "an:NOT_A_MARKET")
    fake.wait_for(lambda m: "غير مدعوم" in m["text"])


def test_unauthorised_user_is_refused_without_analysis(running):
    core, bot, fake = running
    fake.command(STRANGER, "/start")
    m = fake.wait_for(lambda m: m["chat_id"] == STRANGER)
    assert "غير مصرّح" in m["text"] and str(STRANGER) in m["text"] and "ExpertOption AI" not in m["text"]
    fake.press(STRANGER, "an:BTCUSD")
    time.sleep(1)
    assert core.db.one("SELECT count(*) n FROM telegram_requests")["n"] == 0


def test_commands_status_history_help_and_search(running):
    core, bot, fake = running
    fake.command(OWNER, "/status")
    fake.wait_for(lambda m: "حالة النظام" in m["text"] and "جسر ExpertOption" in m["text"])
    fake.command(OWNER, "/help")
    fake.wait_for(lambda m: "/markets" in m["text"] and "لا تُنفَّذ أي صفقة حقيقية" in m["text"])
    fake.command(OWNER, "/history")
    fake.wait_for(lambda m: "لا توجد تحليلات سابقة" in m["text"])
    fake.command(OWNER, "/markets eur")
    m = fake.wait_for(lambda m: "نتائج البحث" in m["text"])
    assert all("EUR" in t for t, d in fake.buttons(m) if d and d.startswith("an:"))
    fake.text(OWNER, "ذهب")
    m = fake.wait_for(lambda m: "نتائج البحث عن «ذهب»" in m["text"])
    assert any("Gold" in t for t, _ in fake.buttons(m))
    fake.command(OWNER, "/markets zzzz")
    fake.wait_for(lambda m: "لا يوجد سوق مدعوم" in m["text"])


# ---------------------------------------------------------------- service level
def test_concurrent_users_duplicates_and_rate_limit(settings):
    core = Core(settings)
    _live(core)
    svc = TelegramService(core, per_minute=3)
    calls = []
    orig = svc._run_all

    def counting(mid):
        calls.append(mid)
        time.sleep(0.2)
        return orig(mid)
    svc._run_all = counting

    async def go():
        users = await asyncio.gather(*[svc.analyze(1000 + i, "BTCUSD") for i in range(8)])
        dup = await asyncio.gather(*[svc.analyze(1, "BTCUSD") for _ in range(5)])   # same user, same market
        return users, dup
    users, dup = asyncio.run(go())
    assert all(u["decision"] in ("BUY", "SELL", "WAIT") for u in users) and len(calls) == 8 + 1
    assert sum(1 for d in dup if d.get("duplicate")) == 4                        # one real analysis
    svc2 = TelegramService(core, per_minute=2, dedupe_s=0)

    async def burst():
        await svc2.analyze(7, "BTCUSD")
        await svc2.analyze(7, "ETHUSD")
        await svc2.analyze(7, "LTCUSD")
    with pytest.raises(RateLimited):
        asyncio.run(burst())


def test_engine_failure_and_timeout_give_no_signal(settings):
    core = Core(settings)
    svc = TelegramService(core, timeout_s=0.3)
    svc._run_all = lambda mid: (_ for _ in ()).throw(RuntimeError("engine down"))
    with pytest.raises(EngineUnavailable):
        asyncio.run(svc.analyze(1, "BTCUSD"))
    svc._run_all = lambda mid: time.sleep(2)
    with pytest.raises(EngineUnavailable):
        asyncio.run(svc.analyze(2, "ETHUSD"))
    assert {r["status"] for r in core.db.all("SELECT status FROM telegram_requests")} == {"error", "timeout"}


def _sig(d, decision, validated=False, lb=None, acc=None):
    return {"market": "BTCUSD", "duration": d, "decision": decision, "candidate": "BUY", "validated": validated,
            "entry_price": 65000.5, "data_source": "binance", "data_state": "LIVE", "data_age": 0.4,
            "regime_ar": "اتجاه صاعد", "timestamp": 1_800_000_000, "reasons": ["سبب"],
            "evidence_for": [{"agent": "وكيل الاتجاه", "score": 0.4, "facts": ["EMA9 فوق EMA21"]}],
            "evidence_against": [{"agent": "وكيل الزخم", "score": -0.2, "facts": ["زخم ضعيف"]}],
            "confidence_detail": {"wilson_lb": lb, "oos_accuracy": acc, "oos_samples": 400} if lb else None,
            "model_status": {"state": "validated" if validated else "none"}}


def test_choice_picks_best_validated_horizon_else_wait(settings):
    core = Core(settings)
    svc = TelegramService(core)
    m = {"id": "BTCUSD", "name": "Bitcoin", "name_ar": "بيتكوين", "kind": "regular"}
    sigs = [_sig(30, "WAIT"), _sig(60, "BUY", True, 0.57, 0.6), _sig(120, "BUY", True, 0.60, 0.63),
            _sig(300, "SELL", False)]
    r = svc.choose(m, sigs)
    assert r["decision"] == "BUY" and r["horizon"] == 120 and r["confidence"]["wilson_lb"] == 0.60
    t = T.result_text(r)
    assert "شراء" in t and "دقيقتان" in t and "دقة مُتحققة 63.0%" in t and "احتمال" not in t   # not calibrated
    assert "أدلة مؤيدة" in t and "أدلة معارضة" in t
    # validated but below break-even after payout → not a trade
    r2 = svc.choose(m, [_sig(30, "BUY", True, 0.50, 0.53), _sig(60, "WAIT"), _sig(120, "WAIT"), _sig(300, "WAIT")])
    assert r2["decision"] == "WAIT" and r2["confidence"] is None
    assert "الثقة:</b> لا تُعرض" in T.result_text(r2)
    # unvalidated BUY is never shown as BUY
    r3 = svc.choose(m, [_sig(30, "BUY", False), _sig(60, "WAIT"), _sig(120, "WAIT"), _sig(300, "WAIT")])
    assert r3["decision"] == "WAIT"


def test_token_is_redacted_from_logs():
    rec = logging.LogRecord("httpx", logging.INFO, __file__, 1, "POST https://api.telegram.org/bot%s/getMe",
                            (TOKEN,), None)
    TokenRedactor(TOKEN).filter(rec)
    assert TOKEN not in rec.getMessage() and "<TELEGRAM_TOKEN>" in rec.getMessage()


def test_markets_keyboard_pagination():
    ms = [{"id": f"M{i}", "name": f"M{i}", "kind": "regular", "state": "OFFLINE"} for i in range(19)]
    kb = T.markets_keyboard(ms, 2, "all").to_dict()["inline_keyboard"]
    flat = [b["callback_data"] for row in kb for b in row]
    assert "mk:1:all" in flat and "mk:3:all" not in flat and sum(1 for c in flat if c.startswith("an:")) == 3


def test_bot_runs_as_supervised_service_inside_the_platform(settings):
    """`python -m eoplatform serve` path: Core.start() spawns the bot when EO_TELEGRAM_TOKEN is set."""
    fake = FakeTelegram(TOKEN)
    settings.telegram_token, settings.telegram_allowed, settings.telegram_api_url = TOKEN, (OWNER,), fake.base_url
    settings.enable_binance = False

    async def go():
        core = Core(settings)
        _live(core)
        await core.start()
        for _ in range(100):
            if "getUpdates" in fake.calls:
                break
            await asyncio.sleep(0.05)
        fake.command(OWNER, "/start")
        await asyncio.get_running_loop().run_in_executor(
            None, lambda: fake.wait_for(lambda m: "مرحباً بك في ExpertOption AI" in m["text"]))
        st = dict(core.sup.status["telegram_bot"])
        await core.stop()
        return st
    st = asyncio.run(go())
    fake.close()
    assert st["state"] == "running" and st["restarts"] == 0
