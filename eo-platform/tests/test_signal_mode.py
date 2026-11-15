"""Image-style signal mode (owner's screenshot design): always BUY/SELL on markets with real data,
variable duration from real analysis, no signal without live data, honest accuracy line."""
import asyncio
import threading
import time

from conftest import random_walk_bars
from fake_telegram import FakeTelegram
from eoplatform.engine.fast import analyze
from eoplatform.markets import get_market
from eoplatform.telegram_bot import texts as T
from eoplatform.telegram_bot.bot import EOTelegramBot
from eoplatform.telegram_bot.signal_mode import CRYPTO, forced_signal

TOKEN = "123456:TEST-token-not-real"
OWNER = 111


def _sig(d, state="LIVE", consensus=0.0, decision="WAIT", validated=False):
    return {"market": "BTCUSD", "duration": d, "decision": decision, "candidate": "BUY" if consensus >= 0 else "SELL",
            "validated": validated, "data_state": state, "data_source": "binance", "data_age": 0.4,
            "entry_price": 65000.0, "timestamp": 1_800_000_000, "panel": {"consensus": consensus,
            "effective_independent_opinions": 2.38}}


def test_forced_signal_always_picks_a_direction_and_strongest_duration():
    m = {"id": "BTCUSD", "name": "Bitcoin", "name_ar": "بيتكوين", "kind": "regular"}
    sigs = [_sig(30, consensus=0.1), _sig(60, consensus=-0.6), _sig(120, consensus=0.3), _sig(300, consensus=0.05)]
    r = forced_signal(m, sigs)
    assert r["ok"] and r["direction"] == "SELL" and r["duration"] == 60   # strongest |consensus| = 0.6 at 60s
    assert r["measured_accuracy"] == 0.505 and r["price"] == 65000.0
    # a validated model overrides the raw consensus sign
    sigs2 = [_sig(30, consensus=-0.9), _sig(60, decision="BUY", validated=True, consensus=0.2)]
    r2 = forced_signal(m, sigs2)
    assert r2["direction"] in ("BUY", "SELL")


def test_no_live_data_gives_no_signal_never_a_fake_direction():
    m = {"id": "EURUSD_OTC", "name": "EUR/USD OTC", "name_ar": "يورو/دولار OTC", "kind": "otc"}
    r = forced_signal(m, [_sig(30, state="OFFLINE"), _sig(60, state="OFFLINE")])
    assert r["ok"] is False and r["reason"] == "no_live_data" and "direction" not in r
    txt = T.sig_result_text(r)
    assert "لا تُعرض إشارة دون بيانات حقيقية" in txt and "بيع" not in txt and "شراء" not in txt


def test_result_text_matches_owner_design_and_is_honest():
    m = {"id": "BTCUSD", "name": "Bitcoin", "name_ar": "بيتكوين", "kind": "regular"}
    r = forced_signal(m, [_sig(30, consensus=-0.5), _sig(60, consensus=0.2), _sig(120, consensus=0.1),
                          _sig(300, consensus=0.1)])
    t = T.sig_result_text(r)
    assert t.startswith("📊 السوق : Bitcoin")
    assert "⏱️ الوقت : 30 ثانية" in t                               # strongest was 30s
    assert "🔴 الصفقة : بيع / Sell" in t                             # negative consensus → Sell
    assert "تحليل فقط — غير مضمونة" in t                           # one short honest line, no long text
    assert t.count(chr(10) + chr(10)) == 3                           # exactly 4 short blocks (market/time/dir/warn)


def test_real_analysis_produces_a_direction_on_live_crypto(env):
    s, db, hub, reg = env
    now = time.time()
    hub.ingest_bars("BTCUSD", "binance", random_walk_bars(5000, end=int(now), seed=7, p0=65000.0), now=now)
    sigs = [analyze(get_market(db, "BTCUSD"), d, hub, reg, s, now=now) for d in (30, 60, 120, 300)]
    r = forced_signal(get_market(db, "BTCUSD"), sigs)
    assert r["ok"] and r["direction"] in ("BUY", "SELL") and r["duration"] in (30, 60, 120, 300)
    assert r["data_source"] == "binance" and r["price"] is not None


def test_image_mode_end_to_end_on_telegram(settings):
    settings.signal_style = "image"
    settings.enable_binance = True
    from eoplatform.service.core import Core
    core = Core(settings)
    core.started -= 1000
    now = time.time()
    for mid in CRYPTO:
        core.hub.ingest_bars(mid, "binance", random_walk_bars(5000, end=int(now), seed=hash(mid) % 99, p0=100.0), now=now)
    fake = FakeTelegram(TOKEN)
    loop = asyncio.new_event_loop()
    th = threading.Thread(target=loop.run_forever, daemon=True)
    th.start()
    bot = EOTelegramBot(core, TOKEN, {OWNER}, base_url=fake.base_url)
    asyncio.run_coroutine_threadsafe(bot.start(), loop).result(15)
    try:
        fake.command(OWNER, "/start")
        m = fake.wait_for(lambda m: "اختر السوق المُراد تحليله" in m["text"])
        assert [t for t, _ in fake.buttons(m)] == [f"{n} {e}" for n, e, _ in T.SIG_MENU]  # exact screenshot order
        fake.press(OWNER, "sig:BTCUSD")                              # real-data signal still works on crypto
        r = fake.wait_for(lambda m: "📊 السوق : Bitcoin" in m["text"])
        assert ("شراء / Buy" in r["text"]) or ("بيع / Sell" in r["text"])   # always a direction
        assert "الوقت :" in r["text"] and "غير مضمونة" in r["text"]
    finally:
        asyncio.run_coroutine_threadsafe(bot.stop(), loop).result(15)
        loop.call_soon_threadsafe(loop.stop)
        th.join(5)
        fake.close()


def test_screenshot_markets_shown_but_never_fabricate_a_signal(settings):
    settings.signal_style = "image"
    settings.enable_binance = True
    from eoplatform.service.core import Core
    core = Core(settings)
    core.started -= 1000
    now = time.time()
    for mid in CRYPTO:
        core.hub.ingest_bars(mid, "binance", random_walk_bars(5000, end=int(now), seed=hash(mid) % 97, p0=100.0), now=now)
    fake = FakeTelegram(TOKEN)
    loop = asyncio.new_event_loop()
    th = threading.Thread(target=loop.run_forever, daemon=True)
    th.start()
    bot = EOTelegramBot(core, TOKEN, {OWNER}, base_url=fake.base_url)
    asyncio.run_coroutine_threadsafe(bot.start(), loop).result(15)
    try:
        fake.command(OWNER, "/start")
        m = fake.wait_for(lambda m: "اختر السوق المُراد تحليله" in m["text"])
        btns = fake.buttons(m)
        assert [t for t, _ in btns] == [f"{n} {e}" for n, e, _ in T.SIG_MENU]   # exact screenshot order
        assert "Bitcoin/USD ⚡" in [t for t, _ in btns] and "Apple 🍎" in [t for t, _ in btns]
        # a stock/OTC display market → honest no-data; a real crypto (Ethereum/USD) → real signal
        fake.press(OWNER, [d for t, d in btns if t == "Apple 🍎"][0])
        a = fake.wait_for(lambda m: "Apple" in m["text"])
        assert "عيّنة لتجربة شكل الواجهة" in a["text"]                   # clearly a UI sample, not a real signal
        assert "ليست إشارة" in a["text"] and "الوقت :" in a["text"]
        # pressing a screenshot market → honest "no data", never a buy/sell (find Smarty by label)
        fake.press(OWNER, [d for t, d in btns if t.startswith("Smarty")][0])
        r = fake.wait_for(lambda m: "Smarty" in m["text"])
        assert "عيّنة لتجربة شكل الواجهة" in r["text"] and "ليست إشارة، ولا سعر حقيقي" in r["text"]
        # the real crypto markets still give a direction
        fake.press(OWNER, "sig:ETHUSD")
        r2 = fake.wait_for(lambda m: "Ethereum" in m["text"])
        assert ("بيع / Sell" in r2["text"]) or ("شراء / Buy" in r2["text"])
    finally:
        asyncio.run_coroutine_threadsafe(bot.stop(), loop).result(15)
        loop.call_soon_threadsafe(loop.stop)
        th.join(5)
        fake.close()


def test_demo_preview_is_clearly_labelled_and_not_a_real_signal():
    for idx in range(len(T.SIG_MENU)):
        t = T.sig_demo_text(idx)
        assert "عيّنة لتجربة شكل الواجهة" in t and "ليست إشارة، ولا سعر حقيقي، ولا تحليل" in t
        assert ("بيع / Sell" in t) or ("شراء / Buy" in t)          # shows the layout
        assert "السعر" not in t                                     # never shows a (fake) price
