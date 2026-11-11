'use strict';
// المحرك — المحاكاة فقط (Paper Trading): دورة حياة الصفقة الافتراضية وحدود المخاطرة.
// لا يوجد هنا ولا في أي مكان آخر كود ينقر أزرار المنصة أو يرسل أوامر. النتائج تُحسب من أسعار التيك.
// يُصدر الأحداث: 'signal' (كل إشارة مسجّلة) و'result' (نتيجة إشارة/صفقة افتراضية).

module.exports = function install(E) {
  const { S, CFG } = E, clock = E.clock;
  const [saveLog, saveState, saveAll, logErr, simTrace] = E.use('saveLog', 'saveState', 'saveAll', 'logErr', 'simTrace');
  // صفقة محاكاة أو محاولة محاكاة: لا تُسوّى بطريقة الشمعة
  const isOwn = l => !!l && !!(l.try || l.auto || l.failed || l.voided);
  function settle(e, exit, win) {
    e.exit = exit; e.win = win;
    if (e.auto) {
      if (S.open === e) S.open = null;
      S.unkRow = 0;
      S.net += win ? CFG.payout : -1;
      S.lossRow = win ? 0 : S.lossRow + 1;
      if (S.lossRow >= CFG.maxLossRow) { S.pausedUntil = clock() + CFG.pauseMs; S.lossRow = 0; }
      if (S.net <= -CFG.maxDD) { S.halted = true; S.haltWhy = 'حد الخسارة'; }
      simTrace('settled', { asset: e.asset, win, net: +S.net.toFixed(2) });
      saveState();
    }
    saveLog();
    if (!S.loading) E.emit('result', win); // الواجهة تستمع؛ المحرك لا يعرف من يعرض
  }
  function settleTie(e, exit) {
    e.exit = exit; e.tie = true;
    if (e.auto) { if (S.open === e) S.open = null; S.unkRow = 0; simTrace('tie', { asset: e.asset }); saveState(); }
    saveLog();
  }
  // ================= المحاكاة: دورة حياة الأمر الافتراضي =================
  // الإرسال لا يُعدّ نجاحًا: الصفقة لا تُفتح إلا عند وصول تيك جديد بعد الإرسال (تأكيد)،
  // والنتيجة لا تُحسب إلا من تيك عند/بعد وقت الانتهاء. أي شيء آخر يصبح "ملغاة/غير مؤكدة" ولا يدخل التعلم ولا الربح/الخسارة.
  function preflight(asset) {
    const age = clock() - (S.lastRx[asset] || 0);
    if (age > CFG.maxTickAgeMs) return { ok: false, why: 'بيانات قديمة (' + Math.round(age / 1000) + 'ث)' };
    if (S.wsUp === false) return { ok: false, why: 'انقطاع اتصال البيانات' };
    if (!Number.isFinite(S.lastPx[asset]) || !Number.isFinite(S.tickTs[asset])) return { ok: false, why: 'لا يوجد سعر حالي' };
    return { ok: true };
  }
  function placeOrder(e, asset, r, c) {
    S.fired[asset] = c.t;
    S.cdUntil = clock() + CFG.cooldownCandles * CFG.tf * 1000;
    e.try = true; e.sendTs = S.tickTs[asset];
    S.pending = { e, asset, dir: r.d, sendTs: e.sendTs, at: clock() };
    simTrace('order_sent', { asset, dir: r.d });
    if (S.simBroker && S.simBroker.reject) failPending('رفض من وسيط المحاكاة');
  }
  function confirmOrder(px, ts) {
    const pd = S.pending;
    if (!pd) return;
    if (ts - pd.sendTs > CFG.confirmMs / 1000) { failPending('تأخر التأكيد'); return; }
    S.pending = null;
    const e = pd.e;
    e.auto = true; e.confirmed = 'sim'; e.dur = CFG.tf; e.entryPx = px; e.entryTs = ts; e.expTs = ts + CFG.tf; e.openAt = clock();
    S.open = e; S.hourly.push(clock()); S.failRow = 0;
    simTrace('order_confirmed', { asset: e.asset, dir: e.dir, px });
    saveLog(); saveState();
  }
  function failPending(why) {
    const pd = S.pending;
    if (!pd) return;
    S.pending = null;
    const e = pd.e;
    e.failed = true; e.reason = why;
    S.failRow++;
    logErr('ORDER_FAILED', why, { asset: pd.asset, dir: pd.dir });
    simTrace('order_failed', { asset: pd.asset, why });
    if (S.failRow >= CFG.maxFail) { S.halted = true; S.haltWhy = 'فشل أوامر المحاكاة المتكرر'; }
    saveLog(); saveState();
  }
  function voidTrade(e, why, countUnk = true) {
    if (!e || e.voided || e.tie || e.win !== null) return;
    e.fin = true; e.voided = true; e.stale = true; e.reason = why;
    if (S.open === e) S.open = null;
    if (S.pending && S.pending.e === e) S.pending = null;
    if (countUnk) {
      S.unkRow++;
      if (S.unkRow >= CFG.maxUnk) { S.halted = true; S.haltWhy = 'نتائج غير معروفة ×' + S.unkRow; }
    }
    logErr('VOID', why, { asset: e.asset });
    simTrace('order_void', { asset: e.asset, why });
    saveLog(); saveState();
  }
  function finishOpen(px, ts) {
    const e = S.open;
    if (!e || e.fin) return;
    if (ts - e.expTs > CFG.lateTolS) { voidTrade(e, 'تيك الانتهاء متأخر (فجوة بيانات)'); return; }
    e.fin = true;
    if (px === e.entryPx) settleTie(e, px);
    else settle(e, px, (e.dir === 'call') === (px > e.entryPx));
  }
  function killSwitch(why) {
    CFG.auto = false; S.halted = true; S.haltWhy = why || 'إيقاف طارئ';
    if (S.pending) { const e = S.pending.e; S.pending = null; e.failed = true; e.reason = 'إيقاف طارئ'; }
    if (S.open) voidTrade(S.open, 'إيقاف طارئ', false);
    logErr('KILL', 'إيقاف طارئ يدوي');
    saveAll();
  }
  function reasonsOf(r) {
    const out = ['قوة ' + r.conf + ' · ' + (r.d === 'call' ? 'صعود' : 'هبوط') + ' · حالة ' + r.regime];
    if (r.ctx) out.push('سياق: ' + r.ctx.label + ' ' + r.ctx.clarity + '%');
    out.push('اتفاق ' + r.agree + ' عناقيد · أصوات معاكسة ' + Math.round((r.opp || 0) * 100) + '%');
    (r.notes || []).filter(n => !/^حالة:|^أطر /.test(n)).slice(0, 6).forEach(n => out.push(n));
    return out.map(x => String(x).slice(0, 80));
  }
  // كل إشارة تُسجَّل. الصفقة الافتراضية تُفتح فقط إذا كان الدخول الآلي الافتراضي مفعّلًا واجتازت كل حدود المخاطرة.
  function maybeTrade(asset, r, c, A) {
    const g = E.learner.gate(r, A), now = clock(), skip = [];
    if (!CFG.auto) skip.push('الدخول الآلي الافتراضي متوقف (إشارة فقط)');
    if (S.halted) skip.push('المحاكاة موقوفة' + (S.haltWhy ? ': ' + S.haltWhy : ''));
    if (now < S.pausedUntil) skip.push('استراحة بعد خسائر متتالية');
    if (now < S.cdUntil) skip.push('تهدئة بعد صفقة');
    if (S.open || S.pending) skip.push('توجد صفقة افتراضية مفتوحة');
    if (S.hourly.filter(t => now - t < 36e5).length >= CFG.maxPerHour) skip.push('بلغ حد الصفقات بالساعة (' + CFG.maxPerHour + ')');
    if (S.fired[asset] === c.t) skip.push('دخلت هذه الإشارة سابقًا');
    if (CFG.gate && !g.ok) skip.push('البوابة: ' + g.why);
    const pf = preflight(asset);
    if (!pf.ok) skip.push(pf.why);
    const e = { t: now, asset, dir: r.d, conf: r.conf, entry: c.c, ct: c.t, exit: null, win: null, auto: false, proven: g.ok,
      virtual: true, why: reasonsOf(r), skip: CFG.auto ? skip : [], candleWin: null };
    S.log.unshift(e);
    if (S.log.length > 200) S.log.pop();
    if (S.P[asset]) S.P[asset].log = e;
    if (CFG.auto && !skip.length) placeOrder(e, asset, r, c);
    S.decision = { t: now, asset, dir: r.d, conf: r.conf, entered: !!(e.try && !e.failed), why: skip, ctx: r.ctx ? r.ctx.label + ' ' + r.ctx.clarity + '%' : '' };
    saveLog();
    E.emit('signal', e);
  }

  function simSummary() {
    const sim = S.log.filter(e => e.try);
    return {
      tried: sim.length,
      w: sim.filter(e => e.auto && e.win === true).length,
      l: sim.filter(e => e.auto && e.win === false).length,
      tie: sim.filter(e => e.tie).length,
      bad: sim.filter(e => e.failed || e.voided).length
    };
  }
  E.provide({ isOwn, settle, settleTie, preflight, placeOrder, confirmOrder, failPending, voidTrade, finishOpen, killSwitch, reasonsOf, maybeTrade, simSummary });
};
