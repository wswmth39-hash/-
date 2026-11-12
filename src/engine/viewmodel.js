'use strict';
// المحرك — نموذج العرض (قراءة فقط). يحوّل حالة المحرك إلى بيانات بسيطة (أرقام، نصوص، قوائم) تعرضها الواجهة كما هي.
// قواعد هذه الوحدة:
//  1) لا تكتب في الحالة أبدًا. (v3.5 كانت getA(asset) أثناء العرض تُنشئ سجل إحصاء فارغًا: أُزيل — peekA لا يُنشئ.)
//  2) تعيد نسخًا لا مراجع للحالة القابلة للتغيير، فلا تستطيع الواجهة تعديل المحرك عبرها.
//  3) كل حساب إحصائي (Wilson، الأوزان، البوابة، الألوان المشتقة منها) يتم هنا؛ الواجهة لا تحسب شيئًا.
const { wil, nw } = require('../core/stats');
const { ema } = require('../core/indicators');
const { NM, GRP, SK, STR, IMPK } = require('../core/strategies');
const { verifyCandles } = require('../core/quality');
const { CTX_LBL, CTX_KINDS } = require('../core/context');
const { HZ, RGS, VETOS, EXPS, hzLabel } = require('../core/catalog');
const { tfOfKey, assetOfKey, emptyBook } = require('../core/learning');
const { KEYS, SIM_ONLY, SCRIPT_VERSION } = require('./state');

const copy = x => x === undefined ? undefined : JSON.parse(JSON.stringify(x));
const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
// مقارنة الأصل المعروض في الصفحة (تقرؤه طبقة المنصة وتمرّره) مع أصل التحليل — بحتة
function activeCheck(asset, shown, lock) {
  if (!shown) return lock === asset ? { ok: true, why: 'الأصل مقفول يدويًا (تعذّرت قراءة الاسم)' } : { ok: false, why: 'تعذّر قراءة الأصل المعروض' };
  return norm(asset) === norm(shown) ? { ok: true, why: shown } : { ok: false, why: 'المعروض "' + shown + '" ≠ ' + asset };
}

module.exports = function install(E) {
  const { S, CFG } = E, clock = E.clock;
  const [AK, BE, payoutOf, simSummary, LSget] = E.use('AK', 'BE', 'payoutOf', 'simSummary', 'LSget');
  const L = () => E.learner;
  const peekA = asset => (asset ? S.A[AK(asset)] : null) || null;

  // الصفحة الرئيسية + الاستراتيجيات + السجل + الذاكرة
  function view(shown) {
    const asset = S.cur, A = peekA(asset), r = asset ? S.sigBy[asset] : null;
    const arr = asset ? S.candles[asset] || [] : [];
    const g = L().gate(r, A || { b: {} }), be = BE(asset);
    const vq = arr.length >= 60 ? verifyCandles(arr.slice(-CFG.window), CFG.tf, CFG.maxGap) : { ok: false, why: 'لا يكفي' };
    const now = clock();
    const curRg = r && r.regime ? r.regime : '-';
    const strat = (A ? STR.map(([k, kind]) => {
      const ak = L().vk(k), W = L().wtR(A, ak, curRg), [n, w] = A.s[ak] ? nw(A.s[ak]) : [0, 0];
      return { k, ak, kind, n, w, p: n ? w / n : 0, W };
    }).sort((a, b) => b.W.w - a.W.w) : []).map(s => ({
      name: NM[s.k], improved: s.ak !== s.k, kind: s.kind, n: s.n, p: s.p, lb: s.W.lb, w: s.W.w, mode: s.W.mode, src: s.W.src,
      rg: s.W.rg ? curRg : '', rp: s.W.rp,
      cls: s.W.mode === 'رابحة' ? 'u' : s.W.mode === 'عكسية' ? 'g' : s.W.mode === 'معطلة' || s.W.mode === 'متدهورة' ? 'd' : 'm'
    }));
    const bks = A ? Object.keys(A.b).sort().map(k => {
      const n = A.b[k].ln, w = A.b[k].lw;
      return { k, n, acc: n ? w / n : 0, ok: n >= CFG.minLive && wil(n, w, CFG.gateZ) > be };
    }) : [];
    const log = S.log.slice(0, 60).map(copy);
    const [en, ew] = A ? nw(A.e) : [0, 0];
    const sessW = S.log.filter(e => e.win === true).length, sessL = S.log.filter(e => e.win === false).length;
    let lifeW = 0, lifeL = 0;
    // v3.4: الإجمالي = نتائج الإشارات الحية فقط. نتائج إعادة تشغيل التاريخ تدريب داخل العينة ولا تُخلط بها.
    for (const a in S.A) { if (tfOfKey(a) !== CFG.tf) continue; lifeW += S.A[a].e.lw; lifeL += S.A[a].e.ln - S.A[a].e.lw; }
    const cd = asset && S.lastTs[asset] && arr.length ? Math.max(0, CFG.tf - (S.lastTs[asset] - arr[arr.length - 1].t)) : null;
    const paused = now < S.pausedUntil, cooling = now < S.cdUntil;
    const best = A ? L().bestBucket(A) : null;
    const ageMs = asset && S.lastRx[asset] ? now - S.lastRx[asset] : null;
    const ac = asset ? activeCheck(asset, shown, S.lock) : { ok: false, why: 'لا أصل' };
    const checks = [
      { ok: arr.length >= 60, t: 'شموع كافية (' + arr.length + '/60)' },
      { ok: vq.ok, t: 'جودة البيانات: ' + vq.why },
      { ok: !!r && r.d !== 'none', t: 'إشارة موجودة' + (r && r.d === 'none' && r.abst && r.abst[0] ? ' — ' + r.abst[0] : '') },
      { ok: !!r && r.d !== 'none' && r.htfOK && r.htf !== 0, t: 'توافق مع الإطار الأعلى' },
      { ok: g.ok, t: 'بوابة الإثبات: ' + g.why },
      { ok: ageMs !== null && ageMs <= CFG.maxTickAgeMs && S.wsUp !== false, t: 'بيانات حديثة واتصال سليم' + (ageMs !== null ? ' (' + Math.round(ageMs / 1000) + 'ث)' : '') },
      { ok: ac.ok, t: 'الأصل المعروض (معلومة): ' + ac.why },
      { ok: !cooling && !paused && !S.halted, t: 'لا تهدئة ولا إيقاف' }
    ];
    const meta = LSget(KEYS.META, null);
    const ss = simSummary();
    const n = A ? A.e.ln : 0, w = A ? A.e.lw : 0, po = payoutOf(asset);
    return {
      asset, r: r ? copy({ d: r.d, conf: r.conf, regime: r.regime, abst: r.abst, notes: r.notes, stale: r.stale }) : null,
      g, n: arr.length, strat, bks, log, en, ew, acc: en ? ew / en : 0, be, cd,
      liveN: n, liveW: w, liveLb: n ? wil(n, w, 1.64) : 0,
      // إحصاء صادق: فاصل ثقة 95% والتوقع الرياضي (يُعرض فقط من 30 إشارة حية)
      lo95: n ? wil(n, w, 1.96) : 0, hi95: n ? 1 - wil(n, n - w, 1.96) : 0, payout: po,
      price: arr.length ? arr[arr.length - 1].c : null, checks, paused, cooling,
      loaded: S.loadedCount, sessW, sessL, lifeW, lifeL, best, savedAt: meta && meta.at, stale: !!(r && r.stale),
      histN: A ? A.e.hn : 0, histW: A ? A.e.hw : 0,
      logCount: S.log.length, sim: ss, errRate: ss.tried ? ss.bad / ss.tried : 0,
      dq: asset && S.dq[asset] ? copy(S.dq[asset]) : null,
      st: {
        cur: S.cur, lock: S.lock, net: S.net, halted: S.halted, haltWhy: S.haltWhy, unkRow: S.unkRow, wsUp: S.wsUp,
        pending: !!S.pending, open: S.open ? { asset: S.open.asset } : null, storeErr: S.storeErr,
        hourly: S.hourly.filter(t => now - t < 36e5).length, decision: copy(S.decision),
        errors: S.errors.slice(0, 60).map(copy), trace: S.trace.map(copy)
      },
      cfg: { tf: CFG.tf, auto: CFG.auto, gate: CFG.gate, minConf: CFG.minConf, minLive: CFG.minLive, gateZ: CFG.gateZ, recentN: CFG.recentN, minQ: CFG.minQ, maxPerHour: CFG.maxPerHour, driftN: CFG.driftN },
      simOnly: SIM_ONLY, version: SCRIPT_VERSION
    };
  }

  // صفحة المختبر — كل الأرقام والأحكام محسوبة هنا
  function lab() {
    const asset = S.cur, dq = asset ? S.dq[asset] : null, be = BE(), au = S.audit, tf = CFG.tf, zAgg = L().zAgg;
    const hz = HZ.map(h => ({ h, label: hzLabel(h, tf), z: zAgg('h|' + h) }));
    const live = hz.filter(x => x.z.ln >= 30), pool = live.length ? live : hz.filter(x => x.z.hn >= 30);
    const sc = x => live.length ? wil(x.z.ln, x.z.lw, 1.64) : wil(x.z.hn, x.z.hw, 1.64);
    const best = pool.length ? pool.reduce((a, b) => sc(b) > sc(a) ? b : a).h : null;
    hz.forEach(x => { x.lbPct = x.z.ln ? Math.round(wil(x.z.ln, x.z.lw) * 100) : null; x.best = best === x.h; });
    const rm = { cols: HZ.map(h => hzLabel(h, tf)), rows: RGS.map(g => ({ g, cells: HZ.map(x => { const z = zAgg('hr|' + x + '|' + g); return { n: z.ln + z.hn, w: z.lw + z.hw }; }) })) };
    const vetos = VETOS.map(name => {
      const z = zAgg('v|' + name), n = z.ln + z.hn, w = z.lw + z.hw;
      return { name, n, w, useful: n >= 30 && 1 - wil(n, n - w, 1.64) < be, harmful: n >= 30 && wil(n, w, 1.64) > be };
    });
    const cx = CTX_KINDS.map(k => {
      const z = zAgg('c|' + k), n = z.ln + z.hn, w = z.lw + z.hw;
      return { label: CTX_LBL[k], n, w, lose: n >= 30 && 1 - wil(n, n - w, 1.64) < be, win: n >= 30 && wil(n, w, 1.64) > be };
    });
    const cSig = asset ? S.sigBy[asset] : null, cRg = cSig && cSig.regime && cSig.regime !== '-' ? cSig.regime : '-';
    let matrix = null;
    if (asset) {
      const beA = BE(asset);
      matrix = {
        cols: HZ.map(h => hzLabel(h, tf)),
        rows: L().stratMatrix(asset, cRg, peekA(asset) || emptyBook()).map(r => ({
          name: NM[r.k], improved: r.ak !== r.k, st: r.st, cls: r.cls,
          cells: r.cells.map((c, i) => {
            const lb = c.n >= 30 ? wil(c.n, c.w, CFG.zStrat) : 0;
            return { n: c.n, w: c.w, general: c.src === 'عام', best: r.bi === i, cls: !c.n ? '' : lb > beA ? 'w' : (c.n >= 30 && wil(c.n, c.n - c.w, CFG.zStrat) > beA) ? 'l' : '' };
          })
        })),
        note: 'الأصل: ' + asset + ' · الحالة: ' + (cRg === '-' ? 'كل الحالات' : cRg) + ' · ★ = أنسب مدة للاستراتيجية · «عام» = عينة مجمّعة من بقية الأصول لقلّة بيانات هذا الأصل'
      };
    }
    const variants = IMPK.map(k => ({ name: NM[k], cur: S.sv[k] === 'new', ...L().variantVerdict(k) }));
    const svLog = (S.svLog || []).slice(0, 3).map(x => ({ name: NM[x.k], to: x.to, t: x.t }));
    const clm = {};
    SK.forEach(k => { const g = E.clusters.clusterOf(k); (clm[g] = clm[g] || []).push(k); });
    const clusters = Object.keys(clm).map(g => ({ names: clm[g].map(k => NM[k]), merged: new Set(clm[g].map(k => GRP[k])).size }));
    const pairs = E.clusters.corrReport(100, .85).slice(0, 5).map(p => ({ names: p.pair.split('|').map(x => NM[x] || x), agree: p.agree }));
    const zb = zAgg('x|base'), zf = zAgg('x|forced'), za = zAgg('ab|all');
    const exps = EXPS.map(e => {
      const z = zAgg('x|' + e.k), rd = L().expReady(e), cur = e.k !== 'base' && !e.ref && L().sameCfg(e);
      return { k: e.k, n: e.n, base: e.k === 'base', ref: !!e.ref, cur, ready: rd.ok, why: rd.why, z, lbPct: z.ln ? Math.round(wil(z.ln, z.lw, CFG.gateZ) * 100) : null };
    });
    return {
      dq: dq ? copy(dq) : null, minQ: CFG.minQ, audit: copy(au), hz, hzNote: best === null ? 'تحتاج 30 صفقة ظلّية على الأقل لكل مدة' : '', bestLive: live.length > 0,
      rm, vetos, cx, matrix, variants, svLog, clusters, pairs,
      ab: { zf, zb, za, be }, exps,
      journal: { n: S.journal.length, done: S.journal.filter(e => Object.keys(e.o).length).length, idbErr: S.idbErr, idbAt: S.idbAt, idbReady: S.idbReady, adopted: S.adopted.slice(0, 20).map(copy) }
    };
  }

  // صفحة المسجّل
  function recorder() {
    const R = E.fn.REC;
    return {
      on: R.on, ready: R.ready, err: R.err, kind: R.kind, queue: R.q.size, sess: copy(R.sess),
      series: Object.values(R.series).map(copy), scan: copy(R.scan), events: R.events.slice(0, 40).map(copy), bytesPer: E.fn.REC_BYTES
    };
  }

  // الشارت: آخر 90 شمعة + المتوسطات محسوبة على كل الشموع المتاحة + علامات الإشارات
  function chart() {
    const all = S.candles[S.cur] || [], arr = all.slice(-90).map(c => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c }));
    const closes = all.map(c => c.c);
    const lines = arr.length < 3 ? [] : [[9, '#f5c45e'], [21, '#7aa2ff']].map(([n, col]) => ({ col, v: ema(closes, n).slice(-arr.length) }));
    const marks = S.log.filter(e => e.asset === S.cur).map(e => ({ i: arr.findIndex(c => c.t === e.ct + CFG.tf), dir: e.dir, entry: e.entry, win: e.win })).filter(m => m.i >= 0);
    return { arr, lines, marks };
  }

  // إعدادات تحتاجها الواجهة عند البناء فقط
  function settings() { return { tf: CFG.tf, minConf: CFG.minConf, payout: CFG.payout, payoutCur: payoutOf(S.cur), beCur: BE(S.cur), cur: S.cur, lock: S.lock }; }


  // لوحة V1.0 (الواجهة الجديدة): رموز حالة محايدة لغويًا تترجمها الواجهة، وأرقام محسوبة من الحالة الفعلية فقط.
  // لا تكتب في الحالة. نصوص الأسباب التي يولّدها المحرك (abst/notes) تُمرَّر كما هي.
  function dash() {
    const now = clock(), asset = S.cur, r = asset ? S.sigBy[asset] : null, arr = asset ? S.candles[asset] || [] : [];
    const f = E.fn.feedView(), dataOk = f.status === 'live' || f.status === 'delayed';
    // حالة محرك التوقيت — مشتقة من قرار المحرك الحالي (محرك التوقيت المستقل والتقييم من 100: المرحلة 5)
    let timing;
    if (!asset || !dataOk) timing = { state: 'wait', code: 'data' };
    else if (S.loading) timing = { state: 'analyzing', code: 'history' };
    else if (arr.length < 60) timing = { state: 'wait', code: 'collect', n: arr.length, need: 60 };
    else if (!r) timing = { state: 'analyzing', code: 'first' };
    else if (r.stale) timing = { state: 'wait', code: 'stale' };
    else if (r.d !== 'none') timing = { state: 'favorable', code: 'signal' };
    else timing = { state: 'no_trade', code: 'engine', text: r.abst && r.abst[0] ? String(r.abst[0]) : '' };
    const analysis = !asset ? 'idle' : S.loading ? 'loading' : !dataOk ? 'paused' : arr.length < 60 ? 'collecting' : 'active';
    let signal = null;
    if (r) {
      const sd = r.sd || 0, votes = r.rawA && typeof r.rawA === 'object' ? r.rawA : {};
      const side = sgn => sd ? Object.keys(votes).filter(k => votes[k] * sd * sgn > 0).map(k => ({ k, name: NM[k] || k, v: +(+votes[k]).toFixed(2) })) : [];
      signal = {
        d: r.d, conf: r.conf, sd, regime: r.regime || '-', stale: !!r.stale,
        abst: (r.abst || []).map(String), notes: (r.notes || []).map(String),
        agree: r.agree === undefined ? null : r.agree, oppPct: r.opp === undefined ? null : Math.round(r.opp * 100),
        htf: r.htf === undefined ? null : r.htf, htfOK: r.htfOK === undefined ? null : !!r.htfOK,
        q: r.q === undefined ? null : r.q, vetoes: copy(r.vetoes || []),
        ctx: r.ctx ? { label: r.ctx.label, clarity: r.ctx.clarity, note: r.ctx.note || '' } : null,
        pro: side(1), con: side(-1),
        bestHz: r.hzB ? { s: r.hzB.h * CFG.tf, accPct: Math.round(r.hzB.acc * 100) } : null
      };
    }
    // إحصاءات من دفاتر النتائج الحية المحفوظة (لا تُخلط بها نتائج إعادة تشغيل التاريخ)
    const add = (o, k, n, w) => { const x = o[k] || (o[k] = { k, n: 0, w: 0 }); x.n += n; x.w += w; };
    const byAsset = {}, byTf = {}, byStrat = {};
    let n = 0, w = 0;
    for (const k in S.A) {
      const A = S.A[k];
      if (!A || !A.e) continue;
      n += A.e.ln; w += A.e.lw;
      if (A.e.ln) { add(byAsset, assetOfKey(k), A.e.ln, A.e.lw); add(byTf, tfOfKey(k), A.e.ln, A.e.lw); }
      // المفاتيح التي فيها # دفاتر فرعية لكل حالة سوق: تُستبعد حتى لا تُعدّ النتيجة مرتين
      for (const sk in A.s) if (sk.indexOf('#') < 0 && A.s[sk] && A.s[sk].ln) add(byStrat, sk, A.s[sk].ln, A.s[sk].lw);
    }
    const fin = x => ({ ...x, acc: x.n ? x.w / x.n : null, lo: x.n ? wil(x.n, x.w, 1.96) : null, hi: x.n ? 1 - wil(x.n, x.n - x.w, 1.96) : null });
    const rows = o => Object.values(o).map(fin).sort((a, b) => b.n - a.n);
    const assets = f.assets.map(x => {
      const cs = S.candles[x.a] || [], sg = S.sigBy[x.a];
      return { a: x.a, price: x.p === undefined ? null : x.p, ageMs: x.ageMs, candles: cs.length, d: sg ? sg.d : null, conf: sg ? sg.conf : null, cur: x.a === asset, locked: S.lock === x.a };
    });
    return {
      version: SCRIPT_VERSION, now, asset, lock: S.lock, tf: CFG.tf, candles: arr.length,
      candleLeftS: asset && S.lastTs[asset] && arr.length ? Math.max(0, Math.ceil(CFG.tf - (S.lastTs[asset] - arr[arr.length - 1].t))) : null,
      feed: { status: f.status, since: f.since, source: f.source, lastPrice: f.lastPrice, lastTs: f.lastTs, lastAt: f.lastAt, ageMs: f.ageMs, latencyMs: f.latencyMs,
        open: f.open, reconnects: f.reconnects, ticksOk: f.ticks.ok, ticksRej: f.ticks.rej, ticksDup: f.ticks.dup, reloadAdvice: !!f.reloadAdvice, why: f.pipeline ? f.pipeline.why : '' },
      analysis, timing, signal,
      dq: asset && S.dq[asset] ? copy(S.dq[asset]) : null,
      assets, assetsScanned: Object.keys(S.candles).length,
      signalsLogged: S.log.length,
      stats: { total: fin({ k: 'all', n, w }), byAsset: rows(byAsset), byTf: rows(byTf), byStrat: rows(byStrat).map(x => ({ ...x, name: NM[x.k] || x.k })) },
      log: S.log.slice(0, 200).map(e => ({ t: e.t, asset: e.asset, dir: e.dir, conf: e.conf, entry: e.entry, exit: e.exit, win: e.win, tie: !!e.tie, stale: !!e.stale, voided: !!e.voided, failed: !!e.failed, why: (e.why || []).map(String) })),
      errors: S.errors.length, storeErr: !!S.storeErr,
      cfg: { tf: CFG.tf, minConf: CFG.minConf, minQ: CFG.minQ, feedLiveMs: CFG.feedLiveMs, maxTickAgeMs: CFG.maxTickAgeMs, feedUnavailableMs: CFG.feedUnavailableMs, window: CFG.window, maxAssets: CFG.maxAssets }
    };
  }

  // حالة التغذية: نسخة من مراقب البيانات (engine/feed.js) دون تعديل
  const feed = () => E.fn.feedView();
  E.provide({ view, lab, recorder, chart, settings, feed, dash, activeCheck, norm });
};
module.exports.activeCheck = activeCheck;
module.exports.norm = norm;
