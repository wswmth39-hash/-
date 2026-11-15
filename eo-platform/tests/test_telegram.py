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
    m = fake.wait_for(lambda m: "مرحباً بك في EO_PredictorBot" in m["text"])
    assert "اختر السوق الذي تريد تحليله" in m["text"]
    assert "غير تابعة لشركة ExpertOption" in m["text"] and "ExpertOption AI" not in m["text"]
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
    assert "غير مصرّح" in m["text"] and str(STRANGER) in m["text"] and "مرحباً" not in m["text"]
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
            None, lambda: fake.wait_for(lambda m: "مرحباً بك في EO_PredictorBot" in m["text"]))
        st = dict(core.sup.status["telegram_bot"])
        await core.stop()
        return st
    st = asyncio.run(go())
    fake.close()
    assert st["state"] == "running" and st["restarts"] == 0



# ---------------------------------------------------------------- private chats only
GROUP = {"id": -100123, "type": "supergroup", "title": "g"}


def test_group_and_channel_messages_are_ignored_without_any_reply(running):
    core, bot, fake = running
    for chat in (GROUP, {"id": -5, "type": "group", "title": "g"}, {"id": -1007, "type": "channel", "title": "c"}):
        fake.command(OWNER, "/start", chat=chat)            # even the OWNER gets nothing in a group
        fake.command(STRANGER, "/start", chat=chat)         # and a stranger's ID is not leaked there
        fake.text(OWNER, "btc", chat=chat)
    fake.press(OWNER, "an:BTCUSD", chat=GROUP)
    time.sleep(1.5)
    assert all(m["chat_id"] > 0 for m in fake.sent)          # nothing ever sent to a group/channel id
    assert not [m for m in fake.sent if m["method"] == "sendMessage"]
    assert core.db.one("SELECT count(*) n FROM telegram_requests")["n"] == 0     # no analysis ran
    assert bot.ignored_non_private >= 7
    assert any("المحادثات الخاصة فقط" in a.get("text", "") for a in fake.answers)  # private toast only
    fake.command(OWNER, "/start")                           # the same owner in private still works
    fake.wait_for(lambda m: m["chat_id"] == OWNER and "EO_PredictorBot" in m["text"])
    assert _wait(lambda: bot.state()["replies_ok"].get("cmd_start") == 1)   # counted only when answered
    st = bot.state()
    assert st["denied"] == 0 and st["updates_handled"] == 1 and str(OWNER) not in str(st)


def test_bot_leaves_any_group_it_is_added_to(running):
    core, bot, fake = running
    fake.added_to(STRANGER, GROUP)
    fake.added_to(OWNER, {"id": -77, "type": "group", "title": "g2"}, status="administrator")
    fake.added_to(OWNER, {"id": OWNER, "type": "private"})   # (un)blocking in private: not a group
    end = time.time() + 10
    while len(fake.left) < 2 and time.time() < end:
        time.sleep(0.05)
    assert sorted(fake.left) == [-100123, -77] and bot.groups_left == 2
    ev = core.db.all("SELECT message FROM events WHERE kind='telegram' AND message LIKE '%غادرها%'")
    assert len(ev) == 2 and all("-100123" not in e["message"] and "-77" not in e["message"] for e in ev)


# ---------------------------------------------------------------- 409 polling conflict
def _wait(pred, timeout=15.0):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.05)
    return False


def test_polling_conflict_409_is_detected_alerted_and_shown_in_status(running):
    core, bot, fake = running
    assert bot.state()["conflict"] is False and bot.state()["polling"] is True
    fake.conflict = True                                       # a second instance grabs getUpdates
    assert _wait(lambda: bot.conflicts_total >= 1)
    st = bot.state()
    assert st["conflict"] is True and TOKEN not in str(st)
    alerts = core.db.all("SELECT level, message FROM events WHERE kind='telegram' AND level='critical'")
    assert len(alerts) == 1 and "409" in alerts[0]["message"] and TOKEN not in alerts[0]["message"]
    assert _wait(lambda: bot.conflicts_total >= 2)             # keeps retrying (no crash, no restart)
    assert len(core.db.all("SELECT 1 FROM events WHERE kind='telegram' AND level='critical'")) == 1   # one alert
    # health (dashboard) and /status text — in `serve`, svc_telegram registers the bot on Core
    core.telegram = bot
    h = core.health()["telegram"]
    assert h["conflict"] is True and h["conflicts_total"] >= 2 and TOKEN not in str(h)
    t = T.status_text(bot.service.status())
    assert "تعارض 409" in t and "نسخة أخرى" in t
    # the other instance stops → polling resumes; after the window the conflict clears + event
    fake.conflict = False
    fake.command(OWNER, "/status")
    m = fake.wait_for(lambda m: "حالة النظام" in m["text"], timeout=40)
    assert m                                                   # updates flow again
    bot.last_conflict_at = time.time() - 1000                  # simulate the 90 s quiet window passing
    bot.tick()
    assert bot.state()["conflict"] is False
    assert core.db.one("SELECT count(*) n FROM events WHERE kind='telegram' AND message LIKE '%انتهى تعارض%'")["n"] == 1
    assert "🟢 الاستطلاع يعمل" in T.status_text(bot.service.status())


def test_poll_error_callback_records_types_only_and_never_raises(settings):
    from telegram.error import Conflict, NetworkError
    core = Core(settings)
    bot = EOTelegramBot(core, TOKEN, {OWNER}, base_url="http://127.0.0.1:9/bot")
    bot.on_poll_error(NetworkError(f"boom https://api.telegram.org/bot{TOKEN}/getUpdates"))
    s = bot.state()
    assert s["last_error"] == "NetworkError" and s["error_active"] and s["conflict"] is False
    assert TOKEN not in str(s) and "🟡 خطأ في الاستطلاع" in T.telegram_line(s)
    bot.on_poll_error(Conflict("Conflict: terminated by other getUpdates request"))
    bot.on_poll_error(Conflict("again"))
    assert bot.state()["conflict"] and bot.conflicts_total == 2
    assert core.db.one("SELECT count(*) n FROM events WHERE level='critical' AND kind='telegram'")["n"] == 1


def test_dashboard_health_has_telegram_state_without_secrets(settings):
    from fastapi.testclient import TestClient
    settings.telegram_token, settings.telegram_allowed = TOKEN, (OWNER,)
    core = Core(settings)
    assert core.health()["telegram"] == {"enabled": True, "polling": False}   # configured, not started yet
    core.telegram = EOTelegramBot(core, TOKEN, {OWNER}, base_url="http://127.0.0.1:9/bot")
    core.telegram.on_poll_error(__import__("telegram.error", fromlist=["Conflict"]).Conflict("x"))
    h = core.health()
    assert h["telegram"]["conflict"] is True and h["telegram"]["expected_username"] == "EO_PredictorBot"
    assert TOKEN not in __import__("json").dumps(h)
    from eoplatform.web.app import create_app
    app = create_app(settings, start_services=False)
    app.state.core.telegram = core.telegram
    with TestClient(app) as c:                                 # public endpoint reveals nothing about it
        r = c.get("/healthz")
        assert "telegram" not in r.text and TOKEN not in r.text
        assert c.get("/api/health").status_code in (401, 403)  # full health needs login


def test_dashboard_js_renders_conflict_card():
    import pathlib
    js = (pathlib.Path(__file__).parents[1] / "eoplatform/web/static/app.js").read_text()
    html = (pathlib.Path(__file__).parents[1] / "eoplatform/web/static/index.html").read_text()
    assert "function tgView" in js and "تعارض 409" in js and "card('بوت Telegram'" in js and 'id="pill-tg"' in html


# ---------------------------------------------------------------- branding / non-affiliation
def test_branding_and_non_affiliation_everywhere():
    assert T.BOT_NAME == "EO_PredictorBot"
    for txt in (T.WELCOME, T.HELP):
        assert "EO_PredictorBot" in txt and "غير تابعة لشركة ExpertOption" in txt
    assert T.WELCOME.startswith("مرحباً بك في EO_PredictorBot") and "ExpertOption AI" not in T.WELCOME
    res = {"market": "BTCUSD", "market_name": "Bitcoin", "kind": "regular", "decision": "WAIT", "horizon": None,
           "timestamp": 1_800_000_000, "evaluated": []}
    assert "غير تابع لشركة ExpertOption" in T.result_text(res)          # every analysis result says it
    assert "EO_PredictorBot" in T.status_text({"status": "ok", "llm": {}, "live_markets": [], "champions": []})


def test_username_mismatch_is_warned_and_match_is_not(settings):
    async def run(username):
        core = Core(settings)
        fake = FakeTelegram(TOKEN, username=username)
        bot = EOTelegramBot(core, TOKEN, {OWNER}, base_url=fake.base_url)
        await bot.start()
        st = bot.state()
        await bot.stop()
        fake.close()
        return core, st
    core, st = asyncio.run(run("someone_else_bot"))
    assert st["username_match"] is False
    assert core.db.one("SELECT count(*) n FROM events WHERE message LIKE '%وليس @EO_PredictorBot%'")["n"] == 1
    core, st = asyncio.run(run("EO_PredictorBot"))               # same temp DB: no new warning added
    assert st["username_match"] is True
    assert core.db.one("SELECT count(*) n FROM events WHERE message LIKE '%وليس @EO_PredictorBot%'")["n"] == 1


# ---------------------------------------------------------------- startup "data loading"
def test_loading_state_during_startup_then_unavailable(settings):
    from eoplatform.markets import get_market
    settings.enable_binance = True                              # provider enabled, no data yet
    core = Core(settings)                                       # Core(), not start(): no network
    svc = TelegramService(core)
    ms = {m["id"]: m for m in svc.markets()}
    assert ms["BTCUSD"]["state"] == "LOADING"                   # crypto: Binance will backfill
    assert ms["EURUSD_OTC"]["state"] == "OFFLINE"               # OTC: no allowed live source → never "loading"
    assert ms["EURUSD"]["state"] == "OFFLINE"                   # forex: no reference feed, bridge off → unavailable
    kb = T.markets_keyboard(list(ms.values()), 0, "all").to_dict()["inline_keyboard"]
    assert any(b["text"].startswith("⏳") for row in kb for b in row)
    assert "قيد التحميل" in T.markets_text(list(ms.values()), "all")
    sigs = [core.analyze_fast("BTCUSD", d, trigger="telegram") for d in (30, 60, 120, 300)]
    r = svc.choose(get_market(core.db, "BTCUSD"), sigs)
    assert r["decision"] == "WAIT" and r["data_loading"] is True   # loading never forces a direction
    t = T.result_text(r)
    assert "قيد التحميل" in t and "أعد المحاولة بعد قليل" in t and "لا توجد بيانات حقيقية لهذا السوق" not in t
    st = svc.status()
    assert st["data_loading"] is True and "بيانات الأسواق قيد التحميل" in T.status_text(st)
    r_otc = svc.choose(get_market(core.db, "EURUSD_OTC"),
                       [core.analyze_fast("EURUSD_OTC", d, trigger="telegram") for d in (30, 60, 120, 300)])
    assert r_otc["data_loading"] is False and "لا توجد بيانات حقيقية" in T.result_text(r_otc)
    # after the startup window the same market is reported as unavailable, not loading
    core.started -= 10_000
    assert svc.markets(query="BTCUSD")[0]["state"] == "OFFLINE"
    r2 = svc.choose(get_market(core.db, "BTCUSD"), sigs)
    assert r2["data_loading"] is False and "لا توجد بيانات حقيقية لهذا السوق" in T.result_text(r2)
    assert svc.status()["data_loading"] is False


def test_no_loading_state_when_no_live_provider_is_enabled(settings):
    core = Core(settings)                                       # conftest: Binance disabled, bridge disabled
    svc = TelegramService(core)
    assert all(m["state"] != "LOADING" for m in svc.markets())  # nothing can arrive → say "unavailable"
    assert svc.status()["data_loading"] is False


def test_live_market_is_never_shown_as_loading(settings):
    settings.enable_binance = True
    core = Core(settings)
    _live(core)
    svc = TelegramService(core)
    assert svc.markets(query="BTCUSD")[0]["state"] == "LIVE"


def test_token_env_alias_is_accepted(tmp_path, monkeypatch):
    """EO_TELEGRAM_BOT_TOKEN works like EO_TELEGRAM_TOKEN; the canonical name wins if both are set."""
    from eoplatform.config import load_settings
    monkeypatch.setenv("EO_HOME", str(tmp_path))
    monkeypatch.delenv("EO_TELEGRAM_TOKEN", raising=False)
    monkeypatch.setenv("EO_TELEGRAM_BOT_TOKEN", "111:alias-not-real")
    empty = tmp_path / "empty.env"
    empty.write_text("")
    assert load_settings(str(empty)).telegram_token == "111:alias-not-real"
    monkeypatch.setenv("EO_TELEGRAM_TOKEN", "222:canonical-not-real")
    assert load_settings(str(empty)).telegram_token == "222:canonical-not-real"
