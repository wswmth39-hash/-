"""Arabic Telegram bot — async handlers on top of the existing platform Core.

* Long polling only: nothing is exposed publicly (no webhook, no internal API).
* Authorization: only Telegram user IDs listed in EO_TELEGRAM_ALLOWED_USERS may use it.
  With an empty list nobody is authorised (secure default); an unauthorised user is told
  their own numeric ID so the owner can add it, and nothing else is revealed.
* The bot token is read from EO_TELEGRAM_TOKEN and redacted from every log record.
"""
from __future__ import annotations

import logging
import re

from telegram import BotCommand, Update
from telegram.constants import ParseMode
from telegram.ext import (Application, ApplicationBuilder, CallbackQueryHandler, CommandHandler, ContextTypes,
                          MessageHandler, filters)

from . import texts as T
from .service import EngineUnavailable, RateLimited, TelegramService

log = logging.getLogger("eo.telegram")

COMMANDS = [("start", "القائمة الرئيسية"), ("markets", "عرض الأسواق"), ("status", "حالة النظام"),
            ("history", "آخر التحليلات"), ("help", "المساعدة")]


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
        a.add_handler(CallbackQueryHandler(self.on_button))
        a.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, self.on_text))
        a.add_error_handler(self.on_error)

    # ------------------------------------------------------------------ helpers
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
            if not self._authorised(update):
                return await self._deny(update)
            return await fn(self, update, ctx)
        return wrapper

    # ------------------------------------------------------------------ commands
    @guard
    async def cmd_start(self, update, ctx):
        await update.effective_chat.send_message(T.WELCOME, reply_markup=self._markets_markup(0, "all", menu=True))

    @guard
    async def cmd_markets(self, update, ctx):
        q = " ".join(ctx.args or []).strip()
        if q:
            return await self._search_results(update, q)
        ms = self.service.markets()
        await update.effective_chat.send_message(T.markets_text(ms, "all"), parse_mode=ParseMode.HTML,
                                                 reply_markup=T.markets_keyboard(ms, 0, "all"))

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
        ms = self.service.markets(None if kind == "all" else kind)
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
        if data.startswith("an:"):
            return await self._analyze(update, data[3:])
        await q.answer()
        if data == "menu":
            await self._send(update, T.WELCOME, self._markets_markup(0, "all", menu=True))
        elif data.startswith("mk:"):
            _, page, kind = (data.split(":") + ["all"])[:3]
            kind = kind if kind in ("all", "regular", "otc") else "all"
            ms = self.service.markets(None if kind == "all" else kind)
            await self._send(update, T.markets_text(ms, kind), T.markets_keyboard(ms, int(page) if page.isdigit() else 0, kind))
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

    async def _analyze(self, update: Update, market_id: str):
        q = update.callback_query
        await q.answer("جارٍ التحليل…")
        try:
            r = await self.service.analyze(update.effective_user.id, market_id)
        except KeyError:
            return await self._send(update, "❌ هذا السوق غير مدعوم أو غير مفعّل.", T.InlineKeyboardMarkup([T.back_row()]))
        except RateLimited as e:
            return await self._send(update, f"⏳ طلبات كثيرة. حاول بعد {e.args[0]} ثانية.",
                                    T.InlineKeyboardMarkup([T.back_row()]))
        except EngineUnavailable:
            return await self._send(update, "⚠️ تعذّر الوصول إلى محرك التحليل الآن. لم يُصدر أي قرار. حاول بعد قليل.",
                                    T.InlineKeyboardMarkup([T.back_row()]))
        await self._send(update, T.result_text(r), T.after_result_keyboard(market_id))

    async def on_error(self, update, ctx: ContextTypes.DEFAULT_TYPE):
        log.error("telegram handler error: %s", type(ctx.error).__name__)

    # ------------------------------------------------------------------ lifecycle
    async def start(self) -> None:
        await self.app.initialize()
        await self.app.bot.set_my_commands([BotCommand(c, d) for c, d in COMMANDS])
        await self.app.start()
        await self.app.updater.start_polling(drop_pending_updates=True, allowed_updates=["message", "callback_query"])
        me = self.app.bot.username
        self.core.db.event("info", "telegram", f"بوت Telegram متصل باسم @{me} (استطلاع طويل، لا يُكشف أي منفذ)")

    async def stop(self) -> None:
        try:
            if self.app.updater and self.app.updater.running:
                await self.app.updater.stop()
            if self.app.running:
                await self.app.stop()
            await self.app.shutdown()
        except Exception:
            log.exception("telegram shutdown")
