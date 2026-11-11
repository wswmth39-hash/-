'use strict';
// المحرك — مراقب تغذية البيانات: كل تيك من المنصة يمر من هنا قبل feedTick.
//   1) تحقق (core/feed.tickError) ← المرفوض يُعدّ بسببه ولا يدخل المحرك
//   2) كشف التكرار (حلقة محدودة لكل أصل) ← التيك المعاد إرساله يُتجاهل ويُعدّ
//   3) عدّادات لكل اتصال (رسائل، أحجام، آخر رسالة، أحداث معروفة/غير معروفة، أخطاء تحليل)
//   4) حالة البيانات (core/feed.feedStatus) تُحسب كل ثانية وتُصدر حدث 'feed' عند تغيّرها
// لا يرسل شيئًا للمنصة إطلاقًا.
const { tickError, createDedup, feedStatus, FEED_LABEL } = require('../core/feed');

module.exports = function install(E) {
  const { S, CFG } = E, clock = E.clock;
  const [feedTick, loadHistory, connOpen, connLost, logErr] = E.use('feedTick', 'loadHistory', 'connOpen', 'connLost', 'logErr');
  const dedup = createDedup(256);
  const F = E.feed = {
    conns: {}, nextId: 1,
    ticks: { rx: 0, ok: 0, dup: 0, rej: 0, reasons: {} },
    hist: { loads: 0, rx: 0, ok: 0, rej: 0, reasons: {} },
    perAsset: {},             // asset → { at (ساعة الجهاز), ts (وقت المنصة), p, n }
    candles: 0, reconnects: 0, downSince: 0, downMs: 0, everOpen: false, lastOpenAt: 0, lastCloseAt: 0,
    msgs: 0, bytes: 0, known: {}, unknown: {}, parseErrors: [], errAt: {},
    status: 'disconnected', statusSince: clock(), lastAsset: null, assetChanges: 0, reloadAdvice: false, history: []
  };
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
  const openCount = () => Object.values(F.conns).filter(c => c.state === 'open').length;
  const connectingCount = () => Object.values(F.conns).filter(c => c.state === 'connecting').length;

  // ---- الاتصالات ----
  function connCreated(host) {
    const id = F.nextId++;
    F.conns[id] = { id, host: String(host || '').slice(0, 80), state: 'connecting', createdAt: clock(), openedAt: 0, closedAt: 0, msgs: 0, bytes: 0, lastMsgAt: 0, events: 0, errors: 0 };
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

  // ---- التيكات ----
  function ingestTicks(id, list) {
    if (!Array.isArray(list)) { parseError(id, 'updateStream: الحمولة ليست مصفوفة'); return 0; }
    let ok = 0;
    for (const x of list) {
      F.ticks.rx++;
      if (!Array.isArray(x) || x.length < 3) { F.ticks.rej++; bump(F.ticks.reasons, 'بنية تيك غير متوقعة'); continue; }
      const t = { asset: String(x[0]), ts: +x[1], p: +x[2] }, pa = F.perAsset[t.asset] || null;
      const why = tickError(t, pa, { nowSec: clock() / 1000, maxFutureS: CFG.maxFutureS, maxJump: CFG.maxPriceJump, jumpWindowS: 300 });
      if (why) { F.ticks.rej++; bump(F.ticks.reasons, why); continue; }
      if (dedup.seen(t.asset, t.ts, t.p)) { F.ticks.dup++; continue; }
      const before = S.cur;
      feedTick(t.asset, t.ts, t.p);
      // قد يرفض المحرك التيك (أصل غير مقفول، أقدم من الشمعة الحالية): نعدّه صالحًا فقط إن دخل فعلًا
      if (S.lastTs[t.asset] !== t.ts) { F.ticks.rej++; bump(F.ticks.reasons, S.lock && t.asset !== S.lock ? 'أصل غير المقفول' : 'تيك أقدم من الشمعة الحالية'); continue; }
      F.ticks.ok++; ok++;
      const now = clock(), r = F.perAsset[t.asset] || (F.perAsset[t.asset] = { at: 0, ts: 0, p: 0, n: 0 });
      r.at = now; r.ts = t.ts; r.p = t.p; r.n++;
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
  // للعرض: نسخة بلا أي تعديل للحالة
  function feedView() {
    const now = clock(), st = computeStatus(now), cur = S.cur, pa = cur ? F.perAsset[cur] : null;
    const lag = pa && pa.ts ? Math.round(pa.at / 1000 - pa.ts) : null;
    return {
      status: st, label: FEED_LABEL[st], since: F.status === st ? F.statusSince : now,
      // source: مصدر البيانات — اتصال المنصة في الصفحة (تترجمه الواجهة إلى نص عربي)
      source: 'platform-ws', asset: cur, lastPrice: pa ? pa.p : null, lastTs: pa ? pa.ts : null,
      lastAt: pa ? pa.at : null, ageMs: pa ? now - pa.at : null, lagS: lag,
      ticks: { ...F.ticks, reasons: { ...F.ticks.reasons } }, hist: { ...F.hist, reasons: { ...F.hist.reasons } }, candles: F.candles,
      conns: Object.values(F.conns).map(c => ({ ...c })), open: openCount(), reconnects: F.reconnects,
      downMs: F.downMs + (F.downSince ? now - F.downSince : 0), msgs: F.msgs, bytes: F.bytes,
      known: { ...F.known }, unknown: { ...F.unknown }, parseErrors: F.parseErrors.slice(-20).map(e => ({ ...e })),
      assets: Object.keys(F.perAsset).map(a => ({ a, ...F.perAsset[a], ageMs: now - F.perAsset[a].at })).sort((x, y) => y.at - x.at),
      assetChanges: F.assetChanges, reloadAdvice: F.reloadAdvice, history: F.history.slice(-20).map(h => ({ ...h }))
    };
  }
  E.provide({ connCreated, connOpened, connClosed, onMessage, onEvent, parseError, ingestTicks, ingestHistory, feedCheck, feedView, computeStatus });
};
