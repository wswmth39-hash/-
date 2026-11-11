'use strict';
// المحرك — من التيك إلى القرار: بناء الشموع، إغلاقها، تسوية نتائج الشمعة السابقة، التحليل، الصفقات الظلّية والافتراضية.
// يقرأ ويكتب حالة المحرك فقط. لا DOM ولا WebSocket (طبقة المنصة تستدعي feedTick/loadHistory/connOpen/connLost).
// يُصدر الأحداث: 'candle' (إغلاق شمعة)، 'ws'، 'history'، 'stale'، 'tf' — يستمع لها المسجّل والواجهة.
const { rec, slot, blank } = require('../core/stats');
const { rawVotes } = require('../core/strategies');
const { liveBlock } = require('../core/quality');
const { analyze, noneR } = require('../core/decision');
const { assetOfKey, tfOfKey } = require('../core/learning');
const { KEYS } = require('./state');

module.exports = function install(E) {
  const { S, CFG } = E, clock = E.clock;
  const [logErr, save, saveCfg, saveState, LSset, settleShadows, registerShadows, evalVariants, isOwn, settle, settleTie, maybeTrade, confirmOrder, finishOpen, failPending, voidTrade] = E.use('logErr', 'save', 'saveCfg', 'saveState', 'LSset', 'settleShadows', 'registerShadows', 'evalVariants', 'isOwn', 'settle', 'settleTie', 'maybeTrade', 'confirmOrder', 'finishOpen', 'failPending', 'voidTrade');
  // العائد يختلف من أصل لآخر: نقطة التعادل = 1 / (1 + العائد)
  const payoutOf = a => { const v = a && CFG.payoutBy ? CFG.payoutBy[a] : undefined; return Number.isFinite(v) ? v : CFG.payout; };
  const BE = a => 1 / (1 + payoutOf(a));
  const BEA = A => BE(A && A.k ? assetOfKey(A.k) : null); // assetOfKey من learning.js
  // المفتاح يتضمن مدة الشمعة حتى لا تختلط إحصاءات أطر زمنية مختلفة
  const AK = a => CFG.tf === 60 ? a : a + '@' + CFG.tf;
  const getAK = k => S.A[k] || (S.A[k] = { k, s: {}, b: {}, e: blank(), z: {} });
  const getA = a => getAK(AK(a));
  const stratErrAt = {};
  function stratErr(k, e) {
    const now = clock();
    if (stratErrAt[k] && now - stratErrAt[k] < 6e5) return;
    stratErrAt[k] = now;
    logErr('STRAT_ERR', k + ': ' + String(e && e.message || e));
  }
  // ================= الشموع من التيك =================
  function feedTick(asset, ts, p) {
    if (!Number.isFinite(ts) || !Number.isFinite(p) || p <= 0) return;
    if (S.lock && asset !== S.lock) return;
    const t = Math.floor(ts / CFG.tf) * CFG.tf;
    const arr = S.candles[asset] || (S.candles[asset] = []);
    const c = arr[arr.length - 1];
    if (c && c.t > t) return; // تيك قديم/خارج الترتيب
    if (!S.loading) { S.lastRx[asset] = clock(); S.lastPx[asset] = p; S.tickTs[asset] = ts; }
    if (!c || c.t < t) {
      if (c) onClose(asset, arr, t, ts);
      // sl/sh: هل وصلت الشمعة تيكات حية/تاريخية · mg: أكبر فجوة بين تيكين · rx0: ساعة الجهاز عند أول تيك حي (لكشف الانقطاع أثناءها)
      arr.push({ t, o: p, h: p, l: p, c: p, ft: ts, lt: ts, nt: 1, sl: !S.loading, sh: S.loading, mg: 0, rx0: S.loading ? 0 : clock() });
      if (arr.length > CFG.maxCandles) arr.shift();
    } else if (ts < c.lt) {
      // v3.4: تيك متأخر داخل الشمعة نفسها: حدث فعلًا فيدخل في القمة/القاع، لكنه ليس آخر سعر فلا يغيّر الإغلاق
      c.h = Math.max(c.h, p); c.l = Math.min(c.l, p); c.nt++;
      if (S.loading) c.sh = true; else { c.sl = true; if (!c.rx0) c.rx0 = clock(); }
    } else {
      if (ts - c.lt > (c.mg || 0)) c.mg = ts - c.lt;
      c.h = Math.max(c.h, p); c.l = Math.min(c.l, p); c.c = p; c.lt = ts; c.nt++;
      if (S.loading) c.sh = true; else { c.sl = true; if (!c.rx0) c.rx0 = clock(); }
    }
    S.cur = asset; S.ticks++; S.lastTs[asset] = ts;
    if (!S.loading) {
      const pd = S.pending;
      if (pd && pd.asset === asset && ts > pd.sendTs) confirmOrder(p, ts);
      const o = S.open;
      if (o && o.asset === asset && ts >= o.expTs) finishOpen(p, ts);
    }
  }
  function onClose(asset, arr, tNew, tsNow) {
    const c = arr[arr.length - 1], A = getA(asset), live = !S.loading, pd = S.P[asset];
    const tol = Math.max(5, CFG.edgeTol * CFG.tf);
    // الشمعة المكتملة: أول تيك قريب من بدايتها وآخر تيك قريب من نهايتها
    const complete = (c.ft - c.t) <= tol && (c.t + CFG.tf - c.lt) <= tol;
    // تدقيق عدم استخدام المستقبل: لا نحلّل إلا شمعة أُغلقت فعلًا وبترتيب زمني سليم
    const aud = S.audit;
    aud.n++;
    let bad = '';
    if (tNew !== undefined && !(c.t < tNew)) bad = 'الشمعة المحللة لم تُغلق بعد';
    else if (tsNow !== undefined && tsNow < c.t + CFG.tf) bad = 'تحليل شمعة قبل انتهاء وقتها';
    else if (arr.length > 1 && !(arr[arr.length - 2].t < c.t)) bad = 'ترتيب الشموع الزمني مختل';
    if (bad) { aud.bad++; aud.last = bad; logErr('LOOKAHEAD', asset + ': ' + bad); }
    // المسجّل: الشمعة أُغلقت للتو (وصل تيك بعد نهايتها). لا يؤثر على التحليل التالي.
    E.emit('candle', { asset, c, complete, tsClose: tsNow, bad, live, tf: CFG.tf, wsCloseAt: S.wsCloseAt });
    settleShadows(asset, A, c, complete, live);
    const nextOK = !!pd && c.t - pd.ct === CFG.tf && pd.ok === true && complete;
    if (pd && pd.log && pd.log.win === null && !pd.log.tie && !isOwn(pd.log) && !nextOK) pd.log.stale = true;
    if (nextOK && c.c === pd.entry && pd.log && !isOwn(pd.log)) settleTie(pd.log, c.c);
    if (nextOK && c.c !== pd.entry) {
      const up = c.c > pd.entry;
      for (const k in pd.raw) if (pd.raw[k] !== 0) { // v3.4: كل صوت مستخدم في القرار يُقيَّم (كانت الأصوات < 0.5 تُستخدم ولا تُقيَّم)
        const ok1 = (pd.raw[k] > 0) === up;
        rec(slot(A.s, k), ok1, live);
        if (pd.regime && pd.regime !== '-') rec(slot(A.s, k + '#' + pd.regime), ok1, live); // أداء الاستراتيجية في هذه الحالة على هذا الأصل
      }
      if (pd.dir !== 'none') {
        const win = (pd.dir === 'call') === up;
        if (pd.log) pd.log.candleWin = win; // نتيجة «إغلاق مقابل إغلاق» (ما يتعلّم منه البوت) تُحفظ بجانب نتيجة الصفقة الافتراضية
        rec(A.e, win, live);
        rec(slot(A.b, pd.bk), win, live);
        if (pd.log && !isOwn(pd.log)) settle(pd.log, c.c, win);
      }
    }
    // اختبار ثبات القراءات: نعيد حساب قراءات الشمعة السابقة بعد إغلاقها ونقارنها بما استُخدم وقت القرار
    if (nextOK && live && pd.raw && Object.keys(pd.raw).length && aud.n % 6 === 0) {
      const i = arr.length - 2;
      if (i >= 0 && arr[i].t === pd.ct) {
        const re = rawVotes(arr.slice(Math.max(0, i + 1 - CFG.window), i + 1), stratErr);
        aud.tests++;
        if (Object.keys(pd.raw).some(k => Math.abs((re[k] || 0) - pd.raw[k]) > 1e-9)) { aud.testBad++; aud.last = 'تغيّرت قراءة مؤشر بعد إغلاق الشمعة'; logErr('LOOKAHEAD', asset + ': ' + aud.last); }
      }
    }
    const blk = liveBlock(arr, tNew, { live, wsUp: S.wsUp, tf: CFG.tf, contigN: CFG.contigN });
    // asOf = وقت التيك الذي أغلق الشمعة: المحلّل يرفض أي شمعة في النافذة تنتهي بعده (عقد الشموع المغلقة)
    let r = blk ? noneR(blk) : analyzeWindow(arr.slice(-CFG.window), A, asset, tsNow);
    if (bad) r = { ...r, d: 'none', conf: Math.min(r.conf, 59), abst: [bad], comp: false, sd: 0 };
    S.sigBy[asset] = r;
    S.P[asset] = { entry: c.c, ct: c.t, raw: r.raw, dir: r.d, bk: r.bk, log: null, ok: complete, regime: r.regime, at: live ? clock() : 0, atr: r.atr };
    E.clusters.trackCorr(r.rawA || r.raw, asset);
    S.ncl = (S.ncl || 0) + 1;
    if (S.ncl % 25 === 0) { try { E.clusters.rebuildClusters(); if (live) evalVariants(); } catch (e) { logErr('VAR_ERR', String(e && e.message || e)); } }
    if (r.sd) S.sdh[asset] = (S.sdh[asset] || []).concat([r.sd]).slice(-5);
    registerShadows(asset, c, r, complete, live);
    if (live) {
      save();
      if (complete && r.d !== 'none' && r.conf >= CFG.minConf) { try { maybeTrade(asset, r, c, A); } catch (e) { logErr('SIM_ERR', String(e && e.message || e)); } }
    }
  }
  function watchdog() {
    const now = clock(), pd = S.pending;
    // v3.4: تقادم السعر: إن توقف التيك تُلغى الإشارة المعروضة (لا تبقى إشارة قديمة كأنها حالية)
    for (const a in S.sigBy) {
      const r = S.sigBy[a];
      if (!r || r.stale || S.loading || !S.lastRx[a]) continue;
      const age = now - S.lastRx[a];
      if (age > CFG.maxTickAgeMs) {
        S.sigBy[a] = { ...noneR('بيانات قديمة: لا سعر منذ ' + Math.round(age / 1000) + ' ث — التحليل متوقف', r.regime), stale: true };
        E.emit('stale', { asset: a, age: Math.round(age / 1000) });
        if (S.P[a]) S.P[a].ok = false;
      }
    }
    if (pd && now - pd.at > CFG.confirmMs) failPending('لم يتأكد فتح الصفقة (لم تصل بيانات بعد الإرسال)');
    const e = S.open;
    if (e && now - e.openAt > (e.dur + 25) * 1000) {
      S.pausedUntil = Math.max(S.pausedUntil, now + CFG.staleRestMs);
      voidTrade(e, 'لم تصل نتيجة الصفقة');
    }
  }
  function onWsDown() {
    E.emit('ws', { up: false });
    if (S.pending) failPending('انقطاع الاتصال قبل التأكيد');
    if (S.open) voidTrade(S.open, 'انقطاع الاتصال أثناء الصفقة');
  }
  function setTf(v) {
    if (![15, 30, 60].includes(+v)) return false;
    if (S.pending) failPending('تغيير مدة الشمعة');
    if (S.open) voidTrade(S.open, 'تغيير مدة الشمعة', false);
    if (+v !== CFG.tf) E.emit('tf', { from: CFG.tf, to: +v });
    CFG.tf = +v; S.candles = {}; S.P = {}; S.sigBy = {}; S.fired = {}; S.SH = {}; S.sdh = {}; S.dq = {};
    saveCfg();
    return true;
  }
  function resetLearning() {
    if (S.pending) failPending('مسح التعلّم');
    if (S.open) voidTrade(S.open, 'مسح التعلّم', false);
    for (const a in S.A) delete S.A[a];
    S.log = []; S.net = 0; S.lossRow = 0; S.halted = false; S.haltWhy = ''; S.unkRow = 0; S.failRow = 0;
    S.corr = {};
    S.journal = []; S.SH = {}; S.sdh = {};
    LSset(KEYS.LIVE, {}); LSset(KEYS.LOG, []); LSset(KEYS.JOURNAL, []); saveState();
    try { E.fn.IDB.del('bak').catch(() => {}); } catch (e) {}
  }
  // سبب الإشارة بصيغة مقروءة (يُحفظ مع كل إدخال في السجل)

  // تحليل نافذة شموع مغلقة: كل مدخلات النواة تُمرَّر صراحةً من الحالة هنا (النواة لا تقرأ الحالة بنفسها).
  function analyzeWindow(cs, A, asset, asOf, allowOpen) {
    return analyze(cs, {
      cfg: CFG, A, learner: E.learner, clusters: E.clusters, asOf, allowOpen,
      useNew: k => !!(S.sv && S.sv[k] === 'new'),
      sdh: S.sdh[asset],
      tickAgeMs: (!S.loading && asset && S.lastRx[asset]) ? clock() - S.lastRx[asset] : null,
      onQuality: dq => { if (asset) S.dq[asset] = dq; },
      onStratErr: stratErr,
      onError: (code, msg) => logErr(code, msg)
    });
  }
  // تحميل التاريخ الذي ترسله المنصة: إعادة تشغيل زمنية للتيكات مع تصفير إحصاء التدريب لهذا الأصل (لا عدّ مزدوج)
  function loadHistory(a, history) {
    S.loading = true;
    S.candles[a] = []; S.P[a] = null;
    const A = getA(a);
    for (const k in A.s) A.s[k].hn = A.s[k].hw = 0;
    for (const k in A.b) A.b[k].hn = A.b[k].hw = 0;
    for (const k in A.z) A.z[k].hn = A.z[k].hw = 0;
    S.SH[a] = []; S.sdh[a] = []; S.corrH[a] = {};
    A.e.hn = A.e.hw = 0;
    history.forEach(x => feedTick(a, +x[0], +x[1]));
    S.loading = false;
    S.loadedCount = history.length;
    E.emit('history', { asset: a, ticks: history.length });
    try { E.clusters.rebuildClusters(); evalVariants(); } catch (e) { logErr('VAR_ERR', String(e && e.message || e)); }
  }
  // حالة الاتصال (تُبلَّغ من طبقة المنصة)
  function connOpen() {
    if (S.wsUp === false) E.emit('ws', { up: true });
    S.wsUp = true; S.wsUpAt = clock();
  }
  function connLost() {
    S.wsUp = false;          // نوقف التحليل والدخول فورًا
    S.wsCloseAt = clock();   // المسجّل يرفض أي شمعة حية كانت مفتوحة لحظة الانقطاع
  }
  E.provide({ payoutOf, BE, BEA, AK, tfOfKey, getAK, getA, stratErr, feedTick, onClose, watchdog, onWsDown, setTf, resetLearning, analyzeWindow, loadHistory, connOpen, connLost });
};
