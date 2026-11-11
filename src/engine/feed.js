'use strict';
// المحرك — مراقب تغذية البيانات: كل تيك من المنصة يمر من هنا قبل feedTick.
//   1) تحقق (core/feed.tickError) ← المرفوض يُعدّ بسببه ولا يدخل المحرك
//   2) كشف التكرار (حلقة محدودة لكل أصل) ← التيك المعاد إرساله يُتجاهل ويُعدّ
//   3) عدّادات لكل اتصال (رسائل، أحجام، آخر رسالة، أحداث معروفة/غير معروفة، أخطاء تحليل)
//   4) حالة البيانات (core/feed.feedStatus) تُحسب كل ثانية وتُصدر حدث 'feed' عند تغيّرها
// لا يرسل شيئًا للمنصة إطلاقًا.
const { tickError, createDedup, createClockTracker, feedStatus, FEED_LABEL } = require('../core/feed');

module.exports = function install(E) {
  const { S, CFG } = E, clock = E.clock;
  const [feedTick, loadHistory, connOpen, connLost, logErr] = E.use('feedTick', 'loadHistory', 'connOpen', 'connLost', 'logErr');
  const dedup = createDedup(256);
  const clk = createClockTracker();
  const F = E.feed = {
    conns: {}, nextId: 1,
    ticks: { rx: 0, ok: 0, dup: 0, rej: 0, reasons: {} },
    hist: { loads: 0, rx: 0, ok: 0, rej: 0, reasons: {} },
    perAsset: {},             // asset → { at (ساعة الجهاز), ts (وقت المنصة), p, n }
    candles: 0, reconnects: 0, downSince: 0, downMs: 0, everOpen: false, lastOpenAt: 0, lastCloseAt: 0,
    msgs: 0, bytes: 0, known: {}, unknown: {}, parseErrors: [], errAt: {},
    status: 'disconnected', statusSince: clock(), lastAsset: null, assetChanges: 0, reloadAdvice: false, history: [],
    // v4.0.1: مراحل خط البيانات (لكل اتصال) — لتحديد المرحلة التي ينقطع عندها الخط بدقة
    outgoing: {}, assetsById: {}, assetsLoadedAt: 0, unpaired: { n: 0, skeletons: [] }, lastMarketAt: 0, env: null
  };
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
  const openCount = () => Object.values(F.conns).filter(c => c.state === 'open').length;
  const connectingCount = () => Object.values(F.conns).filter(c => c.state === 'connecting').length;

  // ---- الاتصالات ----
  function connCreated(host) {
    const id = F.nextId++;
    F.conns[id] = { id, host: String(host || '').slice(0, 80), state: 'connecting', createdAt: clock(), openedAt: 0, closedAt: 0, msgs: 0, bytes: 0, lastMsgAt: 0, events: 0, errors: 0,
      auth: null, sub: null, marketAt: 0, marketEvents: 0, histAt: 0 };
    pruneConns();
    return id;
  }
  function connOpened(id) {
    const c = F.conns[id]; if (!c) return;
    const now = clock(), wasDown = F.everOpen && openCount() === 0;
    c.state = 'open'; c.openedAt = now;
    if (wasDown) { F.reconnects++; if (F.downSince) F.downMs += now - F.downSince; }
    F.downSince = 0; F.everOpen = true; F.lastOpenAt = now; F.reloadAdvice = false;
    connOpen();
  }
  // يعيد true إن كان هذا آخر اتصال مفتوح (أي انقطاع فعلي)
  function connClosed(id) {
    const c = F.conns[id]; if (!c) return false;
    const was = c.state === 'open';
    c.state = 'closed'; c.closedAt = clock();
    if (!was || openCount()) return false;
    F.downSince = F.lastCloseAt = clock();
    connLost();
    return true;
  }
  // لا نحتفظ إلا بآخر 20 اتصالًا مغلقًا (حد للذاكرة)
  function pruneConns() {
    const closed = Object.values(F.conns).filter(c => c.state === 'closed').sort((a, b) => a.closedAt - b.closedAt);
    while (closed.length > 20) delete F.conns[closed.shift().id];
  }
  function onMessage(id, bytes) {
    const c = F.conns[id], now = clock();
    F.msgs++; F.bytes += bytes || 0;
    if (c) { c.msgs++; c.bytes += bytes || 0; c.lastMsgAt = now; }
  }
  function onEvent(id, name, known) {
    const c = F.conns[id]; if (c) c.events++;
    const key = String(name).slice(0, 60);
    bump(known ? F.known : F.unknown, key);
    if (!known && Object.keys(F.unknown).length > 200) delete F.unknown[Object.keys(F.unknown)[0]];
  }
  // خطأ تحليل: يُسجَّل دائمًا في العدّاد، وفي سجل الأخطاء مرة كل 10 ث لكل سبب (لا إغراق)
  function parseError(id, why) {
    const c = F.conns[id], now = clock();
    if (c) c.errors++;
    F.parseErrors.push({ at: now, conn: id || 0, why: String(why).slice(0, 120) });
    if (F.parseErrors.length > 50) F.parseErrors.shift();
    const k = String(why).slice(0, 40);
    if (!F.errAt[k] || now - F.errAt[k] > 1e4) { F.errAt[k] = now; logErr('WS_PARSE', String(why).slice(0, 160)); }
  }

  // ---- مراحل الخط: الدخول، الاشتراك، أحداث السوق، جدول الأصول ----
  // أسماء الأحداث موثّقة في reverse/on_events.md وemit_events.md لمكتبة lordralinc/pocket_option (مرجع فقط، لم يُنسخ منها كود)
  function onAuth(id, ok) {
    const c = F.conns[id]; if (!c) return;
    c.auth = { ok: !!ok, at: clock() };
    if (!ok) logErr('PO_AUTH', 'المنصة رفضت الدخول (NotAuthorized) على الاتصال #' + id);
  }
  // رسالة صادرة أرسلتها المنصة نفسها (البوت لا يرسل شيئًا). نسجّل الاسم فقط، وللاشتراك أصل/مدة فقط — لا أي قيمة أخرى.
  function onOutgoing(id, name, payload) {
    const c = F.conns[id], key = String(name).slice(0, 60);
    bump(F.outgoing, key);
    if (Object.keys(F.outgoing).length > 100) delete F.outgoing[Object.keys(F.outgoing)[0]];
    if (!c) return;
    if (key === 'changeSymbol' || key === 'subscribeSymbol') {
      const a = payload && typeof payload === 'object' ? payload.asset : payload;
      const per = payload && typeof payload === 'object' && Number.isFinite(+payload.period) ? +payload.period : null;
      if (typeof a === 'string' || Number.isFinite(a)) c.sub = { raw: typeof a === 'string' ? a.slice(0, 40) : +a, period: per, at: clock(), via: key };
    }
    if (key === 'unSubscribeSymbol' && c.sub) c.sub = { ...c.sub, unsubAt: clock() };
  }
  function onMarketEvent(id, kind) {
    const c = F.conns[id], now = clock();
    F.lastMarketAt = now;
    if (c) { c.marketAt = now; c.marketEvents++; if (kind === 'hist') c.histAt = now; }
  }
  // updateAssets: صفوف تبدأ بـ [id, asset, label, ...] (ترتيب موثّق ومتطابق في مكتبتين مستقلتين). نأخذ id والرمز فقط.
  function onAssets(id, rows) {
    if (!Array.isArray(rows)) { parseError(id, 'updateAssets: بنية غير متوقعة'); return 0; }
    let n = 0;
    for (const r of rows) if (Array.isArray(r) && Number.isFinite(r[0]) && typeof r[1] === 'string' && r[1].length <= 40) { F.assetsById[r[0]] = r[1]; n++; }
    if (!n) parseError(id, 'updateAssets: لا صفوف بالشكل [id, asset, …]');
    else F.assetsLoadedAt = clock();
    return n;
  }
  // إطار ثنائي وصل دون حدث ينتظره: نحفظ بنيته فقط (بلا قيم) ليظهر في التشخيص
  function onUnpaired(id, sk) {
    F.unpaired.n++;
    const s = JSON.stringify(sk).slice(0, 300);
    if (F.unpaired.skeletons.length < 5 && !F.unpaired.skeletons.includes(s)) F.unpaired.skeletons.push(s);
  }
  const resolveAsset = raw => raw === null || raw === undefined ? null : typeof raw === 'string' ? raw : (F.assetsById[raw] || null);
  function setEnv(env) { F.env = env; }

  // ---- التيكات ----
  function ingestTicks(id, list) {
    onMarketEvent(id, 'stream');
    if (!Array.isArray(list)) { parseError(id, 'updateStream: الحمولة ليست مصفوفة'); return 0; }
    let ok = 0;
    for (const x of list) {
      F.ticks.rx++;
      if (!Array.isArray(x) || x.length < 3) { F.ticks.rej++; bump(F.ticks.reasons, 'بنية تيك غير متوقعة'); continue; }
      const t = { asset: String(x[0]), ts: +x[1], p: +x[2] }, pa = F.perAsset[t.asset] || null;
      const why = tickError(t, pa, { maxJump: CFG.maxPriceJump, jumpWindowS: 300 });
      if (why) { F.ticks.rej++; bump(F.ticks.reasons, why); continue; }
      if (dedup.seen(t.asset, t.ts, t.p)) { F.ticks.dup++; continue; }
      const before = S.cur;
      feedTick(t.asset, t.ts, t.p);
      // قد يرفض المحرك التيك (أصل غير مقفول، أقدم من الشمعة الحالية): نعدّه صالحًا فقط إن دخل فعلًا
      if (S.lastTs[t.asset] !== t.ts) { F.ticks.rej++; bump(F.ticks.reasons, S.lock && t.asset !== S.lock ? 'أصل غير المقفول' : 'تيك أقدم من الشمعة الحالية'); continue; }
      F.ticks.ok++; ok++;
      const now = clock(), r = F.perAsset[t.asset] || (F.perAsset[t.asset] = { at: 0, ts: 0, p: 0, n: 0 });
      r.at = now; r.ts = t.ts; r.p = t.p; r.n++;
      clk.add(now, t.ts);
      if (before !== S.cur && S.cur === t.asset) {
        F.assetChanges++;
        if (F.lastAsset !== null) E.emit('asset', { from: F.lastAsset, to: t.asset });
        F.lastAsset = t.asset;
      }
    }
    prunePerAsset();
    return ok;
  }
  function prunePerAsset() {
    const ks = Object.keys(F.perAsset);
    if (ks.length <= 50) return;
    ks.sort((a, b) => F.perAsset[a].at - F.perAsset[b].at).slice(0, ks.length - 50).forEach(k => { delete F.perAsset[k]; dedup.forget(k); });
  }
  // التاريخ: يُرفض منه ما لا يجتاز التحقق الأساسي (أنواع، وحدة الوقت). لا يُطبَّق كشف التكرار: التحميل يعيد البناء من الصفر.
  function ingestHistory(id, asset, list) {
    onMarketEvent(id, 'hist');
    if (typeof asset !== 'string' || !Array.isArray(list)) { parseError(id, 'updateHistory: بنية غير متوقعة'); return 0; }
    F.hist.loads++;
    const ok = [];
    for (const x of list) {
      F.hist.rx++;
      const t = Array.isArray(x) ? { asset, ts: +x[0], p: +x[1] } : null;
      const why = t ? tickError(t, null, null) : 'بنية غير متوقعة';
      if (why) { F.hist.rej++; bump(F.hist.reasons, why); continue; }
      ok.push(x);
    }
    F.hist.ok += ok.length;
    loadHistory(asset, ok);
    // آخر تيكات التاريخ تدخل كاشف التكرار: إن أعادت المنصة بثها حيًا لا تُحسب مرتين
    dedup.forget(asset);
    ok.slice(-256).forEach(x => dedup.seen(asset, +x[0], +x[1]));
    return ok.length;
  }
  E.on('candle', x => { if (x.live) F.candles++; });

  // ---- الحالة ----
  const TH = () => ({ liveMs: CFG.feedLiveMs, delayMs: CFG.maxTickAgeMs, unavailableMs: CFG.feedUnavailableMs, waitMs: CFG.feedWaitMs });
  function computeStatus(now = clock()) {
    const cur = S.cur, pa = cur ? F.perAsset[cur] : null;
    const recentErr = F.parseErrors.filter(e => now - e.at < 6e4).length;
    return feedStatus({ openConns: openCount(), connecting: connectingCount(), everOpen: F.everOpen, lastOpenAt: F.lastOpenAt, lastCloseAt: F.lastCloseAt,
      lastValidAt: pa ? pa.at : 0, errorBurst: recentErr >= 5, now }, TH());
  }
  // يُستدعى كل ثانية (المؤقت في main): يُحدّث الحالة المخزنة ويُصدر حدثًا عند التغيّر
  function feedCheck() {
    const now = clock(), st = computeStatus(now);
    if (st !== F.status) {
      const from = F.status;
      F.status = st; F.statusSince = now;
      F.history.push({ at: now, from, to: st }); if (F.history.length > 100) F.history.shift();
      E.emit('feed', { from, to: st, label: FEED_LABEL[st] });
    }
    if (!F.reloadAdvice && F.downSince && now - F.downSince > CFG.reloadAdviceMs) {
      F.reloadAdvice = true;
      logErr('WS_RELOAD', 'لم تُعِد المنصة الاتصال منذ ' + Math.round((now - F.downSince) / 1000) + ' ث: أعد تحميل الصفحة');
      E.emit('reloadAdvice', { since: F.downSince });
    }
    return st;
  }
  // المراحل الخمس + تشخيص المرحلة التي ينقطع عندها الخط. «صالحة» = نفس شرط «بيانات حية».
  function stages(now = clock(), st = computeStatus(now)) {
    const open = Object.values(F.conns).filter(c => c.state === 'open');
    const authC = open.filter(c => c.auth && c.auth.ok), denied = open.some(c => c.auth && !c.auth.ok);
    const subC = open.filter(c => (c.sub && !c.sub.unsubAt) || c.histAt);
    const recvC = open.filter(c => c.marketAt && now - c.marketAt <= CFG.feedReceivingMs);
    const sub = subC.map(c => c.sub).filter(Boolean).sort((a, b) => b.at - a.at)[0] || null;
    const subAsset = sub ? resolveAsset(sub.raw) : null;
    const pa = S.cur ? F.perAsset[S.cur] : null;
    const rejected = F.ticks.rej, tickRx = F.ticks.rx;
    const S5 = {
      connected: { ok: open.length > 0, detail: open.length + ' اتصال مفتوح من ' + Object.keys(F.conns).length },
      authenticated: { ok: authC.length > 0, failed: denied, detail: authC.length ? 'successauth على ' + authC.length + ' اتصال' : denied ? 'NotAuthorized' : 'لم يصل successauth على أي اتصال مفتوح' },
      subscribed: { ok: subC.length > 0, detail: sub ? (sub.via + ': ' + (subAsset || ('#' + sub.raw + ' (غير معروف في updateAssets)')) + (sub.period !== null ? ' · period ' + sub.period : '')) : subC.length ? 'وصل تاريخ أصل (اشتراك ضمني)' : 'لم تطلب المنصة الاشتراك في أي أصل (changeSymbol) على اتصال مفتوح' },
      receiving: { ok: recvC.length > 0, detail: F.lastMarketAt ? 'آخر رسالة أسعار منذ ' + Math.round((now - F.lastMarketAt) / 1000) + ' ث' : 'لم تصل أي رسالة أسعار (updateStream / updateHistoryNew*)' },
      valid: { ok: st === 'live', detail: pa ? 'آخر تيك صالح منذ ' + Math.round((now - pa.at) / 1000) + ' ث' : tickRx ? 'كل التيكات المستلمة رُفضت (' + rejected + ')' : 'لا تيكات' }
    };
    let why = '';
    if (!S5.connected.ok) why = 'لا يوجد أي اتصال مفتوح مع المنصة.';
    else if (S5.authenticated.failed) why = 'المنصة رفضت الدخول (NotAuthorized): سجّل الدخول من جديد.';
    else if (!S5.authenticated.ok) why = 'الاتصال مفتوح لكن لم يصل تأكيد الدخول (successauth) على أي اتصال مفتوح.';
    else if (!S5.subscribed.ok) why = 'لم ترسل المنصة طلب الاشتراك في أصل (changeSymbol) على أي اتصال مراقَب. افتح الشارت واختر الأصل.';
    else if (!S5.receiving.ok) {
      const e = F.env || {};
      why = 'المنصة طلبت الاشتراك' + (subAsset ? ' في ' + subAsset : '') + ' لكن لا تصل رسائل الأسعار على أي اتصال مراقَب.' +
        (F.unpaired.n ? ' وصلت ' + F.unpaired.n + ' إطارات ثنائية دون حدث ينتظرها (انظر «رسائل المنصة»).' : '') +
        (e.workers ? ' الصفحة أنشأت ' + e.workers + ' Worker: قد تُستقبل الأسعار داخله حيث لا يصل المراقب.' : '') +
        (e.frames ? ' في الصفحة ' + e.frames + ' إطار iframe.' : '');
    } else if (!S5.valid.ok) why = tickRx && rejected === tickRx ? 'تصل رسائل الأسعار لكن كل التيكات تُرفض — الأسباب: ' + Object.entries(F.ticks.reasons).map(([k, n]) => k + ' ×' + n).join('، ') :
      S.cur && subAsset && S.cur !== subAsset ? 'تصل الأسعار لأصل (' + S.cur + ') غير الأصل المشترك فيه (' + subAsset + ').' : 'تصل رسائل الأسعار لكن لا تيك صالح حديث للأصل الحالي.';
    return { stages: S5, why, subAsset, tickAsset: S.cur || null };
  }
  // للعرض: نسخة بلا أي تعديل للحالة
  function feedView() {
    const now = clock(), st = computeStatus(now), cur = S.cur, pa = cur ? F.perAsset[cur] : null;
    return {
      status: st, label: FEED_LABEL[st], since: F.status === st ? F.statusSince : now,
      // source: مصدر البيانات — اتصال المنصة في الصفحة (تترجمه الواجهة إلى نص عربي)
      source: 'platform-ws', asset: cur, lastPrice: pa ? pa.p : null, lastTs: pa ? pa.ts : null,
      lastAt: pa ? pa.at : null, ageMs: pa ? now - pa.at : null,
      // إزاحة ساعة المنصة عن الجهاز (تُقاس، لا تُفترض) والتأخر النسبي لآخر تيك
      clockOffsetS: clk.offsetS() === null ? null : Math.round(clk.offsetS()), latencyMs: clk.latencyMs(),
      ticks: { ...F.ticks, reasons: { ...F.ticks.reasons } }, hist: { ...F.hist, reasons: { ...F.hist.reasons } }, candles: F.candles,
      conns: Object.values(F.conns).map(c => ({ ...c })), open: openCount(), reconnects: F.reconnects,
      downMs: F.downMs + (F.downSince ? now - F.downSince : 0), msgs: F.msgs, bytes: F.bytes,
      known: { ...F.known }, unknown: { ...F.unknown }, parseErrors: F.parseErrors.slice(-20).map(e => ({ ...e })),
      assets: Object.keys(F.perAsset).map(a => ({ a, ...F.perAsset[a], ageMs: now - F.perAsset[a].at })).sort((x, y) => y.at - x.at),
      assetChanges: F.assetChanges, reloadAdvice: F.reloadAdvice, history: F.history.slice(-20).map(h => ({ ...h })),
      pipeline: stages(now, st), outgoing: { ...F.outgoing }, assetsKnown: Object.keys(F.assetsById).length,
      unpaired: { n: F.unpaired.n, skeletons: F.unpaired.skeletons.slice() }, env: F.env ? { ...F.env } : null
    };
  }
  E.provide({ connCreated, connOpened, connClosed, onMessage, onEvent, parseError, ingestTicks, ingestHistory, feedCheck, feedView, computeStatus,
    onAuth, onOutgoing, onMarketEvent, onAssets, onUnpaired, resolveAsset, setEnv, feedStages: stages });
};
