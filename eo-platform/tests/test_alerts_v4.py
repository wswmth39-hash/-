"""V4 phase 12 — smart alerts on state transitions, debounce, de-duplication, Telegram delivery."""
import asyncio
import json
import threading
import time

from conftest import random_walk_bars
from fake_telegram import FakeTelegram
from eoplatform.service.core import Core
from eoplatform.service.watch import Watcher
from eoplatform.telegram_bot.bot import EOTelegramBot

TOKEN = "123456:TEST-token-not-real"


def _core(settings):
    settings.enable_binance = True
    core = Core(settings)
    core.started -= 1000
    return core


def _events(core, kind):
    return [e["message"] for e in core.db.all("SELECT message FROM events WHERE kind=? ORDER BY id", (kind,))]


def test_data_available_lost_and_back_are_alerted_once_each_after_confirmation(settings):
    core = _core(settings)
    w = Watcher(core)
    t = time.time()
    w.check_markets(t - 5); w.check_markets(t - 4)          # baseline after start: no data yet → silent
    assert _events(core, "data") == []
    core.hub.ingest_bars("BTCUSD", "binance", random_walk_bars(900, end=int(t), seed=1, p0=65000.0), now=t)
    w.check_markets(t)
    assert _events(core, "data") == []                       # one observation is not enough (debounce)
    w.check_markets(t + 1)
    assert len(_events(core, "data")) == 1 and "توفرت بيانات حقيقية" in _events(core, "data")[0]
    for k in range(3):
        w.check_markets(t + 2 + k)                           # unchanged state → no repeat
    assert len(_events(core, "data")) == 1
    w.check_markets(t + 100); w.check_markets(t + 101)       # feed silent → not live
    assert "انقطعت البيانات الحية" in _events(core, "data")[-1]
    later = t + 2000                                          # past the per-market cooldown
    core.hub.ingest_bars("BTCUSD", "binance", random_walk_bars(5, end=int(later), seed=2, p0=65000.0), now=later)
    w.cooldown.clear()
    w.check_markets(later); w.check_markets(later + 0.5)
    assert "عاد تدفق البيانات" in _events(core, "data")[-1]
    # structural unavailability (OTC, forex) never produces alerts
    assert not any("OTC" in e or "EURUSD" in e for e in _events(core, "data"))


def test_model_approval_and_withdrawal_alerts(settings):
    core = _core(settings)
    w = Watcher(core)
    w.check_models()                                          # baseline: nothing announced
    mid = core.db.execute("INSERT INTO models(market,duration,created_at,algo,path,metrics,status) "
                          "VALUES('ETHUSD',30,?, 'xgboost','/x','{}','champion')", (time.time(),)).lastrowid
    w.check_models()
    assert any(f"اعتُمد النموذج #{mid}" in e for e in _events(core, "model"))
    core.db.execute("UPDATE models SET status='retired', note='live accuracy below break-even' WHERE id=?", (mid,))
    w.check_models()
    assert any(f"سُحب النموذج المعتمد #{mid}" in e and "break-even" in e for e in _events(core, "model"))


def test_alerter_deduplicates_and_isolates_broken_sinks(settings):
    core = Core(settings)
    got = []
    core.alert.sinks += [lambda *a: (_ for _ in ()).throw(RuntimeError("down")), lambda *a: got.append(a)]
    core.alert("alert", "x", "same message")
    core.alert("alert", "x", "same message")                 # duplicate within 5 min
    assert len(got) == 1 and core.alert.status()["suppressed_duplicates"] == 1


def test_alerts_reach_allowed_users_on_telegram_with_hourly_cap(settings):
    core = Core(settings)
    fake = FakeTelegram(TOKEN)
    loop = asyncio.new_event_loop()
    th = threading.Thread(target=loop.run_forever, daemon=True)
    th.start()
    bot = EOTelegramBot(core, TOKEN, {111}, base_url=fake.base_url)
    asyncio.run_coroutine_threadsafe(bot.start(), loop).result(15)
    try:
        core.alert("critical", "data", "انقطعت البيانات الحية لـ بيتكوين")
        m = fake.wait_for(lambda m: "تنبيه" in m["text"] and "انقطعت" in m["text"])
        assert m["chat_id"] == 111
        core.alert("info", "data", "معلومة عادية")               # low level: not pushed
        bot.ALERTS_PER_HOUR = 2
        for i in range(5):
            core.alert("alert", "t", f"رسالة {i}")
        deadline = time.time() + 5
        while time.time() < deadline and bot.alerts_sent < 2:
            time.sleep(0.05)
        time.sleep(0.3)
        pushed = [x for x in fake.sent if "تنبيه" in x["text"]]
        assert len(pushed) == 2 and bot.alerts_dropped >= 4      # cap enforced
        assert not any("معلومة عادية" in x["text"] for x in fake.sent)
        assert TOKEN not in json.dumps(bot.state())
    finally:
        asyncio.run_coroutine_threadsafe(bot.stop(), loop).result(15)
        loop.call_soon_threadsafe(loop.stop)
        th.join(5)
        fake.close()
    assert bot.push_alert not in core.alert.sinks               # unregistered on stop
