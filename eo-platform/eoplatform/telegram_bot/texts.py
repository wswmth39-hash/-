"""Arabic texts and inline keyboards for the Telegram bot (pure functions — easy to test)."""
from __future__ import annotations

import html
import time

from telegram import InlineKeyboardButton, InlineKeyboardMarkup

PAGE = 8
DUR_AR = {30: "30 ثانية", 60: "دقيقة واحدة", 120: "دقيقتان", 300: "5 دقائق"}
DEC_AR = {"BUY": "🟢 شراء (BUY)", "SELL": "🔴 بيع (SELL)", "WAIT": "⏸ انتظار (WAIT)"}
STATE_AR = {"LIVE": "🟢 حية", "DELAYED": "🟡 متأخرة", "STALE": "🟠 قديمة", "OFFLINE": "⚪ غير متاحة"}
SRC_AR = {"binance": "Binance — بيانات مرجعية (ليست أسعار ExpertOption ولا OTC)",
          "expertoption": "ExpertOption (عبر الجسر)", "import": "بيانات مستوردة"}
DISCLAIMER = "⚠️ تحليل فقط — لا تُنفَّذ أي صفقة حقيقية، ولا يوجد ضمان لأي ربح."

WELCOME = "مرحباً بك في ExpertOption AI\nاختر السوق الذي تريد تحليله:"
HELP = ("<b>المساعدة</b>\n"
        "• اضغط على أي سوق ليُحلَّل فورًا بمحرك المنصة نفسه، ويختار المحرك المدة المدعومة تجريبيًا.\n"
        "• القرار قد يكون <b>انتظار</b>: هذا قرار صحيح عندما لا توجد أفضلية مثبتة إحصائيًا.\n"
        "• لا تُعرض ثقة إلا من نموذج مُتحقق منه، ولا احتمال إلا إذا كان مُعايرًا.\n\n"
        "<b>الأوامر</b>\n/start القائمة الرئيسية\n/markets عرض الأسواق (أو /markets eur للبحث)\n"
        "/status حالة النظام\n/history آخر تحليلاتك\n/help المساعدة\n\n" + DISCLAIMER)


def esc(x) -> str:
    return html.escape(str(x if x is not None else "—"))


def fmt_price(p) -> str:
    if p is None:
        return "غير متاح"
    return f"{p:,.6g}" if p < 10 else f"{p:,.2f}"


def fmt_time(ts) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(ts))


def main_menu() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("📈 عرض الأسواق", callback_data="mk:0:all")],
        [InlineKeyboardButton("🕘 آخر التحليلات", callback_data="hist"),
         InlineKeyboardButton("🩺 حالة النظام", callback_data="status")],
        [InlineKeyboardButton("🔍 بحث عن سوق", callback_data="search"),
         InlineKeyboardButton("❓ المساعدة", callback_data="help")]])


def back_row() -> list:
    return [InlineKeyboardButton("🏠 العودة للقائمة الرئيسية", callback_data="menu")]


def markets_keyboard(markets: list[dict], page: int, kind: str, menu: bool = False) -> InlineKeyboardMarkup:
    pages = max(1, (len(markets) + PAGE - 1) // PAGE)
    page = max(0, min(page, pages - 1))
    rows = []
    chunk = markets[page * PAGE:(page + 1) * PAGE]
    for i in range(0, len(chunk), 2):
        rows.append([InlineKeyboardButton(
            f"{'🟢' if m['state'] == 'LIVE' else '⚪'} {m['name']}" + (" OTC" if m["kind"] == "otc" and "OTC" not in m["name"] else ""),
            callback_data=f"an:{m['id']}") for m in chunk[i:i + 2]])
    nav = []
    if page > 0:
        nav.append(InlineKeyboardButton("◀ السابق", callback_data=f"mk:{page - 1}:{kind}"))
    nav.append(InlineKeyboardButton(f"{page + 1}/{pages}", callback_data="noop"))
    if page < pages - 1:
        nav.append(InlineKeyboardButton("التالي ▶", callback_data=f"mk:{page + 1}:{kind}"))
    rows.append(nav)
    rows.append([InlineKeyboardButton(("✓ " if kind == k else "") + label, callback_data=f"mk:0:{k}")
                 for k, label in (("all", "الكل"), ("regular", "العادي"), ("otc", "OTC"))])
    if menu:   # main menu = markets + shortcuts
        rows.append([InlineKeyboardButton("🔍 بحث عن سوق", callback_data="search"),
                     InlineKeyboardButton("🕘 آخر التحليلات", callback_data="hist")])
        rows.append([InlineKeyboardButton("🩺 حالة النظام", callback_data="status"),
                     InlineKeyboardButton("❓ المساعدة", callback_data="help")])
    else:
        rows.append([InlineKeyboardButton("🔍 بحث", callback_data="search")] + back_row())
    return InlineKeyboardMarkup(rows)


def markets_text(markets: list[dict], kind: str) -> str:
    live = sum(1 for m in markets if m["state"] == "LIVE")
    return (f"<b>اختر السوق</b> ({len(markets)} سوقًا"
            + {"all": "", "regular": " عاديًا", "otc": " OTC"}[kind] + f"، منها {live} ببيانات حية 🟢)\n"
            "⚪ = لا توجد بيانات حقيقية حاليًا لهذا السوق (سيظهر ذلك في النتيجة).")


def after_result_keyboard(market_id: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("🔁 تحليل سوق آخر", callback_data="mk:0:all"),
         InlineKeyboardButton("🕘 آخر التحليلات", callback_data="hist")],
        [InlineKeyboardButton("🩺 حالة النظام", callback_data="status")], back_row()])


def result_text(r: dict) -> str:
    name = f"{r['market_name']}" + (f" ({r['market_name_ar']})" if r.get("market_name_ar") else "")
    lines = [f"📊 <b>السوق:</b> {esc(name)} — {'OTC' if r['kind'] == 'otc' else 'عادي'}",
             f"<b>القرار:</b> {DEC_AR[r['decision']]}"]
    if r["decision"] == "WAIT":
        lines.append("<b>المدة المقترحة:</b> لا توجد — لا مدة مدعومة تجريبيًا بنموذج مُتحقق منه الآن")
    else:
        lines.append(f"<b>المدة المقترحة:</b> {DUR_AR[r['horizon']]} (أعلى عائد متوقع متحفظ بين المدد المُتحقق منها)")
    if r.get("price") is not None and r.get("data_source"):
        lines.append(f"<b>السعر المرجعي:</b> {fmt_price(r['price'])}")
    else:
        lines.append("<b>السعر المرجعي:</b> غير متاح — لا توجد بيانات حقيقية لهذا السوق")
    state = STATE_AR.get(r.get("data_state"), "—")
    age = f" (آخر تحديث قبل {r['data_age']} ث)" if r.get("data_age") is not None else ""
    lines.append(f"<b>حالة السوق:</b> {esc(r.get('regime_ar') or '—')} · البيانات {state}{age}")
    c = r.get("confidence")
    if c and r["decision"] != "WAIT":
        conf = (f"دقة مُتحققة {c['oos_accuracy'] * 100:.1f}% على {c['oos_trades']} صفقة مستقلة خارج العينة "
                f"(حد أدنى 95%: {c['wilson_lb'] * 100:.1f}%)")
        if c.get("probability") is not None:
            conf += f" · احتمال مُعاير {c['probability'] * 100:.1f}%"
        lines.append(f"<b>الثقة:</b> {esc(conf)}")
    else:
        lines.append("<b>الثقة:</b> لا تُعرض — لا يوجد نموذج مُتحقق منه ومُعاير لهذا القرار")
    reason = (r.get("abstain") or {}).get("text") or (r["reasons"][0] if r.get("reasons") else "—")
    lines.append(f"<b>سبب القرار:</b> {esc(reason)}")
    if r.get("evidence_for"):
        lines.append("✅ <b>أدلة مؤيدة:</b> " + esc("؛ ".join(f"{e['agent']}: {e['facts'][0]}" for e in r["evidence_for"][:2] if e.get("facts"))))
    if r.get("evidence_against"):
        lines.append("⚠️ <b>أدلة معارضة:</b> " + esc("؛ ".join(f"{e['agent']}: {e['facts'][0]}" for e in r["evidence_against"][:2] if e.get("facts"))))
    lines.append("<b>المدد التي فُحصت:</b> " + "، ".join(
        f"{DUR_AR[e['duration']]}: {'شراء' if e['decision'] == 'BUY' else 'بيع' if e['decision'] == 'SELL' else 'انتظار'}"
        for e in r.get("evaluated", [])))
    lines.append(f"<b>مصدر البيانات:</b> {esc(SRC_AR.get(r.get('data_source'), 'لا يوجد مصدر بيانات حقيقي متاح'))}")
    lines.append(f"<b>وقت التحليل:</b> {fmt_time(r['timestamp'])}")
    if r.get("duplicate"):
        lines.append("ℹ️ نتيجة التحليل الأخير نفسه (طلب مكرر خلال ثوانٍ).")
    lines.append(DISCLAIMER)
    return "\n".join(lines)


def history_text(rows: list[dict]) -> str:
    if not rows:
        return "لا توجد تحليلات سابقة لك بعد."
    out = ["<b>آخر تحليلاتك</b>"]
    res = {"win": "✅ صحيح", "loss": "❌ خاطئ", "draw": "➖ تعادل", "void": "⚪ ملغى", "pending": "⏳ بانتظار النتيجة"}
    for r in rows:
        dec = DEC_AR.get(r["decision"], r["decision"])
        out.append(f"• {fmt_time(r['created_at'])[5:16]} — {esc(r['market'])}: {dec}"
                   + (f" · {DUR_AR[r['horizon']]}" if r.get("horizon") else "")
                   + (f" · {res.get(r['outcome'], '')}" if r.get("outcome") else ""))
    return "\n".join(out)


def status_text(s: dict) -> str:
    out = ["<b>حالة النظام</b>", f"الخدمات: {'🟢 تعمل' if s['status'] == 'ok' else '🟡 بعضها يعيد التشغيل'}"]
    for k, v in (s.get("providers") or {}).items():
        out.append(f"• {esc(SRC_AR.get(k, k).split(' — ')[0])}: {'🟢 متصل (بيانات حديثة مُثبتة)' if v.get('proven') else '⚪ غير متصل'}")
    out.append(f"• جسر ExpertOption: {'مفعّل' if s.get('bridge_enabled') else 'معطّل (لا بيانات ExpertOption ولا OTC)'}")
    out.append(f"• النموذج المحلي: {'🟢 ' + esc(s['llm'].get('model')) if s['llm'].get('ok') else '⚪ غير متاح'}")
    out.append(f"• أسواق ببيانات حية: {esc('، '.join(s['live_markets']) or 'لا يوجد')}")
    out.append(f"• نماذج مُفعّلة (مُتحقق منها): {len(s['champions'])}"
               + (" — لذلك القرارات «انتظار» حاليًا" if not s["champions"] else ""))
    for f in s.get("forward_tests") or []:
        out.append(f"• اختبار مستقبلي {esc(f['market'])} {DUR_AR.get(f['duration'], f['duration'])} ({esc(f['spec'])}): "
                   f"{esc(f['status'])} {f['n']}/{f['target_n']}")
    return "\n".join(out)
