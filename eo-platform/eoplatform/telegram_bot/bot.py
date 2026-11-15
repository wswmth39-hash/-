"""Arabic Telegram bot — async handlers on top of the existing platform Core.

* Long polling only: nothing is exposed publicly (no webhook, no internal API).
* Authorization: only Telegram user IDs listed in EO_TELEGRAM_ALLOWED_USERS may use it.
  With an empty list nobody is authorised (secure default); an unauthorised user is told
  their own numeric ID so the owner can add it, and nothing else is revealed.
* The bot token is read from EO_TELEGRAM_TOKEN and redacted from every log record.
* Private chats only: updates from groups, supergroups and channels are ignored without any
  reply (a reply would leak results to every group member), and the bot leaves any group it
  is added to.
* Polling health is tracked: a 409 Conflict (another process polling with the same token) is
  detected, raised as an alert and reported in /status and on the dashboard.
"""
from __future__ import annotations

import logging
import re
import time

from telegram import BotCommand, Update
from telegram.constants import ChatMemberStatus, ChatType, ParseMode
from telegram.error import Conflict, TelegramError
from telegram.ext import (Application, ApplicationBuilder, CallbackQueryHandler, ChatMemberHandler, CommandHandler,
                          ContextTypes, MessageHandler, filters)

from . import texts as T
from .service import EngineUnavailable, RateLimited, TelegramService

log = logging.getLogger("eo.telegram")

CONFLICT_WINDOW_S = 90.0   # PTB retries failed polls with back-off ≤ 30 s, so an ongoing conflict
                           # re-occurs well inside this window; none for 90 s ⇒ resolved
ERROR_WINDOW_S = 90.0

COMMANDS = [("start", "القائمة الرئيسية"), ("markets", "الأسواق المتاحة"), ("analyze", "تحليل سوق (مثل: /analyze btc)"),
            ("scan", "تشغيل AUTO SCANNER"), ("evidence", "أدلة آخر تحليل"), ("models", "حالة النماذج"),
            ("status", "حالة النظام"), ("history", "آخر التحليلات"), ("help", "المساعدة")]


class TokenRedactor(logging.Filter):
    def __init__(self, token: str):
        super().__init__()
        self.token = token

    def filter(self, record: logging.LogRecord) -> bool:
        if self.token:
            msg = record.getMessage()
            if self.token in msg:
                record.msg, record.args = msg.replace(self.token, "<TELEGRAM_TOKEN>"), ()
        return True


def install_redactor(token: str) -> None:
    f = TokenRedactor(token)
    for h in logging.getLogger().handlers:
        h.addFilter(f)
    for name in ("httpx", "telegram", "eo.telegram"):
        logging.getLogger(name).addFilter(f)


class EOTelegramBot:
    def __init__(self, core, token: str, allowed: set[int], base_url: str | None = None):
        self.core = core
        self.allowed = allowed
        self.service = TelegramService(core)
        install_redactor(token)
        self.username: str | None = None
        self.polling = False
        self.conflicts_total = 0
        self.last_conflict_at: float | None = None
        self._conflict_reported = False
        self.errors_total = 0
        self.last_error: str | None = None
        self.last_error_at: float | None = None
        self.ignored_non_private = 0
        self.groups_left = 0
        self.alerts_sent = 0
        self.alerts_dropped = 0
        self._alert_times: list[float] = []
        self._loop = None
        # real-traffic evidence (counts only — no user IDs, chat IDs or message text)
        self.updates_handled = 0
        self.replies_ok: dict[str, int] = {}     # handler name → handled and answered without error
        self.denied = 0
        self.last_update_at: float | None = None
        b = ApplicationBuilder().token(token).concurrent_updates(True)
        if base_url:
            b = b.base_url(base_url).base_file_url(base_url.replace("/bot", "/file/bot"))
        self.app: Application = b.build()
        a = self.app
        a.add_handler(CommandHandler("start", self.cmd_start))
        a.add_handler(CommandHandler("markets", self.cmd_markets))
        a.add_handler(CommandHandler("status", self.cmd_status))
        a.add_handler(CommandHandler("history", self.cmd_history))
        a.add_handler(CommandHandler("help", self.cmd_help))
        a.add_handler(CommandHandler("analyze", self.cmd_analyze))
        a.add_handler(CommandHandler("scan", self.cmd_scan))
        a.add_handler(CommandHandler("models", self.cmd_models))
        a.add_handler(CommandHandler("evidence", self.cmd_evidence))
        a.add_handler(CallbackQueryHandler(self.on_button))
        a.add_handler(ChatMemberHandler(self.on_my_member, ChatMemberHandler.MY_CHAT_MEMBER))
        a.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, self.on_text))
        a.add_error_handler(self.on_error)

    # ------------------------------------------------------------------ helpers
    @staticmethod
    def _is_private(update: Update) -> bool:
        c = update.effective_chat
        return bool(c and c.type == ChatType.PRIVATE)

    def _authorised(self, update: Update) -> bool:
        u = update.effective_user
        return bool(u and u.id in self.allowed)

    async def _deny(self, update: Update) -> None:
        uid = update.effective_user.id if update.effective_user else "?"
        log.warning("unauthorised telegram access attempt")
        text = (f"⛔ غير مصرّح لك باستخدام هذا البوت.\nمعرّفك في Telegram: <code>{uid}</code>\n"
                "أرسله لمالك البوت ليضيفه إلى EO_TELEGRAM_ALLOWED_USERS.")
        if update.callback_query:
            await update.callback_query.answer("غير مصرّح", show_alert=False)
        if update.effective_chat:
            await update.effective_chat.send_message(text, parse_mode=ParseMode.HTML)

    async def _send(self, update: Update, text: str, markup=None) -> None:
        q = update.callback_query
        if q is not None:
            try:
                await q.edit_message_text(text, parse_mode=ParseMode.HTML, reply_markup=markup)
                return
            except Exception:                         # message too old / identical: send a new one
                pass
        await update.effective_chat.send_message(text, parse_mode=ParseMode.HTML, reply_markup=markup)

    def guard(fn):  # noqa: N805 — decorator inside the class
        async def wrapper(self, update: Update, ctx: ContextTypes.DEFAULT_TYPE):
            if not self._is_private(update):
                # checked BEFORE authorisation: nothing (not even the refusal with a user ID) is
                # ever posted into a group or channel
                self.ignored_non_private += 1
                if update.callback_query:   # private toast to the presser only, stops the spinner
                    try:
                        await update.callback_query.answer(T.PRIVATE_ONLY)
                    except TelegramError:
                        pass
                return None
            self.updates_handled += 1
            self.last_update_at = time.time()
            if not self._authorised(update):
                await self._deny(update)
                self.denied += 1
                return None
            out = await fn(self, update, ctx)
            self.replies_ok[fn.__name__] = self.replies_ok.get(fn.__name__, 0) + 1
            return out
        return wrapper

    # ------------------------------------------------------------------ commands
    @property
    def image_mode(self) -> bool:
        return getattr(self.core.s, "signal_style", "full") == "image"

    @guard
    async def cmd_start(self, update, ctx):
        if self.image_mode:
            return await update.effective_chat.send_message(T.SIG_WELCOME, reply_markup=T.sig_markets_keyboard())
        await update.effective_chat.send_message(T.WELCOME, reply_markup=self._markets_markup(0, "all", menu=True))

    @guard
    async def cmd_markets(self, update, ctx):
        q = " ".join(ctx.args or []).strip()
        if q:
            return await self._search_results(update, q)
        await self._send_markets(update, 0)

    @guard
    async def cmd_analyze(self, update, ctx):
        q = " ".join(ctx.args or []).strip()
        if not q:
            return await self._send_markets(update, 0)
        ms = self.service.markets(query=q)
        exact = [m for m in ms if m["id"].lower() == q.lower().replace("/", "")]
        live = self.service.markets(query=q, available_only=True)
        pick = exact if len(exact) == 1 else ms if len(ms) == 1 else live if len(live) == 1 else None
        if pick:                                  # exact id, single match, or single AVAILABLE match
            return await self._analyze(update, pick[0]["id"])
        await self._search_results(update, q)

    @guard
    async def cmd_scan(self, update, ctx):
        await self._scan(update)

    @guard
    async def cmd_models(self, update, ctx):
        await self._send(update, T.models_text(self.service.models()), T.InlineKeyboardMarkup([T.back_row()]))

    @guard
    async def cmd_evidence(self, update, ctx):
        r = self.service.last_for(update.effective_user.id)
        if r is None:
            return await self._send(update, "لا يوجد تحليل سابق لك بعد. اختر سوقًا أولًا.", self._markets_markup(0, "all"))
        await self._send(update, T.details_text(r), T.after_result_keyboard(r["market"], r["decision"]))

    async def _send_markets(self, update, page: int):
        ms = self.service.markets(available_only=True)
        n_un = len(self.service.unavailable())
        await self._send(update, T.markets_text(ms, "all", n_un), T.markets_keyboard(ms, page, "all"))

    async def _scan(self, update, best_only: bool = False):
        if update.callback_query:
            await update.callback_query.answer("جارٍ الفحص…")
        try:
            rep = await self.service.scan(update.effective_user.id)
        except RateLimited as e:
            return await self._send(update, f"⏳ طلبات كثيرة. حاول بعد {e.args[0]} ثانية.",
                                    T.InlineKeyboardMarkup([T.back_row()]))
        except EngineUnavailable:
            return await self._send(update, "⚠️ تعذّر تشغيل الفحص الآن. لم يُصدر أي قرار.",
                                    T.InlineKeyboardMarkup([T.back_row()]))
        if best_only and rep.get("best"):
            b = rep["best"]
            return await self._send(update, T.result_text(b) if "evaluated" in b else T.details_text(b),
                                    T.after_result_keyboard(b["market"], b["decision"]))
        await self._send(update, T.scan_text(rep), T.scan_keyboard(rep))

    @guard
    async def cmd_status(self, update, ctx):
        await self._send(update, T.status_text(self.service.status()), T.InlineKeyboardMarkup([T.back_row()]))

    @guard
    async def cmd_history(self, update, ctx):
        await self._send(update, T.history_text(self.service.history(update.effective_user.id)),
                         T.InlineKeyboardMarkup([T.back_row()]))

    @guard
    async def cmd_help(self, update, ctx):
        await self._send(update, T.HELP, T.InlineKeyboardMarkup([T.back_row()]))

    def _markets_markup(self, page: int, kind: str, menu: bool = False):
        ms = self.service.markets(None if kind == "all" else kind, available_only=True)
        return T.markets_keyboard(ms, page, kind, menu=menu)

    async def _search_results(self, update, query: str):
        ms = self.service.markets(query=query)
        if not ms:
            return await self._send(update, f"لا يوجد سوق مدعوم يطابق «{T.esc(query)}».",
                                    T.InlineKeyboardMarkup([[T.InlineKeyboardButton("📈 كل الأسواق", callback_data="mk:0:all")],
                                                            T.back_row()]))
        await self._send(update, f"نتائج البحث عن «{T.esc(query)}»:", T.markets_keyboard(ms, 0, "all"))

    # ------------------------------------------------------------------ buttons & text
    @guard
    async def on_button(self, update, ctx):
        q = update.callback_query
        data = q.data or ""
        if data.startswith("sig:"):
            return await self._signal(update, data[4:])
        if data.startswith("sigx:"):                       # screenshot market without a real feed
            await q.answer()
            idx = int(data[5:]) if data[5:].isdigit() else 0
            return await self._send(update, T.sig_nodata_text(idx), T.sig_menu_keyboard())
        if data == "noop":
            return await q.answer()
        if data == "sigmenu":
            await q.answer()
            return await self._send(update, T.SIG_WELCOME, T.sig_markets_keyboard())
        if data.startswith("an:"):
            return await self._analyze(update, data[3:])
        if data.startswith("rf:"):
            return await self._analyze(update, data[3:], force=True)
        if data in ("scan", "best"):
            return await self._scan(update, best_only=(data == "best"))
        await q.answer()
        if data.startswith(("det:", "why:")):
            r = self.service.last_for(update.effective_user.id, data.split(":", 1)[1])
            if r is None:
                return await self._send(update, "انتهت صلاحية هذه النتيجة. حلّل السوق مجددًا.",
                                        T.InlineKeyboardMarkup([T.back_row()]))
            text = T.details_text(r) if data.startswith("det:") else T.wait_text(r)
            return await self._send(update, text, T.after_result_keyboard(r["market"], r["decision"]))
        if data == "unav":
            return await self._send(update, T.unavailable_text(self.service.unavailable()),
                                    T.InlineKeyboardMarkup([[T.btn("📈 الأسواق المتاحة", "mk:0:all")], T.back_row()]))
        if data == "models":
            return await self._send(update, T.models_text(self.service.models()), T.InlineKeyboardMarkup([T.back_row()]))
        if data == "menu":
            await self._send(update, T.WELCOME, self._markets_markup(0, "all", menu=True))
        elif data.startswith("mk:"):
            _, page, _kind = (data.split(":") + ["all"])[:3]
            await self._send_markets(update, int(page) if page.isdigit() else 0)
        elif data == "hist":
            await self._send(update, T.history_text(self.service.history(update.effective_user.id)),
                             T.InlineKeyboardMarkup([T.back_row()]))
        elif data == "status":
            await self._send(update, T.status_text(self.service.status()), T.InlineKeyboardMarkup([T.back_row()]))
        elif data == "help":
            await self._send(update, T.HELP, T.InlineKeyboardMarkup([T.back_row()]))
        elif data == "search":
            ctx.user_data["awaiting_search"] = True
            await self._send(update, "🔍 اكتب اسم السوق أو جزءًا منه (مثل: eur أو ذهب أو BTC):",
                             T.InlineKeyboardMarkup([T.back_row()]))

    @guard
    async def on_text(self, update, ctx):
        # any free text is treated as a market search (after the 🔍 button or directly)
        ctx.user_data.pop("awaiting_search", None)
        text = re.sub(r"[^\w/ \u0600-\u06FF]", "", (update.message.text or "").strip()[:40])
        if text:
            await self._search_results(update, text)

    async def _signal(self, update: Update, market_id: str):
        q = update.callback_query
        if q is not None:
            await q.answer("جارٍ التحليل…")
        try:
            r = await self.service.analyze(update.effective_user.id, market_id, force=True, mode="image")
        except KeyError:
            return await self._send(update, "❌ هذا السوق غير مدعوم.", T.sig_markets_keyboard())
        except RateLimited as e:
            return await self._send(update, f"⏳ طلبات كثيرة. حاول بعد {e.args[0]} ثانية.", T.sig_markets_keyboard())
        except EngineUnavailable:
            return await self._send(update, "⚠️ تعذّر الوصول إلى محرك التحليل الآن. حاول بعد قليل.", T.sig_markets_keyboard())
        await self._send(update, T.sig_result_text(r), T.sig_after_keyboard(market_id))

    async def _analyze(self, update: Update, market_id: str, force: bool = False):
        q = update.callback_query
        if q is not None:
            await q.answer("جارٍ التحديث…" if force else "جارٍ التحليل…")
        try:
            r = await self.service.analyze(update.effective_user.id, market_id, force=force)
        except KeyError:
            return await self._send(update, "❌ هذا السوق غير مدعوم أو غير مفعّل.", T.InlineKeyboardMarkup([T.back_row()]))
        except RateLimited as e:
            return await self._send(update, f"⏳ طلبات كثيرة. حاول بعد {e.args[0]} ثانية.",
                                    T.InlineKeyboardMarkup([T.back_row()]))
        except EngineUnavailable:
            return await self._send(update, "⚠️ تعذّر الوصول إلى محرك التحليل الآن. لم يُصدر أي قرار. حاول بعد قليل.",
                                    T.InlineKeyboardMarkup([T.back_row()]))
        await self._send(update, T.result_text(r), T.after_result_keyboard(market_id, r["decision"]))

    async def on_my_member(self, update: Update, ctx: ContextTypes.DEFAULT_TYPE):
        """Bot added to a group/supergroup/channel → leave it immediately (private chats only)."""
        cm = update.my_chat_member
        if cm is None or cm.chat.type == ChatType.PRIVATE:
            return
        if cm.new_chat_member.status in (ChatMemberStatus.MEMBER, ChatMemberStatus.ADMINISTRATOR,
                                         ChatMemberStatus.RESTRICTED):
            try:
                await ctx.bot.leave_chat(cm.chat.id)
                self.groups_left += 1
                # chat title/ID are not logged: they may identify people
                self.core.db.event("warning", "telegram", f"أُضيف البوت إلى محادثة من نوع {cm.chat.type} "
                                   "فغادرها تلقائيًا (يعمل في المحادثات الخاصة فقط)")
            except TelegramError as e:
                log.warning("leave_chat failed: %s", type(e).__name__)

    # ------------------------------------------------------------------ alerts → Telegram
    ALERT_LEVELS = ("critical", "alert")
    ALERTS_PER_HOUR = 20

    def push_alert(self, level: str, kind: str, message: str) -> None:
        """Alerter sink (may be called from any thread). Private chats of allowed users only,
        important levels only, at most ALERTS_PER_HOUR (on top of the Alerter's 5-min de-duplication)."""
        if level not in self.ALERT_LEVELS or not self.allowed or self._loop is None or self._loop.is_closed():
            return
        now = time.time()
        self._alert_times = [t for t in self._alert_times if now - t < 3600]
        if len(self._alert_times) >= self.ALERTS_PER_HOUR:
            self.alerts_dropped += 1
            return
        self._alert_times.append(now)
        icon = "🔴" if level == "critical" else "🔔"
        text = f"{icon} <b>تنبيه {T.esc(T.BOT_NAME)}</b>\n{T.esc(message)}"

        async def send():
            for uid in self.allowed:
                try:
                    await self.app.bot.send_message(uid, text, parse_mode=ParseMode.HTML)
                    self.alerts_sent += 1
                except TelegramError as e:
                    log.warning("alert delivery failed: %s", type(e).__name__)
        self._loop.call_soon_threadsafe(lambda: self._loop.create_task(send()))

    # ------------------------------------------------------------------ polling health
    def on_poll_error(self, exc: TelegramError) -> None:
        """PTB polling error callback (sync, runs on the bot's event loop). Never re-raises."""
        now = time.time()
        if isinstance(exc, Conflict):
            self.conflicts_total += 1
            self.last_conflict_at = now
            log.warning("telegram polling conflict (409): another instance is using the same token")
            if not self._conflict_reported:
                self._conflict_reported = True
                self.core.alert("critical", "telegram",
                                "تعارض Telegram 409: نسخة أخرى من البوت تعمل بالرمز نفسه. Telegram يوزّع الرسائل بين "
                                "النسختين فتصبح الردود غير منتظمة. أوقف النسخة الأخرى (جهاز آخر أو نافذة أخرى أو Docker).")
            return
        self.errors_total += 1
        self.last_error = type(exc).__name__          # type only: messages may echo request URLs
        self.last_error_at = now
        log.warning("telegram polling error: %s", self.last_error)

    def conflict_active(self, now: float | None = None) -> bool:
        return bool(self.last_conflict_at and (now or time.time()) - self.last_conflict_at < CONFLICT_WINDOW_S)

    def tick(self) -> None:
        """Called periodically by the platform service: emits the 'conflict resolved' event."""
        if self._conflict_reported and not self.conflict_active():
            self._conflict_reported = False
            self.core.db.event("info", "telegram", "انتهى تعارض Telegram 409: هذه النسخة وحدها تستقبل الرسائل الآن")

    def state(self) -> dict:
        """Safe to expose to the dashboard: never contains the token, chat IDs or user IDs."""
        now = time.time()
        return {"enabled": True, "polling": self.polling, "username": self.username, "expected_username": T.BOT_NAME,
                "username_match": (self.username or "").lower() == T.BOT_NAME.lower() if self.username else None,
                "private_only": True, "conflict": self.conflict_active(now), "conflicts_total": self.conflicts_total,
                "last_conflict_at": self.last_conflict_at, "errors_total": self.errors_total,
                "last_error": self.last_error, "last_error_at": self.last_error_at,
                "error_active": bool(self.last_error_at and now - self.last_error_at < ERROR_WINDOW_S),
                "ignored_non_private": self.ignored_non_private, "groups_left": self.groups_left,
                "alerts_sent": self.alerts_sent, "alerts_dropped_rate_limit": self.alerts_dropped,
                "updates_handled": self.updates_handled, "replies_ok": dict(self.replies_ok), "denied": self.denied,
                "last_update_at": self.last_update_at}

    async def on_error(self, update, ctx: ContextTypes.DEFAULT_TYPE):
        log.error("telegram handler error: %s", type(ctx.error).__name__)

    # ------------------------------------------------------------------ lifecycle
    async def start(self) -> None:
        await self.app.initialize()
        await self.app.bot.set_my_commands([BotCommand(c, d) for c, d in COMMANDS])
        await self.app.start()
        await self.app.updater.start_polling(drop_pending_updates=True, error_callback=self.on_poll_error,
                                             allowed_updates=["message", "callback_query", "my_chat_member"])
        self.polling = True
        import asyncio
        self._loop = asyncio.get_running_loop()
        if getattr(self.core.s, "telegram_alerts", True) and self.push_alert not in self.core.alert.sinks:
            self.core.alert.sinks.append(self.push_alert)
        me = self.username = self.app.bot.username
        self.core.db.event("info", "telegram", f"بوت Telegram متصل باسم @{me} (استطلاع طويل، محادثات خاصة فقط، "
                                               "لا يُكشف أي منفذ)")
        if (me or "").lower() != T.BOT_NAME.lower():
            self.core.db.event("warning", "telegram", f"الرمز في EO_TELEGRAM_TOKEN يخص @{me} وليس @{T.BOT_NAME}. "
                                                      "تأكد أنك نسخت رمز البوت الصحيح من BotFather.")

    async def stop(self) -> None:
        self.polling = False
        if self.push_alert in getattr(self.core.alert, "sinks", []):
            self.core.alert.sinks.remove(self.push_alert)
        try:
            if self.app.updater and self.app.updater.running:
                await self.app.updater.stop()
            if self.app.running:
                await self.app.stop()
            await self.app.shutdown()
        except Exception:
            log.exception("telegram shutdown")
