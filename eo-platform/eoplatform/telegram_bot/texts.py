"""Arabic texts and inline keyboards for the Telegram bot (pure functions — easy to test).

V4: available markets only by default (unavailable ones listed separately with the reason),
a structured analysis card (market, decision, duration, calibrated confidence, model state,
data source and age, reason), plus detail / WAIT-reason / scan / models views."""
from __future__ import annotations

import html
import time

from telegram import InlineKeyboardButton, InlineKeyboardMarkup

PAGE = 8
DUR_AR = {30: "30 ثانية", 60: "60 ثانية", 120: "120 ثانية", 300: "300 ثانية"}
DEC_AR = {"BUY": "🟢 شراء (BUY)", "SELL": "🔴 بيع (SELL)", "WAIT": "⏸ انتظار (WAIT)"}
STATE_AR = {"LIVE": "🟢 حية", "DELAYED": "🟡 متأخرة", "STALE": "🟠 قديمة", "OFFLINE": "⚪ غير متاحة",
            "LOADING": "⏳ قيد التحميل"}
STATE_ICON = {"LIVE": "🟢", "LOADING": "⏳"}
SRC_AR = {"binance": "Binance — بيانات مرجعية (ليست أسعار ExpertOption ولا OTC)",
          "expertoption": "ExpertOption (عبر الجسر)", "import": "بيانات مستوردة"}
MODEL_STATE_AR = {"validated": "✅ معتمد (اجتاز التحقق الإحصائي)", "not_validated": "❌ غير معتمد",
                  "none": "❌ غير معتمد — لا يوجد نموذج اجتاز التحقق"}
GATE_ICON = {True: "✅", False: "❌", None: "⬜"}
BOT_NAME = "EO_PredictorBot"
# "EO" in the name must never read as official: every entry point says so explicitly.
NOT_AFFILIATED = (f"ℹ️ {BOT_NAME} أداة تحليل مستقلة، <b>غير تابعة لشركة ExpertOption</b> "
                  "ولا مرتبطة بها ولا معتمدة منها.")
DISCLAIMER = ("⚠️ تحليل فقط — لا تُنفَّذ أي صفقة حقيقية، ولا يوجد ضمان لأي ربح.\n"
              f"ℹ️ {BOT_NAME} غير تابع لشركة ExpertOption.")

WELCOME = (f"مرحباً بك في {BOT_NAME}\n{NOT_AFFILIATED}\n"
           "الأسواق المعروضة هي المتاحة الآن ببيانات حقيقية فقط.\nاختر السوق الذي تريد تحليله:")
LOADING_NOTE = ("⏳ المنصة بدأت التشغيل قبل {age} ث، وبيانات السوق ما زالت قيد التحميل "
                "(تنزيل السجل والاتصال بالمصدر يستغرقان نحو دقيقة). أعد المحاولة بعد قليل.")
PRIVATE_ONLY = f"🔒 {BOT_NAME} يعمل في المحادثات الخاصة فقط."
HELP = (f"<b>المساعدة — {BOT_NAME}</b>\n"
        "• اختر سوقًا ليُحلَّل فورًا في المدد الأربع (30/60/120/300 ثانية) كلٌّ على حدة.\n"
        "• القرار <b>BUY</b> أو <b>SELL</b> لا يظهر إلا إذا اجتاز التحليل كل الشروط: نموذج متحقق منه إحصائيًا، "
        "بيانات حية سليمة، عتبة متحقق منها، وعائد متوقع متحفظ موجب بعد نسبة العائد.\n"
        "• غير ذلك فالقرار <b>WAIT</b> مع سببه — وهذا قرار صحيح عند غياب أفضلية مثبتة.\n"
        "• لا يُعرض احتمال إلا إذا كان معايرًا ومثبتًا، وتوافق المحللين ليس إثباتًا.\n\n"
        "<b>الأوامر</b>\n/start القائمة الرئيسية\n/markets الأسواق المتاحة (و/markets eur للبحث)\n"
        "/analyze تحليل سوق (مثل: /analyze btc)\n/scan تشغيل AUTO SCANNER على كل الأسواق المتاحة\n"
        "/evidence أدلة وتفاصيل آخر تحليل\n/models حالة النماذج والاختبارات\n"
        "/status حالة النظام\n/history آخر تحليلاتك\n/help المساعدة\n\n"
        "• يعمل البوت في المحادثات الخاصة فقط، ويغادر أي مجموعة يُضاف إليها.\n\n"
        + NOT_AFFILIATED + "\n" + DISCLAIMER)


def esc(x) -> str:
    return html.escape(str(x if x is not None else "—"))


def fmt_price(p) -> str:
    if p is None:
        return "غير متاح"
    return f"{p:,.6g}" if p < 10 else f"{p:,.2f}"


def fmt_time(ts) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(ts))


def pct(x) -> str:
    return "—" if x is None else f"{x * 100:.1f}%"


def btn(text: str, data: str) -> InlineKeyboardButton:
    return InlineKeyboardButton(text, callback_data=data)


def back_row() -> list:
    return [btn("🏠 العودة للقائمة الرئيسية", "menu")]


def main_menu() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(menu_rows())


def menu_rows() -> list:
    return [[btn("🛰 تشغيل AUTO SCANNER", "scan"), btn("🏆 أفضل نتيجة مؤهلة", "best")],
            [btn("📈 تحليل سوق محدد", "mk:0:all"), btn("⚪ الأسواق غير المتاحة", "unav")],
            [btn("🧠 النماذج", "models"), btn("🩺 حالة النظام", "status")],
            [btn("🔍 بحث عن سوق", "search"), btn("🕘 آخر التحليلات", "hist")],
            [btn("❓ المساعدة", "help")]]


def markets_keyboard(markets: list[dict], page: int, kind: str, menu: bool = False) -> InlineKeyboardMarkup:
    pages = max(1, (len(markets) + PAGE - 1) // PAGE)
    page = max(0, min(page, pages - 1))
    rows = []
    chunk = markets[page * PAGE:(page + 1) * PAGE]
    for i in range(0, len(chunk), 2):
        rows.append([btn(f"{STATE_ICON.get(m['state'], '⚪')} {m['name']}"
                         + (" OTC" if m["kind"] == "otc" and "OTC" not in m["name"] else ""), f"an:{m['id']}")
                     for m in chunk[i:i + 2]])
    if pages > 1:
        nav = []
        if page > 0:
            nav.append(btn("◀ السابق", f"mk:{page - 1}:{kind}"))
        nav.append(btn(f"{page + 1}/{pages}", "noop"))
        if page < pages - 1:
            nav.append(btn("التالي ▶", f"mk:{page + 1}:{kind}"))
        rows.append(nav)
    if menu:
        rows += menu_rows()
    else:
        rows.append([btn("⚪ الأسواق غير المتاحة", "unav"), btn("🔍 بحث", "search")])
        rows.append(back_row())
    return InlineKeyboardMarkup(rows)


def markets_text(markets: list[dict], kind: str = "all", unavailable_n: int | None = None) -> str:
    live = sum(1 for m in markets if m["state"] == "LIVE")
    loading = sum(1 for m in markets if m["state"] == "LOADING")
    out = [f"<b>الأسواق المتاحة للتحليل</b> ({live} ببيانات حية 🟢)"]
    if loading:
        out.append(f"⏳ {loading} سوقًا بياناتها قيد التحميل بعد بدء التشغيل (نحو دقيقة).")
    if not markets:
        out.append("لا يوجد سوق متاح الآن ببيانات حقيقية حية.")
    if unavailable_n:
        out.append(f"⚪ {unavailable_n} سوقًا غير متاحة الآن — اضغط «الأسواق غير المتاحة» لمعرفة السبب.")
    return "\n".join(out)


def unavailable_text(rows: list[dict]) -> str:
    if not rows:
        return "كل الأسواق المفعّلة متاحة الآن."
    groups: dict[str, list] = {}
    for r in rows:
        groups.setdefault(r["reason_ar"], []).append(r)
    out = [f"<b>الأسواق غير المتاحة الآن ({len(rows)})</b>", "لا تُعرض لها أي أسعار ولا يُخترع لها أي سعر."]
    for reason, rs in groups.items():
        names = "، ".join(esc(r["name"]) for r in rs[:20]) + ("…" if len(rs) > 20 else "")
        out.append(f"\n<b>السبب:</b> {esc(reason)}\n{names}")
    return "\n".join(out)


def after_result_keyboard(market_id: str, decision: str = "WAIT") -> InlineKeyboardMarkup:
    rows = [[btn("📋 تفاصيل التحليل", f"det:{market_id}")]
            + ([btn("⏸ أسباب WAIT", f"why:{market_id}")] if decision == "WAIT" else []),
            [btn("🔄 تحديث البيانات", f"rf:{market_id}"), btn("🔁 تحليل سوق آخر", "mk:0:all")],
            [btn("🛰 AUTO SCANNER", "scan"), btn("🕘 آخر التحليلات", "hist")], back_row()]
    return InlineKeyboardMarkup(rows)


def _confidence_line(r: dict) -> str:
    c = r.get("confidence")
    if c and r["decision"] != "WAIT":
        s = (f"دقة مُتحققة {c['oos_accuracy'] * 100:.1f}% على {c['oos_trades']} صفقة مستقلة خارج العينة "
             f"(حد أدنى 95%: {c['wilson_lb'] * 100:.1f}%)")
        if c.get("probability") is not None:
            s += f" · احتمال مُعاير {c['probability'] * 100:.1f}%"
        else:
            s += " · الاحتمال المعاير: لا يتوفر"
        return f"<b>الثقة المعايرة:</b> {esc(s)}"
    return "<b>الثقة المعايرة:</b> لا تتوفر — لا يوجد نموذج مُتحقق منه ومُعاير لهذا القرار"


def result_text(r: dict) -> str:
    name = f"{r['market_name']}" + (f" ({r['market_name_ar']})" if r.get("market_name_ar") else "")
    lines = [f"📊 <b>السوق:</b> {esc(r['market'])} — {esc(name)} — {'OTC' if r['kind'] == 'otc' else 'عادي'}",
             f"<b>القرار:</b> {DEC_AR[r['decision']]}"]
    if r["decision"] == "WAIT":
        lines.append("<b>المدة:</b> لا توجد — لا مدة مدعومة بنموذج مُتحقق منه الآن")
    else:
        lines.append(f"<b>المدة:</b> {DUR_AR[r['horizon']]} (أعلى عائد متوقع متحفظ بين المدد التي اجتازت كل الشروط)")
    lines.append(_confidence_line(r))
    lines.append(f"<b>حالة النموذج:</b> {MODEL_STATE_AR.get(r.get('model_state'), '❌ غير معتمد')}")
    no_src = "قيد التحميل" if r.get("data_loading") else "لا يوجد مصدر بيانات حقيقي متاح"
    lines.append(f"<b>مصدر البيانات:</b> {esc(SRC_AR.get(r.get('data_source'), no_src))}")
    state = STATE_AR["LOADING"] if r.get("data_loading") else STATE_AR.get(r.get("data_state"), "—")
    age = f"{r['data_age']} ث" if r.get("data_age") is not None else "—"
    last_bar = f" · آخر شمعة {r['last_bar_utc']}" if r.get("last_bar_utc") else ""
    lines.append(f"<b>عمر البيانات:</b> {age} ({state}){esc(last_bar)}")
    if r.get("price") is not None and r.get("data_source"):
        lines.append(f"<b>السعر المرجعي:</b> {fmt_price(r['price'])}")
    elif r.get("data_loading"):
        lines.append("<b>السعر المرجعي:</b> ⏳ قيد التحميل — لم تصل بيانات حقيقية حديثة بعد")
    else:
        lines.append("<b>السعر المرجعي:</b> غير متاح — لا توجد بيانات حقيقية لهذا السوق")
    lines.append(f"<b>حالة السوق:</b> {esc(r.get('regime_ar') or '—')}")
    reason = r.get("reason") or (r.get("abstain") or {}).get("text") or (r["reasons"][0] if r.get("reasons") else "—")
    if r.get("data_loading"):   # the engine only sees "no data"; during startup the true cause is loading
        reason = "بيانات السوق قيد التحميل بعد بدء التشغيل — لا قرار قبل وصول بيانات حقيقية حديثة"
    lines.append(f"<b>السبب:</b> {esc(reason)}")
    if r.get("data_loading"):
        lines.append(LOADING_NOTE.format(age=int(r.get("uptime_s") or 0)))
    if r.get("evidence_for"):
        lines.append("✅ <b>أدلة مؤيدة:</b> " + esc("؛ ".join(f"{e['agent']}: {e['facts'][0]}"
                                                         for e in r["evidence_for"][:2] if e.get("facts"))))
    if r.get("evidence_against"):
        lines.append("⚠️ <b>أدلة معارضة:</b> " + esc("؛ ".join(f"{e['agent']}: {e['facts'][0]}"
                                                           for e in r["evidence_against"][:2] if e.get("facts"))))
    lines.append("<b>المدد التي فُحصت:</b> " + "، ".join(
        f"{DUR_AR[e['duration']]}: {'شراء' if e['decision'] == 'BUY' else 'بيع' if e['decision'] == 'SELL' else 'انتظار'}"
        for e in r.get("evaluated", [])))
    lines.append(f"<b>وقت التحليل:</b> {fmt_time(r['timestamp'])}")
    if r.get("duplicate"):
        lines.append("ℹ️ نتيجة التحليل الأخير نفسه (طلب مكرر خلال ثوانٍ).")
    lines.append(DISCLAIMER)
    return "\n".join(lines)


def gates_lines(gates: list[dict]) -> list[str]:
    return [f"{GATE_ICON[g['ok']]} {esc(g['name_ar'])}" for g in gates]


def details_text(r: dict) -> str:
    """Full evidence: per-duration results, the eight analysts, every gate."""
    out = [f"📋 <b>تفاصيل التحليل — {esc(r['market'])}</b> ({fmt_time(r['timestamp'])})",
           f"القرار: {DEC_AR[r['decision']]}", "", "<b>نتيجة كل مدة (تحليل مستقل):</b>"]
    for h in r.get("horizons") or []:
        cand = h.get("candidate_unvalidated")
        out.append(f"• {DUR_AR.get(h['duration'], h['duration'])}: {DEC_AR[h['decision']].split(' ')[1]}"
                   + (f" — اتجاه مرشح غير مثبت: {esc(cand)}" if h["decision"] == "WAIT" and cand else "")
                   + f" — {esc(h['choice'])}")
    p = r.get("panel") or {}
    if p.get("analysts"):
        out += ["", f"<b>المحللون الثمانية</b> (آراء مستقلة فعليًا ≈ {p.get('effective_independent_opinions')}):"]
        stance_ar = {"BUY": "صعود", "SELL": "هبوط", "neutral": "محايد", "allow": "يسمح", "block": "يمنع",
                     "abstain": "يمتنع", "agree": "يؤيد", "weak": "ضعيف"}
        for a in p["analysts"].values():
            infl = f" · التأثير {a['influence']:+.2f}" if a.get("weight") else ""
            fact = a["facts"][0] if a.get("facts") else ""
            out.append(f"• {esc(a['name_ar'])}: {stance_ar.get(a['stance'], esc(a['stance']))}{infl} — {esc(fact)}")
        out.append(f"<i>{esc(p.get('note'))}</i>")
    if r.get("gates"):
        out += ["", "<b>شروط التحقق</b> (✅ اجتاز · ❌ فشل · ⬜ لم يُفحص):"] + gates_lines(r["gates"])
    return "\n".join(out)


def wait_text(r: dict) -> str:
    if r["decision"] != "WAIT":
        return "القرار الحالي ليس WAIT."
    out = [f"⏸ <b>لماذا WAIT؟ — {esc(r['market'])}</b>", esc(r.get("reason") or "—"), ""]
    for h in r.get("horizons") or []:
        out.append(f"• {DUR_AR.get(h['duration'], h['duration'])}: {esc(h['reason_ar'])}")
    failed = [g for g in (r.get("gates") or []) if g["ok"] is False]
    if failed:
        out += ["", "<b>الشرط الذي لم يتحقق:</b>"] + gates_lines(failed)
    out += ["", "WAIT هنا قرار مقصود: لا يُصدر النظام شراءً أو بيعًا دون أفضلية مثبتة إحصائيًا بعد نسبة العائد."]
    return "\n".join(out)


REASON_SHORT = {"no_validated_model": "لا نموذج متحقق منه", "data_anomaly": "قفزة سعرية", "quiet_market": "سوق هادئ",
                "abnormal_volatility": "تقلب غير طبيعي", "data_not_live": "بيانات غير حية",
                "news_risk": "خبر قريب", "below_validated_threshold": "قوة أقل من العتبة",
                "non_positive_edge": "عائد متوقع غير موجب", "insufficient_continuous_data": "بيانات غير كافية",
                "frozen_data": "سعر مجمّد", "out_of_distribution": "حالة غير مألوفة", "regime_blocked": "نظام سوق محجوب"}


def scan_text(rep: dict) -> str:
    out = [f"🛰 <b>AUTO SCANNER</b> — {fmt_time(rep['at'])}",
           f"فُحص {rep['markets_scanned']} سوقًا متاحًا × {len(rep['durations'])} مدد = {rep['evaluations']} تحليلًا "
           f"في {rep['scan_ms']} ms"]
    b = rep.get("best")
    if b:
        out += ["", f"🏆 <b>أفضل فرصة مؤهلة:</b> {esc(b['market'])} {DEC_AR[b['decision']]} لمدة {DUR_AR[b['horizon']]}",
                f"عائد متوقع متحفظ {b['edge_lb']:+.3f} لكل وحدة (بعد نسبة العائد {b['payout']:.2f})"]
    else:
        out += ["", f"<b>{esc(rep.get('message') or 'لا توجد فرصة مؤهلة حاليًا')}</b>"]
    if rep.get("wait_reasons"):
        out += ["", "<b>أسباب عدم التأهل:</b>"] + [f"• {esc(REASON_SHORT.get(k, k))}: {v}"
                                                    for k, v in rep["wait_reasons"].items()]
    if rep.get("unavailable"):
        out.append(f"\n⚪ {len(rep['unavailable'])} سوقًا غير متاحة لم تُفحص (لا بيانات حقيقية).")
    out.append("\nكثرة الإشارات ليست نجاحًا؛ النظام لا يُجبَر على إصدار إشارة.")
    return "\n".join(out)


def scan_keyboard(rep: dict) -> InlineKeyboardMarkup:
    rows = []
    if rep.get("best"):
        rows.append([btn(f"📋 تفاصيل {rep['best']['market']}", f"det:{rep['best']['market']}")])
    rows.append([btn("🔄 إعادة الفحص", "scan"), btn("📈 تحليل سوق محدد", "mk:0:all")])
    rows.append(back_row())
    return InlineKeyboardMarkup(rows)


def models_text(s: dict) -> str:
    out = ["🧠 <b>حالة النماذج</b>",
           "الأعداد: " + ("، ".join(f"{esc(k)} {v}" for k, v in s["counts_ar"].items()) or "لا توجد نماذج"),
           f"نماذج معتمدة للاستخدام: <b>{s['champions']}</b>"
           + (" — لذلك القرارات WAIT" if not s["champions"] else ""),
           f"فرضيات اختُبرت: {s['hypotheses_tested']} · اجتازت التحقق: {s['hypotheses_validated']}"]
    for f in s.get("forward_tests") or []:
        out.append(f"• اختبار مستقبلي #{f['id']} {esc(f['market'])} {DUR_AR.get(f['duration'], f['duration'])} "
                   f"({esc(f['spec'])}): {f['n']}/{f['target_n']} صفقة، دقة {pct(f['accuracy'])} "
                   f"(المطلوب {pct(f['required'])}) — {esc(f['status'])}")
    rej = [m for m in s.get("recent") or [] if m["status"] == "rejected"][:3]
    if rej:
        out.append("\n<b>آخر أسباب الرفض:</b>")
        for m in rej:
            out.append(f"• #{m['id']} {esc(m['market'])} {m['duration']}ث: {esc('؛ '.join((m.get('reasons_ar') or m['reasons'])[:2]) or m.get('note') or '—')}")
    out.append("\nلا يُعتمد نموذج لدقته على بيانات التدريب؛ يلزم تحقق خارج العينة على صفقات مستقلة مع تصحيح التعدد.")
    return "\n".join(out)


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
    out = [f"<b>حالة النظام — {BOT_NAME}</b>", f"الخدمات: {'🟢 تعمل' if s['status'] == 'ok' else '🟡 بعضها يعيد التشغيل'}"]
    loading = s.get("data_loading")
    if loading:
        out.append(f"⏳ بدأ التشغيل قبل {int(s.get('uptime_s') or 0)} ث — بيانات الأسواق قيد التحميل (نحو دقيقة)")
    out.append(telegram_line(s.get("telegram") or {}))
    for k, v in (s.get("providers") or {}).items():
        off = "⏳ جارٍ الاتصال وتحميل البيانات" if loading else "⚪ غير متصل"
        out.append(f"• {esc(SRC_AR.get(k, k).split(' — ')[0])}: {'🟢 متصل (بيانات حديثة مُثبتة)' if v.get('proven') else off}")
    out.append(f"• جسر ExpertOption: {'مفعّل' if s.get('bridge_enabled') else 'معطّل (لا بيانات ExpertOption ولا OTC)'}")
    out.append(f"• النموذج المحلي: {'🟢 ' + esc(s['llm'].get('model')) if s['llm'].get('ok') else '⚪ غير متاح'}")
    out.append(f"• أسواق ببيانات حية: {esc('، '.join(s['live_markets']) or 'لا يوجد')}")
    for h in s.get("health") or []:
        out.append(f"  ◦ {esc(h['market'])}: آخر شمعة {esc(h.get('last_bar_utc'))}، عمر {h.get('age_s')} ث، "
                   f"فجوات آخر ساعة {h.get('gaps_last_hour')}، قفزات {h.get('spikes_last_hour')}")
    out.append(f"• نماذج مُفعّلة (مُتحقق منها): {len(s['champions'])}"
               + (" — لذلك القرارات «انتظار» حاليًا" if not s["champions"] else ""))
    sc = s.get("scanner")
    if sc:
        out.append(f"• AUTO SCANNER: {sc['cycles']} دورة، {sc['evaluations']} تحليلًا، دورات بفرصة مؤهلة "
                   f"{sc['qualified_cycles']}")
    for f in s.get("forward_tests") or []:
        out.append(f"• اختبار مستقبلي {esc(f['market'])} {DUR_AR.get(f['duration'], f['duration'])} ({esc(f['spec'])}): "
                   f"{esc(f['status'])} {f['n']}/{f['target_n']}")
    return "\n".join(out)


# ---------------------------------------------------------------- image-style signal mode (owner's design)
SIG_WELCOME = "📊 اختر السوق المُراد تحليله:"
SIG_MARKETS = [          # only markets with GENUINE live data (Binance reference prices)
    ("BTCUSD", "Bitcoin", "₿"), ("ETHUSD", "Ethereum", "💠"),
    ("LTCUSD", "Litecoin", "🔷"), ("XRPUSD", "Ripple", "💧"),
]
# The owner's screenshot markets, shown for the exact look. ExpertOption-only / OTC assets have
# NO legitimate external price source, so pressing them says so honestly — never a fabricated signal.
SIG_DISPLAY = [
    ("Football Index", "⚽"), ("Smarty", "🧠"), ("USD/NGN (OTC)", "🇳🇬"), ("EUR/USD (OTC)", "🇪🇺"),
    ("GBP/USD (OTC)", "🇬🇧"), ("USD/JPY (OTC)", "🇯🇵"), ("Gold", "🪙"), ("Silver", "⚪"),
]
SIG_DUR_AR = {30: "30 ثانية", 60: "دقيقة واحدة", 120: "دقيقتان", 300: "5 دقائق"}


def sig_markets_keyboard() -> InlineKeyboardMarkup:
    # Exactly the owner's screenshot: the 8 markets with their emojis, one per row, nothing else.
    rows = [[btn(f"{name} {emoji}", f"sigx:{i}")] for i, (name, emoji) in enumerate(SIG_DISPLAY)]
    return InlineKeyboardMarkup(rows)


def sig_nodata_text(idx: int) -> str:
    name, emoji = SIG_DISPLAY[idx]
    return (f"📊 السوق : {esc(name)} {emoji}\n\n"
            "⏳ لا تتوفر بيانات أسعار حقيقية لهذا السوق.\n"
            "لا تُعرض إشارة دون سعر فعلي.")


def sig_result_text(r: dict) -> str:
    emoji = dict((m, e) for m, _, e in SIG_MARKETS).get(r["market"], "📊")
    name = r.get("market_name") or r["market"]
    if not r.get("ok"):
        state = STATE_AR.get(r.get("data_state"), "غير متاحة")
        return (f"📊 السوق : {esc(name)} {emoji}\n\n"
                f"⏳ لا تتوفر بيانات حية الآن لهذا السوق (الحالة: {state}).\n"
                "لا تُعرض إشارة دون بيانات حقيقية حديثة. أعد المحاولة بعد قليل.")
    dir_ar = "🟢 الصفقة : شراء / Buy" if r["direction"] == "BUY" else "🔴 الصفقة : بيع / Sell"
    # short output (owner's design): market / time / direction, then one tiny warning line only
    return "\n\n".join([
        f"📊 السوق : {esc(name)} {emoji}",
        f"⏱️ الوقت : {SIG_DUR_AR.get(r['duration'], str(r['duration']) + ' ث')}",
        dir_ar,
        "<i>⚠️ تحليل فقط — غير مضمونة.</i>",
    ])


def sig_menu_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[btn("🔁 رجوع للأسواق", "sigmenu")]])


def sig_after_keyboard(market_id: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [btn("🔄 تحليل جديد", f"sig:{market_id}"), btn("🔁 سوق آخر", "sigmenu")],
    ])


def telegram_line(t: dict) -> str:
    """Polling health of THIS bot process. A 409 Conflict means another process is polling with
    the same token: Telegram then splits updates between them, so replies become erratic."""
    if t.get("conflict"):
        return (f"• بوت Telegram: 🔴 <b>تعارض 409</b> — نسخة أخرى من البوت تعمل بالرمز نفسه "
                f"(تعارضات: {t.get('conflicts_total', 0)}). أوقف النسخة الأخرى؛ تعمل نسخة واحدة فقط.")
    if t.get("last_error") and t.get("error_active"):
        return f"• بوت Telegram: 🟡 خطأ في الاستطلاع ({esc(t['last_error'])}) — يعيد المحاولة تلقائيًا"
    return "• بوت Telegram: 🟢 الاستطلاع يعمل (نسخة واحدة، محادثات خاصة فقط)"
