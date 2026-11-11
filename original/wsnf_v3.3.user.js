// ==UserScript==
// @name         wsnf smart bot v3.3 (strategy selection)
// @namespace    local.wsnf.v25
// @version      3.3
// @description  تحليل متعدد الأطر + 5000 شمعة + 17 استراتيجية تتعلم بشكل دائم (محلي + عام) + نسخ احتياطي + عداد ربح/خسارة — الدخول الآلي حقيقي على المنصة (ينقر CALL/PUT) بحدود وإيقاف فوري
// @match        https://pocketoption.com/*
// @match        https://*.pocketoption.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
(function () {
'use strict';

/* v2.5: وضع المحاكاة فقط. لا يوجد في هذا الملف أي كود ينقر أزرار التداول أو يرسل أوامر للمنصة.
   الاعتراض على WebSocket للقراءة فقط (أسعار وتاريخ). الصفقات "افتراضية" وتُحسب من التيك. */
const SIM_ONLY = false; // v3.0: الدخول الآلي ينقر زر CALL/PUT في المنصة فعليًا (بحدود LIM وإيقاف فوري)

// ================= الإعدادات =================
const CFG = {
  tf: 60, minConf: 65, minAgree: 3, payout: .92,
  auto: false, gate: true,
  maxLossRow: 3, pauseMs: 6e5, maxPerHour: 12, maxDD: 6,
  maxCandles: 5000, window: 300, minLive: 100, minLocal: 30, minTrust: 50, minRegime: 60, driftN: 30, driftZ: 1,
  minScore: .15, veto: true, useHtf: true, regimes: null, minQ: 60, journalMax: 1500, useCtx: true, minClarity: 45, dyn: true,
  cooldownCandles: 2, htfK: 5, maxGap: .05,
  gateZ: 2.5, zStrat: 2.3, prior: 20, recentN: 40, edgeTol: .15,
  maxTickAgeMs: 8000, maxDriftAtr: 1, confirmMs: 4000, lateTolS: 5, staleRestMs: 12e4, maxUnk: 3, maxFail: 3
};
const VERSION = 4;
const KEY_LIVE = 'wsnf25_live', KEY_LOG = 'wsnf25_log', KEY_UI = 'wsnf25_ui', KEY_META = 'wsnf25_meta',
  KEY_ERR = 'wsnf25_err', KEY_CFG = 'wsnf25_cfg', KEY_STATE = 'wsnf25_state';
const BE = () => 1 / (1 + CFG.payout);
const S = {
  candles: {}, P: {}, A: {}, sigBy: {}, lastTs: {},
  cur: null, lock: null, ticks: 0, loading: false, loadedCount: 0,
  open: null, log: [], net: 0, lossRow: 0, pausedUntil: 0, halted: false,
  hourly: [], exp: null, cdUntil: 0, unkRow: 0, haltWhy: '',
  lastRx: {}, lastPx: {}, tickTs: {}, fired: {}, pending: null,
  errors: [], trace: [], wsUp: null, failRow: 0, decision: null,
  corr: {}, simBroker: { reject: false }, storeErr: false,
  SH: {}, sdh: {}, dq: {}, journal: [], adopted: [], audit: { n: 0, bad: 0, tests: 0, testBad: 0, last: '' },
  idbReady: false, idbErr: false, idbAt: 0, lastJ: 0, lastMir: 0,
  onFlash: null, onResult: null
};
const LSget = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } };
const LSset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { S.storeErr = true; return false; } };
const clamp = (v, a = -1, b = 1) => Math.max(a, Math.min(b, v));

// المفتاح يتضمن مدة الشمعة حتى لا تختلط إحصاءات أطر زمنية مختلفة
const AK = a => CFG.tf === 60 ? a : a + '@' + CFG.tf;
const tfOfKey = k => { const i = k.lastIndexOf('@'); return i < 0 ? 60 : (+k.slice(i + 1) || 60); };

// ================= الإحصاء =================
const blank = () => ({ hn: 0, hw: 0, ln: 0, lw: 0, rc: [] });
const slot = (o, k) => o[k] || (o[k] = blank());
const nw = o => [o.hn + o.ln, o.hw + o.lw];
const rec = (o, win, live) => {
  if (live) {
    o.ln++; if (win) o.lw++;
    const r = o.rc || (o.rc = []);
    r.push(win ? 1 : 0);
    if (r.length > 50) r.shift();
  } else { o.hn++; if (win) o.hw++; }
};
const wil = (n, w, z = 1.64) => {
  if (!n) return 0;
  const p = w / n, d = 1 + z * z / n;
  return (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
};
const getAK = k => S.A[k] || (S.A[k] = { s: {}, b: {}, e: blank(), z: {} });
const getA = a => getAK(AK(a));

// ================= الحفظ الدائم =================
function snapshot() {
  const out = {};
  for (const a in S.A) {
    const A = S.A[a];
    out[a] = { e: [A.e.ln, A.e.lw, A.e.hn, A.e.hw], s: {}, b: {} };
    for (const k in A.s) out[a].s[k] = [A.s[k].ln, A.s[k].lw, A.s[k].hn, A.s[k].hw, k.indexOf('#') < 0 ? (A.s[k].rc || []).join('') : ''];
    for (const k in A.b) out[a].b[k] = [A.b[k].ln, A.b[k].lw, A.b[k].hn, A.b[k].hw, (A.b[k].rc || []).join('')];
    out[a].z = {};
    for (const k in A.z) out[a].z[k] = [A.z[k].ln, A.z[k].lw, A.z[k].hn, A.z[k].hw];
  }
  return out;
}
const sane = (n, w) => { n = Math.max(0, +n | 0); w = Math.min(Math.max(0, +w | 0), n); return [n, w]; };
function applySnapshot(d) {
  for (const a in d) {
    const v = d[a];
    if (!v || typeof v !== 'object') continue;
    const A = getAK(a);
    const e = Array.isArray(v.e) ? v.e : [0, 0, 0, 0];
    [A.e.ln, A.e.lw] = sane(e[0], e[1]);
    [A.e.hn, A.e.hw] = sane(e[2], e[3]);
    for (const k in v.s || {}) {
      const x = v.s[k]; if (!Array.isArray(x)) continue;
      const o = slot(A.s, k);
      [o.ln, o.lw] = sane(x[0], x[1]); [o.hn, o.hw] = sane(x[2], x[3]);
      o.rc = typeof x[4] === 'string' ? x[4].split('').filter(ch => ch === '0' || ch === '1').map(Number).slice(-50) : [];
    }
    for (const k in v.b || {}) {
      const x = v.b[k]; if (!Array.isArray(x)) continue;
      const o = slot(A.b, k);
      [o.ln, o.lw] = sane(x[0], x[1]); [o.hn, o.hw] = sane(x[2], x[3]);
      o.rc = typeof x[4] === 'string' ? x[4].split('').filter(ch => ch === '0' || ch === '1').map(Number).slice(-50) : [];
    }
    for (const k in v.z || {}) {
      const x = v.z[k]; if (!Array.isArray(x)) continue;
      const o = slot(A.z, k);
      [o.ln, o.lw] = sane(x[0], x[1]); [o.hn, o.hw] = sane(x[2], x[3]);
    }
  }
}
function saveState() {
  const now = Date.now();
  LSset(KEY_STATE, {
    net: S.net, lossRow: S.lossRow, pausedUntil: S.pausedUntil, halted: S.halted, haltWhy: S.haltWhy,
    hourly: S.hourly.filter(t => now - t < 36e5), unkRow: S.unkRow, failRow: S.failRow, cdUntil: S.cdUntil
  });
}
function cfgSnap() {
  return { minConf: CFG.minConf, tf: CFG.tf, payout: CFG.payout, gate: CFG.gate, auto: CFG.auto, minAgree: CFG.minAgree, minScore: CFG.minScore, useHtf: CFG.useHtf, veto: CFG.veto, regimes: CFG.regimes, useCtx: CFG.useCtx, minClarity: CFG.minClarity, dyn: CFG.dyn, adopted: S.adopted };
}
function applyCfg(c, safe) {
  if (!c || typeof c !== 'object') return;
  if (Number.isFinite(+c.minConf)) CFG.minConf = clamp(+c.minConf, 50, 90);
  if ([15, 30, 60].includes(+c.tf)) CFG.tf = +c.tf;
  if (Number.isFinite(+c.payout)) CFG.payout = clamp(+c.payout, .6, .98);
  CFG.gate = c.gate !== false;
  CFG.auto = safe ? false : c.auto === true;
  if (Number.isFinite(+c.minAgree)) CFG.minAgree = Math.round(clamp(+c.minAgree, 2, 6));
  if (Number.isFinite(+c.minScore)) CFG.minScore = clamp(+c.minScore, .1, .6);
  if (typeof c.useHtf === 'boolean') CFG.useHtf = c.useHtf;
  if (typeof c.veto === 'boolean') CFG.veto = c.veto;
  if (typeof c.useCtx === 'boolean') CFG.useCtx = c.useCtx;
  if (typeof c.dyn === 'boolean') CFG.dyn = c.dyn;
  if (Number.isFinite(+c.minClarity)) CFG.minClarity = Math.round(clamp(+c.minClarity, 20, 90));
  CFG.regimes = Array.isArray(c.regimes) ? c.regimes.filter(x => RGS.includes(x)) : null;
  if (CFG.regimes && !CFG.regimes.length) CFG.regimes = null;
  if (Array.isArray(c.adopted)) S.adopted = c.adopted.filter(x => x && typeof x.k === 'string' && Number.isFinite(+x.t)).slice(0, 20).map(x => ({ t: +x.t, k: x.k.slice(0, 20) }));
}
function saveCfg() { LSset(KEY_CFG, cfgSnap()); }
function saveLog() { LSset(KEY_LOG, S.log.slice(0, 200)); }
function save() {
  LSset(KEY_LIVE, snapshot());
  LSset(KEY_META, { v: VERSION, at: Date.now() });
  saveState(); saveCfg(); saveJournal(); mirror();
}
function saveAll() { save(); saveLog(); saveJournal(true); mirror(true); }

function cleanLog(a) {
  if (!Array.isArray(a)) return [];
  const num = v => (v === null || v === undefined || !Number.isFinite(+v)) ? null : +v;
  return a.slice(0, 200).filter(x => x && typeof x === 'object' && Number.isFinite(+x.t)).map(x => ({
    t: +x.t, asset: String(x.asset || ''), dir: x.dir === 'put' ? 'put' : 'call',
    conf: Math.max(0, Math.min(100, +x.conf | 0)), entry: num(x.entry) || 0, ct: num(x.ct) || 0,
    exit: num(x.exit), win: x.win === true ? true : x.win === false ? false : null,
    auto: !!x.auto, try: !!x.try, manual: !!x.manual, proven: !!x.proven, tie: !!x.tie, failed: !!x.failed,
    voided: !!x.voided, stale: !!x.stale, unc: !!x.unc, reason: x.reason ? String(x.reason).slice(0, 80) : undefined
  }));
}

function restore() {
  applyCfg(LSget(KEY_CFG, null));
  const d = LSget(KEY_LIVE, null);
  if (d && typeof d === 'object') applySnapshot(d);
  else {
    // ترحيل من v2.4 (قراءة فقط، لا نعدّل بيانات الإصدار القديم)
    const old24 = LSget('wsnf_live', null), old2 = LSget('pobot2_live', null);
    if (old24 && typeof old24 === 'object') { applySnapshot(old24); save(); }
    else if (old2 && typeof old2 === 'object') {
      for (const a in old2) {
        const v = old2[a];
        if (!v || !Array.isArray(v.e)) continue;
        const conv = { e: [v.e[0], v.e[1], 0, 0], s: {}, b: {} };
        for (const k in v.s || {}) conv.s[k] = [v.s[k][0], v.s[k][1], 0, 0];
        for (const k in v.b || {}) conv.b[k] = [v.b[k][0], v.b[k][1], 0, 0];
        applySnapshot({ [a]: conv });
      }
      save();
    }
  }
  // v2.5.1: تصفير النتائج الحية القديمة لـ RSI وCCI وكيلتنر مرة واحدة (كانت محسوبة على المنطق القديم)
  if (!LSget('wsnf25_fix1', false)) {
    for (const a in S.A) for (const k of ['rsi', 'cci', 'kelt']) if (S.A[a].s[k]) S.A[a].s[k] = blank();
    LSset('wsnf25_fix1', true); save();
  }
  const st = LSget(KEY_STATE, null);
  if (st && typeof st === 'object') {
    const n = v => Number.isFinite(+v) ? +v : 0;
    S.net = n(st.net); S.lossRow = n(st.lossRow) | 0; S.pausedUntil = n(st.pausedUntil);
    S.halted = st.halted === true; S.haltWhy = String(st.haltWhy || '');
    S.hourly = Array.isArray(st.hourly) ? st.hourly.filter(Number.isFinite) : [];
    S.unkRow = n(st.unkRow) | 0; S.failRow = n(st.failRow) | 0; S.cdUntil = n(st.cdUntil);
  }
  S.log = cleanLog(LSget(KEY_LOG, []));
  S.journal = cleanJournal(LSget(KEY_JOURNAL, []));
  const er = LSget(KEY_ERR, []); S.errors = Array.isArray(er) ? er.slice(0, 100) : [];
  // نتائج لم تكتمل في الجلسة السابقة: لا يمكن إكمالها بعد إعادة التحميل، فتُعلَّم بدل تركها معلّقة
  S.log.forEach(e => {
    if (e.win === null && !e.tie && !e.voided && !e.failed) {
      if (e.manual) return; // تنفيذ يدوي: نتيجته على المنصة
      if (isOwn(e)) { e.voided = true; e.reason = 'إعادة تحميل الصفحة'; } else e.stale = true;
    }
  });
}
const flushNow = () => { try { saveAll(); } catch (e) {} };
window.addEventListener('beforeunload', flushNow);
window.addEventListener('pagehide', flushNow);
try { document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNow(); }); } catch (e) {}

// ================= سجل الأخطاء والتتبع =================
const ESC = s => String(s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
function logErr(code, msg, data) {
  const e = { t: Date.now(), code, msg, data: data === undefined ? null : data };
  S.errors.unshift(e);
  if (S.errors.length > 200) S.errors.pop();
  LSset(KEY_ERR, S.errors.slice(0, 100));
  try { console.warn('[wsnf]', code, msg, data === undefined ? '' : data); } catch (_) {}
}
function simTrace(name, data) {
  let raw = ''; try { raw = JSON.stringify(data); } catch (e) {}
  S.trace.unshift({ t: Date.now(), dir: 'sim', name, raw: (name + ' ' + raw).slice(0, 400) });
  if (S.trace.length > 40) S.trace.pop();
}
// صفقة محاكاة أو محاولة محاكاة: لا تُسوّى بطريقة الشمعة
const isOwn = l => !!l && !!(l.try || l.auto || l.failed || l.voided || l.manual);

// ================= المؤشرات =================
const ema = (a, n) => {
  const k = 2 / (n + 1); let e = a[0]; const o = [e];
  for (let i = 1; i < a.length; i++) { e = a[i] * k + e * (1 - k); o.push(e); }
  return o;
};
const rsi = (c, n = 14) => {
  let g = 0, l = 0;
  for (let i = c.length - n; i < c.length; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
};
const atr = (cs, n = 14) => {
  let s = 0;
  for (let i = cs.length - n; i < cs.length; i++) {
    const x = cs[i], p = cs[i - 1];
    s += Math.max(x.h - x.l, Math.abs(x.h - p.c), Math.abs(x.l - p.c));
  }
  return s / n;
};
const hl = (cs, n) => { const w = cs.slice(-n); return [Math.max(...w.map(x => x.h)), Math.min(...w.map(x => x.l))]; };
const eff = (c, n = 20) => {
  let p = 0;
  for (let i = c.length - n; i < c.length; i++) p += Math.abs(c[i] - c[i - 1]);
  return p === 0 ? 0 : Math.abs(c[c.length - 1] - c[c.length - 1 - n]) / p;
};
const body = x => Math.abs(x.c - x.o), rng = x => Math.max(x.h - x.l, 1e-12), bull = x => x.c > x.o;
const upw = x => x.h - Math.max(x.o, x.c), low = x => Math.min(x.o, x.c) - x.l;
const bb = (c, i, n = 20) => {
  const w = c.slice(i - n + 1, i + 1), m = w.reduce((a, b) => a + b) / n;
  const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / n) || 1e-12;
  return [m, sd];
};

// ================= التحقق من جودة الشموع =================
function verifyCandles(cs) {
  let gaps = 0;
  for (let i = 0; i < cs.length; i++) {
    const x = cs[i];
    if (![x.o, x.h, x.l, x.c].every(Number.isFinite)) return { ok: false, why: 'قيم غير صالحة' };
    if (x.h < x.l || x.h < Math.max(x.o, x.c) || x.l > Math.min(x.o, x.c)) return { ok: false, why: 'شمعة مشوهة' };
    if (i && x.t <= cs[i - 1].t) return { ok: false, why: 'توقيت مكرر' };
    if (i && x.t - cs[i - 1].t > CFG.tf) gaps++;
  }
  if (cs.length && gaps / cs.length > CFG.maxGap) return { ok: false, why: 'فجوات زمنية كثيرة (' + gaps + ')' };
  return { ok: true, why: 'سليمة' + (gaps ? ' (' + gaps + ' فجوة)' : '') };
}

// ================= إطار زمني أعلى =================
function resample(cs, k) {
  const out = [], s = cs.length % k;
  for (let i = s; i + k <= cs.length; i += k) {
    const g = cs.slice(i, i + k);
    out.push({ t: g[0].t, o: g[0].o, h: Math.max(...g.map(x => x.h)), l: Math.min(...g.map(x => x.l)), c: g[k - 1].c });
  }
  return out;
}
function htfTrend(cs) {
  const h = resample(cs, CFG.htfK);
  if (h.length < 25) return 0;
  const c = h.map(x => x.c), e9 = ema(c, 9), e21 = ema(c, 21), n = c.length - 1;
  return e9[n] > e21[n] ? 1 : e9[n] < e21[n] ? -1 : 0;
}

// ================= أنماط الشموع =================
function patterns(cs) {
  const n = cs.length, a = cs[n - 3], b = cs[n - 2], c = cs[n - 1];
  const down = cs[n - 5].c > b.c, upt = cs[n - 5].c < b.c;
  if (!bull(b) && bull(c) && c.o <= b.c && c.c >= b.o && body(c) > body(b)) return [1, 'ابتلاع صاعد'];
  if (bull(b) && !bull(c) && c.o >= b.c && c.c <= b.o && body(c) > body(b)) return [-1, 'ابتلاع هابط'];
  if (!bull(a) && body(a) > .5 * rng(a) && body(b) < .3 * rng(b) && bull(c) && c.c > (a.o + a.c) / 2) return [1, 'نجمة الصباح'];
  if (bull(a) && body(a) > .5 * rng(a) && body(b) < .3 * rng(b) && !bull(c) && c.c < (a.o + a.c) / 2) return [-1, 'نجمة المساء'];
  if (body(c) < .35 * rng(c) && low(c) >= 2 * body(c) && upw(c) < .25 * rng(c) && down) return [.8, 'مطرقة'];
  if (body(c) < .35 * rng(c) && upw(c) >= 2 * body(c) && low(c) < .25 * rng(c) && upt) return [-.8, 'نجمة الرماية'];
  if ([a, b, c].every(x => bull(x) && body(x) > .5 * rng(x)) && a.c < b.c && b.c < c.c) return [.6, 'ثلاثة جنود'];
  if ([a, b, c].every(x => !bull(x) && body(x) > .5 * rng(x)) && a.c > b.c && b.c > c.c) return [-.6, 'ثلاثة غربان'];
  return [0, ''];
}
function levels(cs, n = 60) {
  const seg = cs.slice(-n, -3), hi = [], lo = [];
  for (let i = 2; i < seg.length - 2; i++) {
    const w = seg.slice(i - 2, i + 3);
    if (seg[i].h === Math.max(...w.map(x => x.h))) hi.push(seg[i].h);
    if (seg[i].l === Math.min(...w.map(x => x.l))) lo.push(seg[i].l);
  }
  return [lo, hi];
}
function heikin(cs) {
  const w = cs.slice(-30), out = [];
  let po = w[0].o, pc = w[0].c;
  for (const x of w) {
    const c = (x.o + x.h + x.l + x.c) / 4, o = (po + pc) / 2;
    out.push({ o, c, h: Math.max(x.h, o, c), l: Math.min(x.l, o, c) });
    po = o; pc = c;
  }
  return out;
}

// ================= الاستراتيجيات (17) =================
const NM = {
  trend: 'ترند EMA', rsi: 'RSI', boll: 'بولينجر', macd: 'MACD', stoch: 'ستوكاستك',
  candles: 'أنماط الشموع', sr: 'دعم/مقاومة', break: 'اختراق', ha: 'هايكن آيش', cci: 'CCI',
  willr: 'ويليامز %R', mom: 'الزخم', lin: 'انحدار خطي', streak: 'إنهاك التتابع',
  pin: 'شمعة الرفض', squeeze: 'انفجار الانضغاط', kelt: 'كيلتنر'
};
// v2.5: مجموعات المؤشرات المترابطة. المؤشرات داخل المجموعة تقيس سلوكًا متقاربًا فلا تُعدّ أصواتًا مستقلة.
const GRP = {
  trend: 'T', macd: 'T', mom: 'T', lin: 'T', ha: 'T',
  rsi: 'O', stoch: 'O', cci: 'O', willr: 'O', boll: 'O', kelt: 'O',
  break: 'K', squeeze: 'K', candles: 'P', pin: 'P', sr: 'S', streak: 'X'
};
const STR = [
  ['trend', 'T', (cs, c) => { const e9 = ema(c, 9), e21 = ema(c, 21), e50 = ema(c, 50), n = c.length - 1; return [clamp(((e9[n] > e21[n]) + (e21[n] > e50[n]) + (e9[n] > e9[n - 3]) - 1.5) / 1.5), '']; }],
  // v2.5.1: لا ارتداد ضد اتجاه قوي + لا دخول إلا بعد أن تبدأ الشمعة بالانعكاس فعلًا (تأكيد)
  ['rsi', 'R', (cs, c, X) => {
    const l = cs[cs.length - 1];
    if (eff(c) > .35) return [0, ''];
    if (X.rsi < 30 && bull(l)) return [X.rsi < 25 ? 1 : .6, ''];
    if (X.rsi > 70 && !bull(l)) return [X.rsi > 75 ? -1 : -.6, ''];
    return [0, ''];
  }],
  ['boll', 'R', (cs, c) => { const [m, sd] = bb(c, c.length - 1), z = (c[c.length - 1] - m) / sd; return [z < -2 ? 1 : z > 2 ? -1 : z < -1.5 ? .4 : z > 1.5 ? -.4 : 0, '']; }],
  ['macd', 'T', (cs, c) => {
    const e12 = ema(c, 12), e26 = ema(c, 26), m = e12.map((v, i) => v - e26[i]), sg = ema(m, 9), n = m.length - 1;
    const h = m[n] - sg[n], hp = m[n - 1] - sg[n - 1];
    return [h > 0 ? (h > hp ? .8 : .3) : (h < hp ? -.8 : -.3), ''];
  }],
  ['stoch', 'R', cs => { const [h, l] = hl(cs, 14), k = h === l ? 50 : (cs[cs.length - 1].c - l) / (h - l) * 100; return [k < 15 ? 1 : k > 85 ? -1 : 0, '']; }],
  ['candles', 'N', cs => { const [v, n] = patterns(cs); return [v, n]; }],
  ['sr', 'R', (cs, c, X) => {
    const [lo, hi] = levels(cs), p = c[c.length - 1], l = cs[cs.length - 1];
    if (lo.some(v => Math.abs(p - v) < .5 * X.atr) && low(l) > body(l)) return [.9, 'ارتداد دعم'];
    if (hi.some(v => Math.abs(p - v) < .5 * X.atr) && upw(l) > body(l)) return [-.9, 'ارتداد مقاومة'];
    return [0, ''];
  }],
  ['break', 'T', (cs, c) => { const w = cs.slice(-21, -1), hh = Math.max(...w.map(x => x.h)), ll = Math.min(...w.map(x => x.l)), p = c[c.length - 1]; return [p > hh ? .9 : p < ll ? -.9 : 0, '']; }],
  ['ha', 'T', cs => {
    const h = heikin(cs), a = h.slice(-3);
    if (a.every(x => x.c > x.o)) return [Math.abs(a[2].l - Math.min(a[2].o, a[2].c)) < 1e-12 ? .9 : .6, ''];
    if (a.every(x => x.c < x.o)) return [Math.abs(a[2].h - Math.max(a[2].o, a[2].c)) < 1e-12 ? -.9 : -.6, ''];
    return [0, ''];
  }],
  ['cci', 'R', cs => {
    const w = cs.slice(-20).map(x => (x.h + x.l + x.c) / 3), m = w.reduce((a, b) => a + b) / 20;
    const md = w.reduce((a, b) => a + Math.abs(b - m), 0) / 20 || 1e-12, v = (w[19] - m) / (.015 * md);
    // v2.5.1: نفس فكرة RSI: فلتر اتجاه قوي + تأكيد انعكاس الشمعة
    const l = cs[cs.length - 1];
    if (eff(cs.map(x => x.c)) > .35) return [0, ''];
    if (v < -100 && bull(l)) return [v < -150 ? 1 : .6, ''];
    if (v > 100 && !bull(l)) return [v > 150 ? -1 : -.6, ''];
    return [0, ''];
  }],
  ['willr', 'R', cs => { const [h, l] = hl(cs, 14), v = h === l ? -50 : (h - cs[cs.length - 1].c) / (h - l) * -100; return [v < -90 ? 1 : v < -80 ? .5 : v > -10 ? -1 : v > -20 ? -.5 : 0, '']; }],
  ['mom', 'T', (cs, c, X) => [clamp((c[c.length - 1] - c[c.length - 6]) / (X.atr * 2.5)), '']],
  ['lin', 'T', (cs, c, X) => {
    const w = c.slice(-20), n = 20, mx = 9.5, my = w.reduce((a, b) => a + b) / n;
    let num = 0, den = 0;
    w.forEach((v, i) => { num += (i - mx) * (v - my); den += (i - mx) ** 2; });
    return [clamp(num / den / X.atr * 3), ''];
  }],
  ['streak', 'R', cs => {
    let k = 0, dir = bull(cs[cs.length - 1]);
    for (let i = cs.length - 1; i >= 0 && bull(cs[i]) === dir; i--) k++;
    return [k >= 5 ? (dir ? -.9 : .9) : k === 4 ? (dir ? -.6 : .6) : 0, k >= 4 ? 'تتابع ' + k : ''];
  }],
  ['pin', 'N', cs => {
    const x = cs[cs.length - 1], r = rng(x);
    if (low(x) >= 2 * body(x) && low(x) > .5 * r && (x.c - x.l) / r > .6) return [.7, 'رفض سفلي'];
    if (upw(x) >= 2 * body(x) && upw(x) > .5 * r && (x.h - x.c) / r > .6) return [-.7, 'رفض علوي'];
    return [0, ''];
  }],
  ['squeeze', 'T', (cs, c) => {
    const n = c.length - 1, ws = [];
    for (let i = n - 49; i <= n; i++) { const [, sd] = bb(c, i); ws.push(sd); }
    const cur = ws[ws.length - 1], rank = ws.filter(v => v < cur).length / ws.length;
    const [m, sd] = bb(c, n);
    if (rank <= .25) {
      if (c[n] > m + 2 * sd) return [.8, 'انضغاط واختراق ↑'];
      if (c[n] < m - 2 * sd) return [-.8, 'انضغاط واختراق ↓'];
    }
    return [0, ''];
  }],
  // v2.5.1: كيلتنر — فلتر اتجاه قوي + تأكيد انعكاس الشمعة (الحد 1.5 ATR بدل 2 لأن التأكيد يقلل الإشارات الكاذبة)
  ['kelt', 'R', (cs, c, X) => {
    const e = ema(c, 20), n = c.length - 1, l = cs[n];
    if (eff(c) > .35) return [0, ''];
    if (c[n] > e[n] + 1.5 * X.atr && !bull(l)) return [-.7, ''];
    if (c[n] < e[n] - 1.5 * X.atr && bull(l)) return [.7, ''];
    return [0, ''];
  }]
];
const SK = STR.map(s => s[0]);

// ================= v3.2: نسخ محسّنة للاستراتيجيات + اختبار قبل الاعتماد =================
// كل استراتيجية معدّلة تعمل بجانب نسختها القديمة (الأصل لا يُحذف). النسختان تُسجَّلان على نفس الشموع:
// القديمة تحت المفتاح k والمعدّلة تحت k+. لا تُستخدم المعدّلة في القرار إلا إذا أثبتت تفوقًا (evalVariants)، وتُعاد للقديمة إن تدهورت.
const KEY_SV = 'wsnf25_sv';
const IMP = {
  // بولينجر: لا ارتداد ضد اتجاه قوي + تأكيد انعكاس الشمعة (كان يرتد بلا تأكيد وبلا فلتر اتجاه)
  boll: (cs, c) => {
    const n = c.length - 1, [m, sd] = bb(c, n), z = (c[n] - m) / sd, l = cs[n];
    if (eff(c) > .35) return [0, ''];
    if (z < -1.5 && bull(l)) return [z < -2 ? 1 : .4, ''];
    if (z > 1.5 && !bull(l)) return [z > 2 ? -1 : -.4, ''];
    return [0, ''];
  },
  // MACD: منطقة ميتة (تقاطع بلا قوة نسبة إلى ATR لا يُعدّ صوتًا) + تخفيض الصوت المعاكس لجهة خط MACD
  macd: (cs, c, X) => {
    const e12 = ema(c, 12), e26 = ema(c, 26), m = e12.map((v, i) => v - e26[i]), sg = ema(m, 9), n = m.length - 1;
    const h = m[n] - sg[n], hp = m[n - 1] - sg[n - 1];
    if (Math.abs(h) / X.atr < .03) return [0, ''];
    const up = h > 0, grow = up ? h > hp : h < hp;
    let v = grow ? .8 : .3;
    if ((up && m[n] < 0) || (!up && m[n] > 0)) v *= .7;
    return [up ? v : -v, ''];
  },
  // ستوكاستك: يحتاج تقاطع %K/%D داخل منطقة التشبع (لا مجرد الوصول إليها) + فلتر اتجاه قوي
  stoch: (cs, c) => {
    if (eff(c) > .35) return [0, ''];
    const n = cs.length - 1;
    const kAt = i => { const w = cs.slice(i - 13, i + 1), h = Math.max(...w.map(x => x.h)), l = Math.min(...w.map(x => x.l)); return h === l ? 50 : (cs[i].c - l) / (h - l) * 100; };
    const k0 = kAt(n), k1 = kAt(n - 1), k2 = kAt(n - 2), k3 = kAt(n - 3), d0 = (k0 + k1 + k2) / 3, d1 = (k1 + k2 + k3) / 3;
    if (k0 < 20 && k0 > d0 && k1 <= d1) return [k0 < 10 ? 1 : .8, ''];
    if (k0 > 80 && k0 < d0 && k1 >= d1) return [k0 > 90 ? -1 : -.8, ''];
    if (k0 < 15 && bull(cs[n])) return [.5, ''];
    if (k0 > 85 && !bull(cs[n])) return [-.5, ''];
    return [0, ''];
  },
  // ويليامز %R: نفس منطق RSI (فلتر اتجاه + تأكيد انعكاس)
  willr: (cs, c) => {
    if (eff(c) > .35) return [0, ''];
    const l = cs[cs.length - 1], [h, lo] = hl(cs, 14), v = h === lo ? -50 : (h - l.c) / (h - lo) * -100;
    if (v < -90 && bull(l)) return [1, ''];
    if (v < -80 && bull(l)) return [.5, ''];
    if (v > -10 && !bull(l)) return [-1, ''];
    if (v > -20 && !bull(l)) return [-.5, ''];
    return [0, ''];
  },
  // اختراق: إغلاق خلف القمة/القاع بهامش 0.1 ATR + جسم ≥40% من المدى + ذيل رفض ≤40% (يستبعد الاختراق الوهمي بذيل)
  break: (cs, c, X) => {
    const w = cs.slice(-21, -1), hh = Math.max(...w.map(x => x.h)), ll = Math.min(...w.map(x => x.l)), l = cs[cs.length - 1], p = c[c.length - 1];
    if (p > hh + .1 * X.atr && body(l) >= .4 * rng(l) && upw(l) <= .4 * rng(l)) return [.9, ''];
    if (p < ll - .1 * X.atr && body(l) >= .4 * rng(l) && low(l) <= .4 * rng(l)) return [-.9, ''];
    return [0, ''];
  },
  // إنهاك التتابع: لا يُعاكس التتابع إلا إذا ضعف جسم آخر شمعة (الزخم بدأ يخبو) وإلا فالاتجاه مستمر
  streak: cs => {
    const l = cs[cs.length - 1], p = cs[cs.length - 2], dir = bull(l);
    let k = 0;
    for (let i = cs.length - 1; i >= 0 && bull(cs[i]) === dir; i--) k++;
    if (k < 4 || !(body(l) < .8 * body(p))) return [0, ''];
    return [k >= 5 ? (dir ? -.9 : .9) : (dir ? -.6 : .6), 'تتابع ' + k];
  }
};
const IMPK = Object.keys(IMP);
const vk = k => (IMP[k] && S.sv && S.sv[k] === 'new') ? k + '+' : k;
function loadSV() {
  const o = LSget(KEY_SV, {});
  S.sv = {}; S.svLog = [];
  for (const k of IMPK) S.sv[k] = o && o.sv && o.sv[k] === 'new' ? 'new' : 'old';
  if (o && Array.isArray(o.log)) S.svLog = o.log.slice(0, 20);
}
function poolS(key) {
  const o = { ln: 0, lw: 0, hn: 0, hw: 0 };
  for (const a in S.A) {
    if (tfOfKey(a) !== CFG.tf) continue;
    const x = S.A[a].s[key];
    if (x) { o.ln += x.ln; o.lw += x.lw; o.hn += x.hn; o.hw += x.hw; }
  }
  return o;
}
// حكم المقارنة بين القديمة والمعدّلة: النتائج الحية إن كفت (≥100 لكل منهما) وإلا التاريخية. اختبار نسبتين (غير مقترن = متحفظ لأن العينتين متداخلتان)
function variantVerdict(k) {
  const a = poolS(k), b = poolS(k + '+');
  let src = 'حي', no = a.ln, wo = a.lw, nn = b.ln, wn = b.lw;
  if (no < 100 || nn < 100) { src = 'تاريخي'; no = a.hn; wo = a.hw; nn = b.hn; wn = b.hw; }
  const eo = Math.max(wo, no - wo), en = Math.max(wn, nn - wn); // الدقة الفعلية: المعكوسة المثبتة تُستخدم معكوسة كما في grade()
  const base = { k, src, no, wo: eo, nn, wn: en };
  if (no < 100 || nn < 100) return { ...base, ok: false, better: false, worse: false, why: 'عينة غير كافية (' + no + ' / ' + nn + ' من 100)' };
  const po = eo / no, pn = en / nn, se = Math.sqrt(po * (1 - po) / no + pn * (1 - pn) / nn) || 1e-9, z = (pn - po) / se;
  const cov = nn / no;
  const better = pn - po >= .01 && z >= 1 && cov >= .25;
  const worse = z <= -1;
  const why = better ? 'أفضل بفارق ' + ((pn - po) * 100).toFixed(1) + '% (z=' + z.toFixed(2) + ')' : worse ? 'أسوأ (z=' + z.toFixed(2) + ')' : cov < .25 && pn > po ? 'أدق لكنها تقلل التغطية كثيرًا (' + Math.round(cov * 100) + '%)' : 'لا فرق مثبت (z=' + z.toFixed(2) + ')';
  return { ...base, ok: true, po, pn, z, cov, better, worse, why };
}
function evalVariants() {
  let ch = false;
  for (const k of IMPK) {
    const v = variantVerdict(k), cur = S.sv[k] || 'old';
    if (cur === 'old' && v.ok && v.better) { S.sv[k] = 'new'; ch = true; S.svLog.unshift({ t: Date.now(), k, to: 'new', why: v.why }); }
    else if (cur === 'new' && v.ok && v.worse) { S.sv[k] = 'old'; ch = true; S.svLog.unshift({ t: Date.now(), k, to: 'old', why: v.why }); }
  }
  if (ch) { S.svLog = S.svLog.slice(0, 20); LSset(KEY_SV, { sv: S.sv, log: S.svLog }); }
  return ch;
}

// ================= v3.2: مقارنة الاستراتيجيات حسب الأصل × الحالة × المدة =================
const RGC = { 'اتجاهي': 't', 'عرضي': 'r', 'مختلط': 'm', 'متقلب': 'v' };
const qk = (k, h, rg) => 'q|' + k + '|' + h + '|' + (RGC[rg] || 'x');
// خلية = (استراتيجية، مدة بالشمعات، حالة سوق) على أصل واحد؛ إن قلّت العينة تُجمع من بقية الأصول (نفس الإطار الزمني)
function cellOf(A, k, h, rg) {
  const rs = rg && rg !== '-' ? [rg] : RGS;
  let n = 0, w = 0, gn = 0, gw = 0;
  for (const r of rs) {
    const key = qk(k, h, r), z = A.z[key];
    if (z) { n += z.ln + z.hn; w += z.lw + z.hw; }
    const g = zAgg(key); gn += g.ln + g.hn; gw += g.lw + g.hw;
  }
  return n >= CFG.minLocal ? { n, w, src: 'محلي' } : gn > n ? { n: gn, w: gw, src: 'عام' } : { n, w, src: 'محلي' };
}
// أنسب مدة لهذه الحالة: تجمع خلايا الاستراتيجيات المصوّتة مع الاتجاه (المعكوسة تُحسب معكوسة) وتختار أعلى حد أدنى للدقة
function bestHz(A, rg, items, dir) {
  if (!A || S.loading) return null;
  const act = items.filter(x => x.v * dir > 0);
  let res = null;
  for (const h of HZ) {
    let n = 0, w = 0;
    for (const x of act) { const c = cellOf(A, x.ak, h, rg); n += c.n; w += x.inv ? c.n - c.w : c.w; }
    if (n < 60) continue;
    const lb = wil(n, w, 1.28);
    if (!res || lb > res.lb) res = { h, lb, acc: w / n, n };
  }
  return res;
}
function stratMatrix(asset, rg) {
  const A = getA(asset), be = BE();
  return STR.map(([k, kind]) => {
    const ak = vk(k), cells = HZ.map(h => cellOf(A, ak, h, rg));
    const lbs = cells.map(c => c.n >= 30 ? wil(c.n, c.w, CFG.zStrat) : -1);
    const bi = lbs.reduce((b, x, i) => x > lbs[b] ? i : b, 0);
    const c1 = cells[0], p1 = c1.n ? c1.w / c1.n : 0;
    let st = 'غير مثبتة', cls = 'm';
    if (lbs[0] > be) { st = 'مختارة للمدة الحالية'; cls = 'u'; }
    else if (lbs[bi] > be) { st = 'تصلح لمدة ' + hzLabel(HZ[bi]); cls = 'g'; }
    else if (c1.n >= 30 && wil(c1.n, c1.n - c1.w, CFG.zStrat) > be) { st = 'عكسية'; cls = 'g'; }
    else if (c1.n >= 80 && p1 < .47) { st = 'مستبعدة'; cls = 'd'; }
    return { k, ak, cells, bi: lbs[bi] > -1 ? bi : -1, st, cls };
  });
}

// ================= v3.2: عزل الأدلة المتشابهة (ترابط فعلي لا مجموعات ثابتة فقط) =================
// ρ بين مؤشرين = 2×(نسبة اتفاق إشارتيهما عند نشاطهما معًا) − 1. المجموعات الثابتة تُدمج ديناميكيًا إذا ثبت تطابق مجموعتين مختلفتين عمليًا.
const CL = { map: {}, n: 0 };
function pairRho(a, b) {
  const o = S.corr[a + '|' + b] || S.corr[b + '|' + a];
  if (!o || o[0] < 100) return null;
  return 2 * (o[1] / o[0]) - 1;
}
function rebuildClusters() {
  const par = {};
  const gl = [...new Set(SK.map(k => GRP[k]))];
  gl.forEach(g => { par[g] = g; });
  const find = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  // دمج مجموعتين ثابتتين فقط إذا قيس ≥3 أزواج بينهما ومتوسط ρ ≥ 0.6 (زوج واحد متطابق لا يكفي)
  const agg = {};
  for (let i = 0; i < SK.length; i++) for (let j = i + 1; j < SK.length; j++) {
    const a = SK[i], b = SK[j];
    if (GRP[a] === GRP[b]) continue;
    const r = pairRho(a, b);
    if (r === null) continue;
    const key = [GRP[a], GRP[b]].sort().join('');
    const o = agg[key] || (agg[key] = { n: 0, s: 0, a: GRP[a], b: GRP[b] });
    o.n++; o.s += r;
  }
  for (const key in agg) { const o = agg[key]; if (o.n >= 3 && o.s / o.n >= .6) par[find(o.a)] = find(o.b); }
  CL.map = {};
  SK.forEach(k => { CL.map[k] = find(GRP[k]); });
  CL.n = (CL.n || 0) + 1;
}
const clusterOf = k => (CFG.dyn !== false && CL.map[k]) || GRP[k];


// ---- مراقب الترابط بين الاستراتيجيات (تشخيص) ----
function trackCorr(raw) {
  const act = SK.filter(k => Math.abs(raw[k] || 0) >= .5);
  for (let i = 0; i < act.length; i++) for (let j = i + 1; j < act.length; j++) {
    const key = act[i] + '|' + act[j], o = S.corr[key] || (S.corr[key] = [0, 0]);
    o[0]++; if (raw[act[i]] * raw[act[j]] > 0) o[1]++;
  }
}
function corrReport(minN = 100, thr = .8) {
  const out = [];
  for (const k in S.corr) {
    const [n, a] = S.corr[k];
    if (n < minN) continue;
    const r = a / n;
    if (r >= thr || r <= 1 - thr) out.push({ pair: k, n, agree: +r.toFixed(3), sameGroup: GRP[k.split('|')[0]] === GRP[k.split('|')[1]] });
  }
  return out.sort((x, y) => Math.abs(y.agree - .5) - Math.abs(x.agree - .5));
}
// تخفيف التصويت المكرر: داخل كل عنقود تُحسب الأدلة المستقلة الفعلية n_eff = m / (1 + (m-1)·ρ̄) ويُضرب كل وزن بـ √n_eff / m.
// مؤشران متطابقان (ρ=1) لا يزيدان الدليل عن مؤشر واحد؛ مستقلان (ρ=0) يعطيان √2 كالسابق. ρ̄ تُقاس من البيانات (≥100 حالة) وإلا افتراض 0.3 داخل المجموعة الثابتة.
function dampen(items) {
  const byC = {};
  items.forEach(x => { x.g0 = GRP[x.k]; x.g = clusterOf(x.k); (byC[x.g] = byC[x.g] || []).push(x); });
  for (const g in byC) {
    const m = byC[g], cnt = m.length;
    if (cnt < 2) continue;
    if (CFG.dyn === false) { m.forEach(x => { x.w = x.w / Math.sqrt(cnt); }); continue; }
    let sum = 0, np = 0;
    for (let i = 0; i < cnt; i++) for (let j = i + 1; j < cnt; j++) {
      const r = pairRho(m[i].k, m[j].k);
      sum += Math.max(0, r !== null ? r : (GRP[m[i].k] === GRP[m[j].k] ? .3 : 0)); np++;
    }
    const rho = sum / np, neff = cnt / (1 + (cnt - 1) * rho), f = Math.sqrt(neff) / cnt;
    m.forEach(x => { x.w = x.w * f; });
  }
  return items;
}

// ================= التعلّم: محلي لكل أصل + عام عبر كل الأصول =================
// بيانات التاريخ (hn/hw) = تدريب فقط. النتائج الحية (ln/lw) = اختبار خارج العينة، وهي الوحيدة التي تُستخدم في البوابة.
function statOf(A, k) {
  // أثناء إعادة تشغيل التاريخ نستخدم إحصاء التاريخ المتراكم حتى تلك اللحظة فقط (بدون نتائج حية أو أصول أخرى): منع تسرب المستقبل
  const local = A.s[k] ? (S.loading ? [A.s[k].hn, A.s[k].hw] : nw(A.s[k])) : [0, 0];
  if (S.loading || local[0] >= CFG.minLocal) return { n: local[0], w: local[1], src: 'محلي' };
  let gn = 0, gw = 0;
  for (const a in S.A) {
    if (tfOfKey(a) !== CFG.tf) continue;
    const o = S.A[a].s[k];
    if (o) { const [x, y] = nw(o); gn += x; gw += y; }
  }
  if (gn > local[0]) return { n: gn, w: gw, src: 'عام' };
  return { n: local[0], w: local[1], src: 'محلي' };
}
// تقييم عيّنة (n, w) → وزن ونمط. gp = متوسط أداء الاستراتيجية على بقية الأصول (يُنكمش نحوه بدل 50%)
function grade(n, w, src, gp = .5) {
  if (!n) return { w: .25, mode: 'جديدة', inv: false, p: .5, n: 0, src, lb: 0 };
  const p = w / n;
  const lb = wil(n, w, CFG.zStrat);
  if (n < CFG.minLocal) return { w: .25, mode: 'تتعلم', inv: false, p, n, src, lb };
  const ps = (w + CFG.prior * gp) / (n + CFG.prior); // انكماش نحو أداء بقية الأصول للعينات الصغيرة
  if (n >= CFG.minTrust && lb > BE()) return { w: Math.min(1.2, .4 + (ps - .5) * 4), mode: 'رابحة', inv: false, p, n, src, lb };
  if (n >= CFG.minTrust && wil(n, n - w, CFG.zStrat) > BE()) return { w: Math.min(1.2, .4 + (.5 - ps) * 4), mode: 'عكسية', inv: true, p, n, src, lb };
  if (n >= 80 && p < .47) return { w: 0, mode: 'معطلة', inv: false, p, n, src, lb };
  return { w: .2, mode: 'محايدة', inv: false, p, n, src, lb };
}
// متوسط أداء الاستراتيجية (أو مفتاح نظام) على الأصول الأخرى، بنفس الإطار الزمني
function gpOf(A, k) {
  if (S.loading) return .5;
  let gn = 0, gw = 0;
  for (const a in S.A) {
    if (S.A[a] === A || tfOfKey(a) !== CFG.tf) continue;
    const o = S.A[a].s[k];
    if (o) { const [x, y] = nw(o); gn += x; gw += y; }
  }
  return gn >= 100 ? gw / gn : .5;
}
function wt(A, k) {
  const { n, w, src } = statOf(A, k);
  return grade(n, w, src, src === 'محلي' ? gpOf(A, k) : .5);
}
// وزن حسب حالة السوق الحالية: إذا توفرت عيّنة كافية لهذه الاستراتيجية في هذه الحالة على هذا الأصل، تُحكم عليها وحدها
function wtR(A, k, regime) {
  let W = wt(A, k);
  if (regime && regime !== '-') {
    const rk = k + '#' + regime, s = statOf(A, rk);
    if (s.n >= CFG.minRegime) {
      const R = grade(s.n, s.w, s.src, s.src === 'محلي' ? gpOf(A, rk) : .5);
      R.rg = true;
      W = R;
    }
  }
  return drift(A, k, W);
}
// كشف التدهور: آخر driftN نتيجة حية. إن كان الحد الأعلى لدقتها الفعلية أقل من التعادل يُخفَّض الوزن إلى الربع حتى تتعافى
function drift(A, k, W) {
  if (S.loading) return W;
  const o = A.s[k], rc = o && o.rc ? o.rc : [], N = CFG.driftN;
  if (rc.length < N) return W;
  const ws = rc.slice(-N).reduce((a, x) => a + x, 0);
  const ew = W.inv ? N - ws : ws;
  W.rp = ew / N;
  const upper = 1 - wil(N, N - ew, CFG.driftZ);
  if ((W.mode === 'رابحة' || W.mode === 'عكسية') && upper < BE()) return { ...W, w: W.w * .25, mode: 'متدهورة' };
  return W;
}
const bucket = conf => String(Math.floor(conf / 5) * 5);
function bestBucket(A) {
  let best = null;
  for (const k in A.b) {
    const n = A.b[k].ln, w = A.b[k].lw;
    if (n < CFG.minLive) continue;
    const lb = wil(n, w, CFG.gateZ);
    if (!best || lb > best.lb) best = { k, lb, n, acc: w / n };
  }
  return best;
}

// ================= v2.7: المختبر (جودة البيانات • الإشارات الكاذبة • المدد • التجارب • الذاكرة) =================
const HZ = [1, 2, 3, 5];
const RGS = ['اتجاهي', 'عرضي', 'مختلط', 'متقلب'];
const VETOS = ['قفزة سعرية', 'ملاحقة متأخرة', 'تذبذب الإشارة', 'مقاومة قريبة', 'دعم قريب', 'مؤشر واحد مهيمن'];
const KEY_JOURNAL = 'wsnf25_journal';
const DEFAULTS = { minAgree: 3, minConf: 65, minScore: .15, useHtf: true, veto: true, regimes: null, useCtx: true, minClarity: 45, dyn: true };
const hzLabel = h => { const s = h * CFG.tf; return s < 60 || s % 60 ? s + ' ث' : s / 60 + ' د'; };
// كل تجربة = تعديل واحد على قواعد القرار. تُختبر بصفقات ظلّية على نفس الشموع دون أن تؤثر على القرار الفعلي.
const EXPS = [
  { k: 'base', n: 'الأساس (الإعداد الحالي)', o: {} },
  { k: 'noveto', n: 'بدون فلتر الإشارات الكاذبة', o: { veto: false } },
  { k: 'agree4', n: 'اتفاق 4 مجموعات فأكثر', o: { minAgree: 4 } },
  { k: 'conf72', n: 'ثقة 72% فأكثر', o: { minConf: 72 } },
  { k: 'score25', n: 'قوة إشارة أعلى (> 0.25)', o: { minScore: .25 } },
  { k: 'nohtf', n: 'بدون فلتر الإطار الأعلى', o: { useHtf: false } },
  { k: 'trend', n: 'الأسواق الاتجاهية فقط', o: { regimes: ['اتجاهي'] } },
  { k: 'static', n: 'تجميع ثابت للمؤشرات (بدون دمج ديناميكي)', o: { dyn: false } },
  { k: 'noctx', n: 'بدون فلتر حالة السوق', o: { useCtx: false } },
  { k: 'clar60', n: 'وضوح حالة السوق 60% فأكثر', o: { minClarity: 60 } },
  { k: 'notvol', n: 'استبعاد السوق المتقلب', o: { regimes: ['اتجاهي', 'عرضي', 'مختلط'] } },
  { k: 'forced', n: 'مرجع: بدون امتناع (كل شمعة)', o: { force: true, minConf: 0 }, ref: true }
];

// قرار الدخول من مكونات التحليل + الإعدادات. الامتناع هو الأصل: لا إشارة إلا إذا اجتازت كل الشروط.
function decide(r, o) {
  const cfg = o ? { ...CFG, ...o } : CFG;
  if (!r || !r.comp || !r.sd) return { ok: false, why: [(r && r.why) || 'لا بيانات كافية'] };
  if (cfg.force) return { ok: true, why: [] };
  const why = [];
  if (Math.abs(r.sc) <= cfg.minScore) why.push('قوة الإشارة ضعيفة');
  const ag = cfg.dyn === false && r.agreeS !== undefined ? r.agreeS : r.agree;
  if (ag < cfg.minAgree) why.push('اتفاق ' + ag + ' من ' + cfg.minAgree + ' مجموعات مستقلة');
  if (r.opp >= .3) why.push('أصوات معاكسة قوية');
  if (cfg.useHtf && !r.htfOK) why.push('عكس اتجاه الإطار الأعلى');
  if (cfg.veto && r.vetoes.length) why.push('إشارة كاذبة محتملة: ' + r.vetoes.join('، '));
  if (cfg.regimes && !cfg.regimes.includes(r.regime)) why.push('حالة السوق (' + r.regime + ') غير مناسبة');
  const cp = ctxPermit(r.ctx, r.sd, cfg);
  if (!cp.ok) why.push(cp.why);
  return { ok: !why.length, why };
}

// ================= v3.1: فهم حالة السوق (قبل أي توصية) =================
// يُحسب قبل التصويت: أطر متعددة + هيكل القمم/القيعان + ADX + الزخم + التذبذب + انعكاس + اختراق صالح/وهمي.
// الناتج: kind/label (الحالة)، clarity (الوضوح 0-100)، allow (الاتجاه الوحيد المسموح: 1 / -1 / 0 = لا دخول).
// كله على شموع مغلقة فقط (القمم/القيعان تحتاج شمعتين تأكيدًا بعدها فلا نظر للمستقبل).
const CTX_LBL = { trend: 'اتجاه', range: 'عرضي (نطاق)', valid: 'اختراق صالح', fake: 'اختراق وهمي', rev: 'انعكاس', weak: 'اتجاه ضعيف', squeeze: 'انضغاط', chaos: 'فوضوي', unclear: 'غير واضح' };
const CTX_KINDS = ['trend', 'range', 'valid', 'fake', 'rev', 'weak', 'squeeze', 'chaos', 'unclear'];
function swings(cs, k = 2) {
  const hi = [], lo = [];
  for (let i = k; i < cs.length - k; i++) {
    let h = true, l = true;
    for (let j = 1; j <= k; j++) {
      if (!(cs[i].h > cs[i - j].h && cs[i].h >= cs[i + j].h)) h = false;
      if (!(cs[i].l < cs[i - j].l && cs[i].l <= cs[i + j].l)) l = false;
    }
    if (h) hi.push({ i, p: cs[i].h });
    if (l) lo.push({ i, p: cs[i].l });
  }
  return { hi, lo };
}
// هيكل السوق: قمم أعلى + قيعان أعلى = +1 ، قمم أدنى + قيعان أدنى = -1 ، متضارب = 0
function structOf(sw) {
  if (sw.hi.length < 2 || sw.lo.length < 2) return 0;
  const h1 = sw.hi[sw.hi.length - 2].p, h2 = sw.hi[sw.hi.length - 1].p, l1 = sw.lo[sw.lo.length - 2].p, l2 = sw.lo[sw.lo.length - 1].p;
  return (h2 > h1 ? .5 : h2 < h1 ? -.5 : 0) + (l2 > l1 ? .5 : l2 < l1 ? -.5 : 0);
}
function adxOf(cs, n = 14) {
  if (cs.length < 2 * n + 2) return null;
  const pd = [], md = [], tr = [];
  for (let i = 1; i < cs.length; i++) {
    const x = cs[i], p = cs[i - 1], up = x.h - p.h, dn = p.l - x.l;
    pd.push(up > dn && up > 0 ? up : 0); md.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(x.h - x.l, Math.abs(x.h - p.c), Math.abs(x.l - p.c)));
  }
  let sp = 0, sm = 0, st = 0;
  for (let i = 0; i < n; i++) { sp += pd[i]; sm += md[i]; st += tr[i]; }
  const dx = []; let dip = 0, dim = 0;
  for (let i = n; i < pd.length; i++) {
    sp = sp - sp / n + pd[i]; sm = sm - sm / n + md[i]; st = st - st / n + tr[i];
    dip = st ? 100 * sp / st : 0; dim = st ? 100 * sm / st : 0;
    const s = dip + dim; dx.push(s ? 100 * Math.abs(dip - dim) / s : 0);
  }
  if (dx.length < n) return null;
  let a = dx.slice(0, n).reduce((x, y) => x + y, 0) / n;
  for (let i = n; i < dx.length; i++) a = (a * (n - 1) + dx[i]) / n;
  return { adx: a, dip, dim };
}
const rsiAt = (c, i, n = 14) => {
  let g = 0, l = 0;
  for (let k = i - n + 1; k <= i; k++) { const d = c[k] - c[k - 1]; if (d > 0) g += d; else l -= d; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
};
// اتجاه إطار واحد: EMA سريع/بطيء + ميل + هيكل القمم والقيعان
function frameTrend(cs, fa, sl, minLen) {
  if (!cs || cs.length < minLen) return null;
  const c = cs.map(x => x.c), n = c.length - 1, ef = ema(c, fa), es = ema(c, sl);
  const a = atr(cs, Math.min(14, n - 1)) || 1e-12;
  const sep = (ef[n] - es[n]) / a, slope = (es[n] - es[n - 4]) / a, st = structOf(swings(cs, 2));
  const v = (sep > .15 ? 1 : sep < -.15 ? -1 : 0) + (slope > .1 ? .5 : slope < -.1 ? -.5 : 0) + st, sc = v / 2.5;
  return { d: Math.abs(sc) >= .4 ? Math.sign(sc) : 0, s: Math.abs(sc), st };
}
function reversalScan(cs, td, atrv, mom) {
  if (!td) return { score: 0, dir: 0, ok: false, why: [] };
  const n = cs.length - 1, c = cs.map(x => x.c), l = cs[n], e = ema(c, 20), why = [];
  let sc = 0;
  if ((c[n] - e[n]) * td / atrv > 2) { sc += 1; why.push('امتداد مفرط'); }
  const wk = td > 0 ? upw(l) : low(l);
  if (wk >= 2 * body(l) && wk > .45 * rng(l)) { sc += 1; why.push('رفض عند الطرف'); }
  if (mom.decel) { sc += 1; why.push('تباطؤ الزخم'); }
  const seg = cs.slice(-60), c60 = seg.map(x => x.c), sw = swings(seg, 2), arr = td > 0 ? sw.hi : sw.lo;
  if (arr.length >= 2) {
    const a = arr[arr.length - 2], b = arr[arr.length - 1];
    if (a.i >= 15 && b.i >= 15) {
      const ra = rsiAt(c60, a.i), rb = rsiAt(c60, b.i);
      if (td > 0 && b.p > a.p && rb < ra - 3) { sc += 1.5; why.push('تباعد هابط RSI'); }
      if (td < 0 && b.p < a.p && rb > ra + 3) { sc += 1.5; why.push('تباعد صاعد RSI'); }
    }
  }
  const lv = td > 0 ? sw.lo : sw.hi;
  if (lv.length) {
    const L = lv[lv.length - 1];
    if (td > 0 && c[n] < L.p) { sc += 2; why.push('كسر هيكل الاتجاه'); }
    if (td < 0 && c[n] > L.p) { sc += 2; why.push('كسر هيكل الاتجاه'); }
  }
  const against = td > 0 ? !bull(l) : bull(l);
  return { score: sc, dir: -td, ok: sc >= 3 && against, why };
}
// اختراق صالح (إغلاق خلف المستوى + جسم قوي + اتساع مدى + ثبات) مقابل وهمي (ذيل رفض أو إغلاق عاد داخل النطاق)
function breakoutScan(cs, atrv) {
  const n = cs.length; let out = null;
  for (let age = 2; age >= 0; age--) {
    const j = n - 1 - age;
    if (j < 22) continue;
    const bs = cs.slice(j - 20, j), hh = Math.max(...bs.map(x => x.h)), ll = Math.min(...bs.map(x => x.l)), x = cs[j], after = cs.slice(j + 1);
    if (hh - ll > 5 * atrv) continue; // لا اختراق حقيقي إلا بعد تجميع/نطاق؛ غير ذلك استمرار اتجاه وليس اختراقًا
    for (const side of [1, -1]) {
      const lv = side > 0 ? hh : ll, beyond = side > 0 ? x.c - lv : lv - x.c, pierce = side > 0 ? x.h > lv : x.l < lv;
      const wk = side > 0 ? upw(x) : low(x);
      const held = after.every(y => side > 0 ? y.c > lv : y.c < lv), back = after.some(y => side > 0 ? y.c <= lv : y.c >= lv);
      if (pierce && beyond <= 0 && wk >= .5 * rng(x)) out = { t: 'fake', side, age, why: 'اختراق بذيل رفض' };
      else if (beyond > 0 && back) out = { t: 'fake', side, age, why: 'اختراق عاد داخل النطاق' };
      else if (beyond >= .15 * atrv && body(x) >= .5 * rng(x) && rng(x) >= atrv && held) out = { t: 'valid', side, age, why: 'اختراق بإغلاق وجسم قوي' };
    }
  }
  return out;
}
function marketContext(cs) {
  const n = cs.length - 1, c = cs.map(x => x.c);
  const atrv = atr(cs) || 1e-12, a0 = atr(cs.slice(0, -30)) || 1e-12, volR = atrv / a0;
  const fb = frameTrend(cs.slice(-120), 9, 21, 40), f5 = frameTrend(resample(cs, CFG.htfK), 9, 21, 30), f15 = frameTrend(resample(cs, CFG.htfK * 3), 5, 13, 16);
  const W = [1, 1.5, 1], FR = [fb, f5, f15];
  let sw = 0, tw = 0;
  FR.forEach((f, i) => { if (f) { sw += W[i] * f.d; tw += W[i]; } });
  const align = tw ? sw / tw : 0, bias = Math.abs(align) >= .5 ? Math.sign(align) : 0;
  const conflict = !!(fb && f5 && fb.d && f5.d && fb.d !== f5.d);
  const ad = adxOf(cs.slice(-120)) || { adx: 20 }, er = eff(c, 20), er10 = eff(c, 10);
  let ch = 0;
  for (let i = n - 10; i <= n; i++) if (i >= 2 && Math.sign(c[i] - c[i - 1]) !== Math.sign(c[i - 1] - c[i - 2])) ch++;
  const chop = ch / 11;
  const m1 = (c[n] - c[n - 5]) / atrv, m0 = (c[n - 5] - c[n - 10]) / atrv;
  const mom = { v: m1, dir: Math.abs(m1) >= .5 ? Math.sign(m1) : 0, decel: m1 * m0 > 0 && Math.abs(m1) < .6 * Math.abs(m0), accel: m1 * m0 > 0 && Math.abs(m1) > 1.3 * Math.abs(m0) };
  const trendD = bias || (fb ? fb.d : 0);
  const rev = reversalScan(cs, trendD, atrv, mom), bo = breakoutScan(cs, atrv);
  const ws = [];
  for (let i = Math.max(19, n - 49); i <= n; i++) { const [, sd] = bb(c, i); ws.push(sd); }
  const sqz = ws.filter(v => v < ws[ws.length - 1]).length / ws.length <= .2;
  const rg = cs.slice(-30), hh = Math.max(...rg.map(x => x.h)), ll = Math.min(...rg.map(x => x.l)), pos = hh > ll ? (c[n] - ll) / (hh - ll) : .5, width = hh - ll;
  const al = d => d * Math.sign(align || 0);
  let kind = 'unclear', allow = 0, clarity = 25, note = '';
  if (chop >= .7 && er10 < .2 && er < .25) { kind = 'chaos'; clarity = 10; note = 'حركة متعرجة بلا اتجاه'; }
  else if (bo && bo.t === 'fake') {
    kind = 'fake'; allow = -bo.side; note = bo.why;
    clarity = 55 + (bo.age === 0 ? 5 : 0) + (align && al(-bo.side) > 0 ? 10 : align && al(-bo.side) < 0 ? -10 : 0) - (volR > 1.6 ? 10 : 0);
  } else if (bo && bo.t === 'valid') {
    kind = 'valid'; allow = bo.side; note = bo.why;
    clarity = 60 + (align && al(bo.side) > 0 ? 12 : align && al(bo.side) < 0 ? -20 : 0) + (ad.adx >= 20 ? 8 : 0) - (conflict ? 15 : 0);
  } else if (rev.ok) { kind = 'rev'; allow = rev.dir; note = rev.why.join('، '); clarity = Math.min(85, 40 + rev.score * 8); }
  else if (sqz && ad.adx < 25 && er < .35) { kind = 'squeeze'; clarity = 30; note = 'انضغاط: انتظر الاختراق'; }
  else if (bias && (ad.adx >= 20 || er >= .3)) {
    kind = 'trend'; allow = bias; note = (bias > 0 ? 'صاعد' : 'هابط') + ' · ADX ' + Math.round(ad.adx);
    clarity = 30 + Math.min(35, ad.adx) + 30 * Math.abs(align) - (mom.decel ? 10 : 0) - ((c[n] - ema(c, 20)[n]) * bias / atrv > 2.5 ? 10 : 0) - (conflict ? 15 : 0);
  } else if (ad.adx < 20 && er < .25 && volR < 1.5) {
    kind = 'range';
    if (width < 2 * atrv) { note = 'نطاق ضيق'; clarity = 35; }
    else if (pos <= .25) { allow = 1; note = 'قرب قاع النطاق'; clarity = 50 + (20 - ad.adx) + Math.abs(pos - .5) * 40; }
    else if (pos >= .75) { allow = -1; note = 'قرب قمة النطاق'; clarity = 50 + (20 - ad.adx) + Math.abs(pos - .5) * 40; }
    else { note = 'منتصف النطاق'; clarity = 35; }
  } else if (bias) { kind = 'weak'; allow = bias; note = 'اتجاه بلا قوة كافية'; clarity = 30 + ad.adx + 15 * Math.abs(align); }
  else note = 'الأطر متضاربة أو بلا اتجاه';
  clarity = Math.max(0, Math.min(100, Math.round(clarity)));
  const arrow = f => !f ? '·' : f.d > 0 ? '▲' : f.d < 0 ? '▼' : '–';
  return { kind, label: CTX_LBL[kind], allow, clarity, note, align, bias, conflict, adx: Math.round(ad.adx), er: +er.toFixed(2), volR: +volR.toFixed(2), pos: +pos.toFixed(2), mom: +m1.toFixed(2), f5d: f5 ? f5.d : 0, f15d: f15 ? f15.d : 0, mtf: arrow(fb) + arrow(f5) + arrow(f15), rev: rev.score, bo: bo ? bo.t + (bo.side > 0 ? '↑' : '↓') : '' };
}
function ctxPermit(ctx, dir, cfg) {
  if (!cfg.useCtx) return { ok: true };
  if (!ctx) return { ok: false, why: 'حالة السوق غير محسوبة' };
  if (ctx.clarity < cfg.minClarity) return { ok: false, why: 'حالة السوق غير واضحة: ' + ctx.label + ' (' + ctx.clarity + '%)' };
  if (!ctx.allow) return { ok: false, why: 'لا دخول في حالة «' + ctx.label + '»' + (ctx.note ? ': ' + ctx.note : '') };
  if (ctx.allow !== dir) return { ok: false, why: 'الاتجاه يخالف حالة السوق «' + ctx.label + '» (' + ctx.note + ')' };
  if (ctx.f5d === -dir && ctx.f15d === -dir && ctx.kind !== 'rev' && ctx.kind !== 'fake') return { ok: false, why: 'عكس الإطارين الأعلى معًا' };
  return { ok: true };
}

// اكتشاف الإشارات الكاذبة المحتملة قبل إصدار التوصية
function falseSignals(cs, X, dir, items, asset) {
  const out = [], n = cs.length, l = cs[n - 1], c = cs.map(x => x.c);
  if (rng(l) > 3 * X.atr) out.push('قفزة سعرية');
  if ((c[n - 1] - c[n - 4]) * dir > 2.5 * X.atr) out.push('ملاحقة متأخرة');
  const seq = ((S.sdh[asset] || []).slice(-3)).concat([dir]);
  let ch = 0;
  for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) ch++;
  if (seq.length >= 4 && ch >= 3) out.push('تذبذب الإشارة');
  const [lo, hi] = levels(cs), p = c[n - 1];
  if (dir > 0 && hi.some(v => v > p && v - p < .5 * X.atr)) out.push('مقاومة قريبة');
  if (dir < 0 && lo.some(v => v < p && p - v < .5 * X.atr)) out.push('دعم قريب');
  const tot = items.reduce((a, b) => a + b.w * Math.abs(b.v), 0);
  const top = Math.max(...items.map(x => x.w * Math.abs(x.v)));
  if (items.length >= 3 && tot > 0 && top / tot > .6) out.push('مؤشر واحد مهيمن');
  return out;
}

// قياس جودة البيانات (0-100)
function dataQuality(cs, asset) {
  const n = cs.length, issues = [];
  if (n < 2) return { q: 0, issues: ['لا بيانات'] };
  let q = 100, gaps = 0, flat = 0;
  const rs = [];
  for (let i = 0; i < n; i++) {
    if (i && cs[i].t - cs[i - 1].t > CFG.tf) gaps++;
    const r = cs[i].h - cs[i].l;
    rs.push(r);
    if (r === 0) flat++;
  }
  if (gaps) { q -= Math.min(40, gaps / n * 400); issues.push('فجوات زمنية ' + gaps); }
  if (flat / n > .1) { q -= Math.min(30, flat / n * 100); issues.push('شموع مسطحة ' + Math.round(flat / n * 100) + '%'); }
  const med = rs.slice().sort((a, b) => a - b)[n >> 1];
  if (med > 0) {
    const out = rs.filter(x => x > 12 * med).length;
    if (out / n > .03) { q -= 15; issues.push('قفزات شاذة ' + out); }
  }
  if (!S.loading && asset && S.lastRx[asset]) {
    const age = Date.now() - S.lastRx[asset];
    if (age > CFG.maxTickAgeMs) { q -= 25; issues.push('تأخر آخر تيك ' + Math.round(age / 1000) + 'ث'); }
  }
  return { q: Math.max(0, Math.round(q)), issues };
}

// قراءات الاستراتيجيات الخام على شموع معطاة (تُستخدم أيضًا في اختبار ثبات الإشارات)
function rawVotes(cs) {
  const c = cs.map(x => x.c), X = { rsi: rsi(c), atr: atr(cs) }, raw = {};
  for (const [k, , fn] of STR) {
    let v = 0;
    try { [v] = fn(cs, c, X); } catch (e) {}
    raw[k] = Number.isFinite(v) ? v : 0;
    if (IMP[k]) { let v2 = 0; try { [v2] = IMP[k](cs, c, X); } catch (e) {} raw[k + '+'] = Number.isFinite(v2) ? v2 : 0; }
  }
  return raw;
}

// ---- صفقات ظلّية: تجارب + مدد انتهاء متعددة + إشارات محجوبة + ممتنع عنها ----
function settleShadows(asset, A, c, complete, live) {
  const L = S.SH[asset];
  if (!L || !L.length) return;
  const maxH = HZ[HZ.length - 1], keep = [];
  for (const p of L) {
    const dt = c.t - p.ct, k = Math.round(dt / CFG.tf);
    if (dt <= 0) { keep.push(p); continue; }
    if (k > maxH) continue;
    // تُحتسب النتيجة فقط عند شمعة مكتملة وعلى بُعد دقيق من الدخول، وإلا تُهمل بدل تخمينها
    if (k * CFG.tf === dt && complete && c.c !== p.entry) {
      const win = (c.c > p.entry) === (p.dir > 0);
      if (k === 1) p.tags.forEach(t => rec(slot(A.z, t), win, live));
      if (p.sv && HZ.includes(k)) { const up = c.c > p.entry; for (const [sk, sd] of p.sv) rec(slot(A.z, qk(sk, k, p.rg)), (sd > 0) === up, live); }
      if (p.hz && HZ.includes(k)) {
        rec(slot(A.z, 'h|' + k), win, live);
        rec(slot(A.z, 'hr|' + k + '|' + p.rg), win, live);
        if (p.j) p.j.o[k] = win ? 1 : 0;
      }
    }
    if (k < maxH) keep.push(p);
  }
  S.SH[asset] = keep;
}
function registerShadows(asset, c, r, complete, live) {
  if (!r.comp || !r.sd || !complete) return;
  const base = decide(r), baseOK = base.ok && r.conf0 >= CFG.minConf, tags = [];
  for (const e of EXPS) {
    const mc = e.o.minConf !== undefined ? e.o.minConf : CFG.minConf;
    if (decide(r, e.o).ok && r.conf0 >= mc) tags.push('x|' + e.k);
  }
  if (decide(r, { veto: false }).ok && r.conf0 >= CFG.minConf) r.vetoes.forEach(v => tags.push('v|' + v));
  if (r.ctx && decide(r, { useCtx: false }).ok && r.conf0 >= CFG.minConf) tags.push('c|' + r.ctx.kind);
  if (!baseOK) tags.push('ab|all');
  let j = null;
  if (live && (baseOK || r.vetoes.length)) {
    j = { t: Date.now(), a: asset, ct: c.t, rg: r.regime, cf: r.conf0, d: r.sd, ok: baseOK ? 1 : 0, v: r.vetoes.slice(), ab: baseOK ? '' : (base.why[0] || ''), o: {} };
    S.journal.push(j);
    if (S.journal.length > CFG.journalMax) S.journal.shift();
  }
    const sv = [];
  for (const k in r.raw) if (Math.abs(r.raw[k]) >= .5) sv.push([k, r.raw[k] > 0 ? 1 : -1]);
  (S.SH[asset] || (S.SH[asset] = [])).push({ ct: c.t, entry: c.c, dir: r.sd, tags, hz: baseOK, rg: r.regime, j, sv });
}

// ---- تجميع الإحصاءات عبر الأصول (نفس الإطار الزمني) ----
function zAgg(key) {
  const o = { ln: 0, lw: 0, hn: 0, hw: 0 };
  for (const a in S.A) {
    if (tfOfKey(a) !== CFG.tf) continue;
    const z = S.A[a].z && S.A[a].z[key];
    if (z) { o.ln += z.ln; o.lw += z.lw; o.hn += z.hn; o.hw += z.hw; }
  }
  return o;
}
function expReady(e) {
  if (e.ref || e.k === 'base') return { ok: false, why: 'مرجع' };
  const x = zAgg('x|' + e.k), b = zAgg('x|base'), n = x.ln, w = x.lw;
  if (n < CFG.minLive) return { ok: false, why: 'عينة حية ' + n + '/' + CFG.minLive };
  const lb = wil(n, w, CFG.gateZ);
  if (lb <= BE()) return { ok: false, why: 'الحد الأدنى ' + Math.round(lb * 100) + '% ≤ التعادل' };
  if (b.ln >= 30 && w / n < b.lw / b.ln + .02) return { ok: false, why: 'ليست أفضل من الأساس بفارق 2%' };
  return { ok: true, why: 'جاهزة للاعتماد' };
}
const sameCfg = e => Object.keys(e.o).every(k => JSON.stringify(CFG[k]) === JSON.stringify(e.o[k]));
function adoptExp(k) {
  const e = EXPS.find(x => x.k === k);
  if (!e || !expReady(e).ok) return false;
  for (const f in e.o) CFG[f] = Array.isArray(e.o[f]) ? e.o[f].slice() : e.o[f];
  S.adopted.unshift({ t: Date.now(), k });
  S.adopted = S.adopted.slice(0, 20);
  saveCfg();
  return true;
}
function resetCfg() {
  Object.assign(CFG, DEFAULTS);
  S.adopted = [];
  saveCfg();
}

// ---- الذاكرة: دفتر التجارب + نسخة ثانية في IndexedDB تنجو من مسح التخزين المحلي ----
function cleanJournal(a) {
  if (!Array.isArray(a)) return [];
  return a.slice(-CFG.journalMax).filter(x => x && typeof x === 'object' && Number.isFinite(+x.t)).map(x => ({
    t: +x.t, a: String(x.a || ''), ct: +x.ct || 0, rg: String(x.rg || ''), cf: +x.cf || 0, d: x.d > 0 ? 1 : -1, ok: x.ok ? 1 : 0,
    v: Array.isArray(x.v) ? x.v.map(String).slice(0, 6) : [], ab: x.ab ? String(x.ab).slice(0, 80) : '',
    o: x.o && typeof x.o === 'object' ? Object.fromEntries(Object.entries(x.o).filter(([k, v]) => HZ.includes(+k) && (v === 0 || v === 1))) : {}
  }));
}
function saveJournal(force) {
  const now = Date.now();
  if (!force && now - S.lastJ < 30000) return;
  S.lastJ = now;
  LSset(KEY_JOURNAL, S.journal);
}
const IDB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      if (typeof indexedDB === 'undefined') return rej(new Error('no idb'));
      const q = indexedDB.open('wsnf25', 1);
      q.onupgradeneeded = () => { q.result.createObjectStore('kv'); };
      q.onsuccess = () => { this.db = q.result; res(q.result); };
      q.onerror = () => rej(q.error);
    });
  },
  async get(k) { const db = await this.open(); return new Promise((res, rej) => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async set(k, v) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(true); t.onerror = () => rej(t.error); }); },
  async del(k) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = () => res(true); t.onerror = () => rej(t.error); }); }
};
function mirror(force) {
  const now = Date.now();
  if (!S.idbReady || S.idbErr || (!force && now - S.lastMir < 60000)) return;
  S.lastMir = now;
  IDB.set('bak', { at: now, live: snapshot(), journal: S.journal, log: S.log.slice(0, 200), cfg: cfgSnap() })
    .then(() => { S.idbAt = now; }).catch(() => { S.idbErr = true; });
}
// عند بدء التشغيل: إن كان التخزين المحلي فارغًا (مسحه المتصفح) نستعيد من النسخة الثانية. لا ننسخ قبل انتهاء هذا الفحص.
async function idbRestore() {
  try {
    const bak = await IDB.get('bak');
    const have = Object.keys(S.A).length > 0 && LSget(KEY_LIVE, null);
    if (bak && bak.live && !have) {
      applySnapshot(bak.live);
      S.journal = cleanJournal(bak.journal);
      if (!S.log.length) S.log = cleanLog(bak.log);
      applyCfg(bak.cfg, true);
      save(); saveJournal(true);
      logErr('RESTORED', 'استُعيدت الذاكرة من النسخة الثانية (IndexedDB)');
    } else if (bak) S.idbAt = bak.at;
  } catch (e) { S.idbErr = true; }
  S.idbReady = !S.idbErr;
}

// ---- عرض المختبر ----
const cellAcc = (n, w) => n ? Math.round(w / n * 1000) / 10 + '%' : '-';
function labView() {
  const asset = S.cur, dq = asset ? S.dq[asset] : null, be = BE(), au = S.audit;
  const q = `<div class="st"><span>جودة بيانات الأصل الحالي</span><b class="${dq && dq.q >= CFG.minQ ? 'w' : 'l'}">${dq ? dq.q + '%' : '-'}</b><small>${dq && dq.issues.length ? ESC(dq.issues.join(' | ')) : 'لا مشاكل'}</small></div>` +
    `<div class="st"><span>تدقيق عدم استخدام المستقبل</span><b class="${au.bad ? 'l' : 'w'}">${au.n - au.bad}/${au.n}</b><small>${au.bad ? ESC(au.last) : 'كل تحليل بُني على شمعة مغلقة'}</small></div>` +
    `<div class="st"><span>اختبار ثبات القراءات</span><b class="${au.testBad ? 'l' : 'w'}">${au.tests - au.testBad}/${au.tests}</b><small>إعادة حساب قراءة الشمعة السابقة</small></div>`;
  const hz = HZ.map(h => ({ h, z: zAgg('h|' + h) }));
  const live = hz.filter(x => x.z.ln >= 30), pool = live.length ? live : hz.filter(x => x.z.hn >= 30);
  const sc = x => live.length ? wil(x.z.ln, x.z.lw, 1.64) : wil(x.z.hn, x.z.hw, 1.64);
  const best = pool.length ? pool.reduce((a, b) => sc(b) > sc(a) ? b : a).h : null;
  const h = hz.map(x => `<tr><td>${hzLabel(x.h)}</td><td>${x.z.ln}</td><td>${cellAcc(x.z.ln, x.z.lw)}</td><td>${x.z.ln ? Math.round(wil(x.z.ln, x.z.lw) * 100) + '%' : '-'}</td><td>${x.z.hn}</td><td>${cellAcc(x.z.hn, x.z.hw)}</td><td>${best === x.h ? '<span class="chip c-u">الأفضل' + (live.length ? '' : ' (تمهيدي)') + '</span>' : ''}</td></tr>`).join('');
  const rm = '<thead><tr><th>الحالة \\ المدة</th>' + HZ.map(x => '<th>' + hzLabel(x) + '</th>').join('') + '</tr></thead><tbody>' +
    RGS.map(g => '<tr><td>' + g + '</td>' + HZ.map(x => { const z = zAgg('hr|' + x + '|' + g), n = z.ln + z.hn, w = z.lw + z.hw; return '<td>' + (n >= 20 ? cellAcc(n, w) + ' <small class="note">(' + n + ')</small>' : '-') + '</td>'; }).join('') + '</tr>').join('') + '</tbody>';
  const v = VETOS.map(name => {
    const z = zAgg('v|' + name), n = z.ln + z.hn, w = z.lw + z.hw;
    const useful = n >= 30 && 1 - wil(n, n - w, 1.64) < be, harmful = n >= 30 && wil(n, w, 1.64) > be;
    return `<tr><td>${name}</td><td>${n}</td><td>${cellAcc(n, w)}</td><td><span class="chip ${useful ? 'c-u' : harmful ? 'c-d' : 'c-m'}">${useful ? 'يحجب خاسرة' : harmful ? 'يحجب رابحة' : 'عينة صغيرة'}</span></td></tr>`;
  }).join('');
  const cx = CTX_KINDS.map(k => {
    const z = zAgg('c|' + k), n = z.ln + z.hn, w = z.lw + z.hw;
    const lose = n >= 30 && 1 - wil(n, n - w, 1.64) < be, win = n >= 30 && wil(n, w, 1.64) > be;
    return `<tr><td>${CTX_LBL[k]}</td><td>${n}</td><td>${cellAcc(n, w)}</td><td><span class="chip ${win ? 'c-u' : lose ? 'c-d' : 'c-m'}">${win ? 'رابحة' : lose ? 'خاسرة' : 'عينة صغيرة/متوسطة'}</span></td></tr>`;
  }).join('');
  const cAsset = S.cur, cSig = cAsset ? S.sigBy[cAsset] : null, cRg = cSig && cSig.regime && cSig.regime !== '-' ? cSig.regime : '-';
  let scT = '<tbody><tr><td class="note">لا أصل حالي</td></tr></tbody>';
  if (cAsset) {
    scT = '<thead><tr><th>الاستراتيجية</th>' + HZ.map(h => '<th>' + hzLabel(h) + '</th>').join('') + '<th>الاختيار التلقائي</th></tr></thead><tbody>' +
      stratMatrix(cAsset, cRg).map(r => '<tr><td>' + NM[r.k] + (r.ak !== r.k ? ' ✦' : '') + '</td>' + r.cells.map((c, i) => {
        const lb = c.n >= 30 ? wil(c.n, c.w, CFG.zStrat) : 0, cls = !c.n ? '' : lb > be ? 'w' : (c.n >= 30 && wil(c.n, c.n - c.w, CFG.zStrat) > be) ? 'l' : '';
        return '<td class="' + cls + '">' + (c.n ? cellAcc(c.n, c.w) + ' <small class="note">(' + c.n + (c.src === 'عام' ? ' عام' : '') + ')</small>' + (r.bi === i ? ' ★' : '') : '-') + '</td>';
      }).join('') + '<td><span class="chip c-' + r.cls + '">' + r.st + '</span></td></tr>').join('') + '</tbody>';
  }
  const scn = cAsset ? 'الأصل: ' + cAsset + ' · الحالة: ' + (cRg === '-' ? 'كل الحالات' : cRg) + ' · ★ = أنسب مدة للاستراتيجية · «عام» = عينة مجمّعة من بقية الأصول لقلّة بيانات هذا الأصل' : '';
  const vt = IMPK.map(k => {
    const v = variantVerdict(k), cur = S.sv[k] === 'new';
    return `<tr><td>${NM[k]}</td><td>${v.no ? cellAcc(v.no, v.wo) + ' <small class="note">(' + v.no + ')</small>' : '-'}</td><td>${v.nn ? cellAcc(v.nn, v.wn) + ' <small class="note">(' + v.nn + ')</small>' : '-'}</td><td>${v.src}</td><td><span class="chip ${cur ? 'c-u' : 'c-m'}">${cur ? 'المعدّلة' : 'القديمة'}</span></td><td>${ESC(v.why)}</td></tr>`;
  }).join('');
  const vl = S.svLog.slice(0, 3).map(x => ESC(NM[x.k]) + ' → ' + (x.to === 'new' ? 'المعدّلة' : 'القديمة') + ' (' + new Date(x.t).toTimeString().slice(0, 5) + ')').join('، ');
  const clm = {};
  SK.forEach(k => { const g = clusterOf(k); (clm[g] = clm[g] || []).push(k); });
  const cr = Object.keys(clm).map(g => {
    const gsN = new Set(clm[g].map(k => GRP[k])).size;
    return `<tr><td>${clm[g].map(k => NM[k]).join('، ')}</td><td><span class="chip ${gsN > 1 ? 'c-g' : 'c-m'}">${gsN > 1 ? 'دُمجت ' + gsN + ' مجموعات (تطابق مقاس)' : 'عنقود مستقل'}</span></td></tr>`;
  }).join('');
  const crn = corrReport(100, .85).slice(0, 5).map(p => p.pair.split('|').map(x => NM[x] || x).join(' ↔ ') + ' ' + Math.round(p.agree * 100) + '%').join(' | ');
  const zb = zAgg('x|base'), zf = zAgg('x|forced'), za = zAgg('ab|all');
  const ab = `<div class="st"><span>كل الشموع (بدون امتناع)</span><b>${cellAcc(zf.ln + zf.hn, zf.lw + zf.hw)}</b><small>${zf.ln + zf.hn} حالة</small></div>` +
    `<div class="st"><span>الإشارات المُصدرة</span><b>${cellAcc(zb.ln + zb.hn, zb.lw + zb.hw)}</b><small>${zb.ln + zb.hn} حالة</small></div>` +
    `<div class="st"><span>التي امتنع عنها</span><b>${cellAcc(za.ln + za.hn, za.lw + za.hw)}</b><small>${za.ln + za.hn} حالة</small></div>` +
    `<div class="st"><span>نقطة التعادل</span><b>${pc(be, 1)}</b></div>`;
  const x = EXPS.map(e => {
    const z = zAgg('x|' + e.k), rd = expReady(e), cur = e.k !== 'base' && !e.ref && sameCfg(e);
    const st = e.k === 'base' ? '<span class="chip c-m">المعتمد</span>' : e.ref ? '<span class="chip c-m">مرجع</span>' : cur ? '<span class="chip c-u">مُعتمدة</span>' : rd.ok ? '<span class="chip c-u">جاهزة</span>' : '<span class="chip c-m">' + ESC(rd.why) + '</span>';
    const btn = !e.ref && e.k !== 'base' && !cur && rd.ok ? `<button data-adopt="${e.k}">اعتمد</button>` : '';
    return `<tr><td>${e.n}</td><td>${z.ln}</td><td>${cellAcc(z.ln, z.lw)}</td><td>${z.ln ? Math.round(wil(z.ln, z.lw, CFG.gateZ) * 100) + '%' : '-'}</td><td>${z.hn}</td><td>${cellAcc(z.hn, z.hw)}</td><td>${st}</td><td>${btn}</td></tr>`;
  }).join('');
  const done = S.journal.filter(e => Object.keys(e.o).length).length;
  const j = `<div class="st"><span>إشارات الدفتر</span><b>${S.journal.length}</b><small>${done} اكتملت نتيجتها</small></div>` +
    `<div class="st"><span>النسخة الثانية (IndexedDB)</span><b class="${S.idbErr ? 'l' : 'w'}">${S.idbErr ? 'غير متاحة' : S.idbAt ? new Date(S.idbAt).toTimeString().slice(0, 8) : S.idbReady ? 'بانتظار أول حفظ' : 'تُفحص...'}</b></div>` +
    `<div class="st"><span>تجارب معتمدة</span><b>${S.adopted.length}</b><small>${S.adopted.slice(0, 3).map(a => ESC(a.k)).join('، ')}</small></div>`;
  return { q, h, hn: best === null ? 'تحتاج 30 صفقة ظلّية على الأقل لكل مدة' : '', rm, v, cx, scT, scn, vt, vl, cr, crn, ab, x, j };
}

// ================= التحليل =================
function analyze(cs, A, asset) {
  const none = (why, regime = '-') => ({ d: 'none', conf: 0, conf0: 0, why, abst: [why], raw: {}, regime, bk: null, notes: [], htf: 0, htfOK: false, agree: 0, agreeS: 0, rawA: {}, comp: false, sd: 0, sc: 0, vetoes: [] });
  if (cs.length < 60) return none('تجميع البيانات ' + cs.length + '/60');
  const vc = verifyCandles(cs);
  if (!vc.ok) return none('بيانات غير موثوقة: ' + vc.why);
  const dq = dataQuality(cs, asset);
  if (asset) S.dq[asset] = dq;
  if (dq.q < CFG.minQ) return none('جودة البيانات ' + dq.q + '% (' + dq.issues.join('، ') + ')');
  const c = cs.map(x => x.c), X = { rsi: rsi(c), atr: atr(cs) };
  const a0 = atr(cs.slice(0, -30)) || 1e-12;
  if (X.atr < .4 * a0) return none('سوق ميت');
  // حالة السوق: متقلب (قفزة تذبذب) ثم اتجاهي ثم عرضي ثم مختلط
  const er = eff(c), regime = X.atr > 1.8 * a0 ? 'متقلب' : er > .35 ? 'اتجاهي' : er < .2 ? 'عرضي' : 'مختلط';
  const raw = {}, rawA = {}, items = [], det = {};
  for (const [k, kind, fn] of STR) {
    let v = 0, n = '';
    try { [v, n] = fn(cs, c, X); } catch (e) {}
    if (!Number.isFinite(v)) v = 0;
    raw[k] = v; det[k] = n;
    let ak = k;
    if (IMP[k]) {
      let v2 = 0, n2 = '';
      try { [v2, n2] = IMP[k](cs, c, X); } catch (e) {}
      if (!Number.isFinite(v2)) v2 = 0;
      raw[k + '+'] = v2;
      if (S.sv && S.sv[k] === 'new') { v = v2; n = n2; ak = k + '+'; det[k] = n2; }
    }
    rawA[k] = v;
    if (v === 0) continue;
    const W = wtR(A, ak, regime);
    if (W.w === 0) continue;
    // التعديل اليدوي حسب النوع يُستخدم فقط حين لا توجد بيانات كافية لهذه الحالة؛ وإلا فالبيانات هي التي تحكم
    const m = W.rg ? 1 : ((kind === 'T' && regime === 'اتجاهي') || (kind === 'R' && regime === 'عرضي') ? 1.4
      : (kind === 'T' && regime === 'عرضي') || (kind === 'R' && regime === 'اتجاهي') ? .6 : 1);
    items.push({ k, ak, v: W.inv ? -v : v, w: W.w * m, inv: W.inv, mode: W.mode });
  }
  if (!items.length) return { ...none('لا أصوات', regime), raw, rawA };
  dampen(items);
  const ws = items.reduce((a, b) => a + b.w, 0);
  const score = items.reduce((a, b) => a + b.w * b.v, 0) / ws;
  const dir = score > 0 ? 1 : -1;
  const gs = {};
  items.forEach(x => { const o = gs[x.g] || (gs[x.g] = { sw: 0, sv: 0 }); o.sw += x.w; o.sv += x.w * x.v; });
  const agree = Object.values(gs).filter(o => o.sv / o.sw * dir >= .5).length; // عناقيد مستقلة متفقة (دمج ديناميكي للمتطابقة)
  const gs0 = {};
  items.forEach(x => { const o = gs0[x.g0] || (gs0[x.g0] = { sw: 0, sv: 0 }); o.sw += x.w; o.sv += x.w * x.v; });
  const agreeS = Object.values(gs0).filter(o => o.sv / o.sw * dir >= .5).length; // بالمجموعات الثابتة فقط (للمقارنة)
  const sa = items.reduce((a, b) => a + b.w * Math.abs(b.v), 0) || 1e-9;
  const opp = items.filter(x => x.v * dir < 0).reduce((a, b) => a + b.w * Math.abs(b.v), 0) / sa;
  const htf = htfTrend(cs), htfOK = htf === 0 || htf === dir;
  // سقف الثقة مرتبط بحجم الدليل الحي: لا ترتفع الثقة قبل وجود عينة كافية
  const evN = A && A.e ? A.e.ln : 0;
  const cap = evN < CFG.minLive ? 70 : evN < 300 ? 80 : 95;
  const conf0 = Math.min(cap, Math.round(50 + Math.abs(score) * 70));
  let ctx = null;
  try { ctx = marketContext(cs); } catch (e) { logErr('CTX_ERR', String(e && e.message || e)); }
  const X2 = { atr: X.atr };
  const vetoes = falseSignals(cs, X2, dir, items, asset);
  const r0 = { comp: true, sd: dir, sc: score, agree, agreeS, opp, htfOK, vetoes, regime, ctx };
  const dc = decide(r0), ok = dc.ok;
  const conf = ok ? conf0 : Math.min(conf0, 59);
  const notes = items.filter(x => Math.abs(x.v) >= .5).map(x => (det[x.k] || NM[x.k]) + (x.v > 0 ? '▲' : '▼') + (x.inv ? '⟲' : ''));
  const hzB = bestHz(A, regime, items, dir);
  if (hzB) notes.push('أنسب مدة: ' + hzLabel(hzB.h) + ' (' + Math.round(hzB.acc * 100) + '%)');
  if (ctx) { notes.unshift('أطر ' + ctx.mtf + (ctx.bo ? ' · ' + ctx.bo : '')); notes.unshift('حالة: ' + ctx.label + ' ' + ctx.clarity + '%' + (ctx.note ? ' (' + ctx.note + ')' : '')); }
  return { d: ok ? (dir > 0 ? 'call' : 'put') : 'none', conf, conf0, why: regime, abst: dc.why, regime, raw, bk: bucket(conf), notes, agree, agreeS, opp, htf, htfOK, score, sc: score, sd: dir, comp: true, vetoes, q: dq.q, atr: X.atr, ctx, rawA, hzB };
}

// بوابة الإثبات: النتائج الحية فقط
function gate(r, A) {
  if (!r || r.d === 'none') return { ok: false, why: 'لا توجد إشارة' };
  const b = A.b[r.bk];
  if (!b) return { ok: false, why: 'لا بيانات لفئة هذه الثقة' };
  const n = b.ln, w = b.lw;
  if (n < CFG.minLive) return { ok: false, why: 'عينة حية ' + n + '/' + CFG.minLive };
  const lb = wil(n, w, CFG.gateZ);
  if (lb <= BE()) return { ok: false, why: 'الحد الأدنى للدقة ' + (lb * 100).toFixed(0) + '% ≤ التعادل' };
  const rc = b.rc || [];
  if (rc.length < CFG.recentN) return { ok: false, why: 'تأكيد حديث ' + rc.length + '/' + CFG.recentN };
  const rp = rc.slice(-CFG.recentN).reduce((a, x) => a + x, 0) / CFG.recentN;
  if (rp < BE()) return { ok: false, why: 'آخر ' + CFG.recentN + ' إشارة: ' + (rp * 100).toFixed(0) + '% < التعادل' };
  return { ok: true, why: 'مثبتة حيًا (' + (w / n * 100).toFixed(0) + '% من ' + n + ')' };
}

// ================= الشموع من التيك =================
function feedTick(asset, ts, p) {
  if (!Number.isFinite(ts) || !Number.isFinite(p) || p <= 0) return;
  if (S.lock && asset !== S.lock) return;
  const t = Math.floor(ts / CFG.tf) * CFG.tf;
  const arr = S.candles[asset] || (S.candles[asset] = []);
  const c = arr[arr.length - 1];
  if (c && c.t > t) return; // تيك قديم/خارج الترتيب
  if (!S.loading) { S.lastRx[asset] = Date.now(); S.lastPx[asset] = p; S.tickTs[asset] = ts; }
  if (!c || c.t < t) {
    if (c) onClose(asset, arr, t);
    arr.push({ t, o: p, h: p, l: p, c: p, ft: ts, lt: ts, nt: 1 });
    if (arr.length > CFG.maxCandles) arr.shift();
  } else {
    c.h = Math.max(c.h, p); c.l = Math.min(c.l, p); c.c = p; c.lt = ts; c.nt++;
  }
  S.cur = asset; S.ticks++; S.lastTs[asset] = ts;
  if (!S.loading) {
    const pd = S.pending;
    if (pd && pd.asset === asset && ts > pd.sendTs) confirmOrder(p, ts);
    const o = S.open;
    if (o && o.asset === asset && ts >= o.expTs) finishOpen(p, ts);
    try { resolveReal(asset, p, ts); } catch (e) {}
  }
}
function onClose(asset, arr, tNew) {
  const c = arr[arr.length - 1], A = getA(asset), live = !S.loading, pd = S.P[asset];
  const tol = Math.max(5, CFG.edgeTol * CFG.tf);
  // الشمعة المكتملة: أول تيك قريب من بدايتها وآخر تيك قريب من نهايتها
  const complete = (c.ft - c.t) <= tol && (c.t + CFG.tf - c.lt) <= tol;
  // تدقيق عدم استخدام المستقبل: لا نحلّل إلا شمعة أُغلقت فعلًا وبترتيب زمني سليم
  const aud = S.audit;
  aud.n++;
  let bad = '';
  if (tNew !== undefined && !(c.t < tNew)) bad = 'الشمعة المحللة لم تُغلق بعد';
  else if (arr.length > 1 && !(arr[arr.length - 2].t < c.t)) bad = 'ترتيب الشموع الزمني مختل';
  if (bad) { aud.bad++; aud.last = bad; logErr('LOOKAHEAD', asset + ': ' + bad); }
  settleShadows(asset, A, c, complete, live);
  const nextOK = !!pd && c.t - pd.ct === CFG.tf && pd.ok === true && complete;
  if (pd && pd.log && pd.log.win === null && !pd.log.tie && !isOwn(pd.log) && !nextOK) pd.log.stale = true;
  if (nextOK && c.c === pd.entry && pd.log && !isOwn(pd.log)) settleTie(pd.log, c.c);
  if (nextOK && c.c !== pd.entry) {
    const up = c.c > pd.entry;
    for (const k in pd.raw) if (Math.abs(pd.raw[k]) >= .5) {
      const ok1 = (pd.raw[k] > 0) === up;
      rec(slot(A.s, k), ok1, live);
      if (pd.regime && pd.regime !== '-') rec(slot(A.s, k + '#' + pd.regime), ok1, live); // أداء الاستراتيجية في هذه الحالة على هذا الأصل
    }
    if (pd.dir !== 'none') {
      const win = (pd.dir === 'call') === up;
      rec(A.e, win, live);
      rec(slot(A.b, pd.bk), win, live);
      if (pd.log && !isOwn(pd.log)) settle(pd.log, c.c, win);
    }
  }
  // اختبار ثبات القراءات: نعيد حساب قراءات الشمعة السابقة بعد إغلاقها ونقارنها بما استُخدم وقت القرار
  if (nextOK && live && pd.raw && Object.keys(pd.raw).length && aud.n % 6 === 0) {
    const i = arr.length - 2;
    if (i >= 0 && arr[i].t === pd.ct) {
      const re = rawVotes(arr.slice(Math.max(0, i + 1 - CFG.window), i + 1));
      aud.tests++;
      if (Object.keys(pd.raw).some(k => Math.abs((re[k] || 0) - pd.raw[k]) > 1e-9)) { aud.testBad++; aud.last = 'تغيّرت قراءة مؤشر بعد إغلاق الشمعة'; logErr('LOOKAHEAD', asset + ': ' + aud.last); }
    }
  }
  let r = analyze(arr.slice(-CFG.window), A, asset);
  if (bad) r = { ...r, d: 'none', conf: Math.min(r.conf, 59), abst: [bad], comp: false, sd: 0 };
  S.sigBy[asset] = r;
  S.P[asset] = { entry: c.c, ct: c.t, raw: r.raw, dir: r.d, bk: r.bk, log: null, ok: complete, regime: r.regime, at: live ? Date.now() : 0, atr: r.atr };
  trackCorr(r.rawA || r.raw);
  S.ncl = (S.ncl || 0) + 1;
  if (S.ncl % 25 === 0) { try { rebuildClusters(); if (live) evalVariants(); } catch (e) { logErr('VAR_ERR', String(e && e.message || e)); } }
  if (r.sd) S.sdh[asset] = (S.sdh[asset] || []).concat([r.sd]).slice(-5);
  registerShadows(asset, c, r, complete, live);
  if (live) {
    save();
    if (complete && r.d !== 'none' && r.conf >= CFG.minConf) { maybeTrade(asset, r, c, A); try { const rr = autoRun(asset); if (S.decision && EX.auto) { S.decision.entered = !!(rr && rr.ok); S.decision.why = S.decision.entered ? [] : [EX.autoWhy || 'لم يُنفَّذ']; } } catch (e) { logErr('EXEC_ERR', String(e && e.message || e)); } }
  }
}
function settle(e, exit, win) {
  e.exit = exit; e.win = win;
  if (e.auto) {
    if (S.open === e) S.open = null;
    S.unkRow = 0;
    S.net += win ? CFG.payout : -1;
    S.lossRow = win ? 0 : S.lossRow + 1;
    if (S.lossRow >= CFG.maxLossRow) { S.pausedUntil = Date.now() + CFG.pauseMs; S.lossRow = 0; }
    if (S.net <= -CFG.maxDD) { S.halted = true; S.haltWhy = 'حد الخسارة'; }
    simTrace('settled', { asset: e.asset, win, net: +S.net.toFixed(2) });
    saveState();
  }
  saveLog();
  if (S.onResult && !S.loading) { try { S.onResult(win); } catch (_) {} }
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
  const age = Date.now() - (S.lastRx[asset] || 0);
  if (age > CFG.maxTickAgeMs) return { ok: false, why: 'بيانات قديمة (' + Math.round(age / 1000) + 'ث)' };
  if (S.wsUp === false) return { ok: false, why: 'انقطاع اتصال البيانات' };
  if (!Number.isFinite(S.lastPx[asset]) || !Number.isFinite(S.tickTs[asset])) return { ok: false, why: 'لا يوجد سعر حالي' };
  return { ok: true };
}
function placeOrder(e, asset, r, c) {
  S.fired[asset] = c.t;
  S.cdUntil = Date.now() + CFG.cooldownCandles * CFG.tf * 1000;
  e.try = true; e.sendTs = S.tickTs[asset];
  S.pending = { e, asset, dir: r.d, sendTs: e.sendTs, at: Date.now() };
  simTrace('order_sent', { asset, dir: r.d });
  if (S.simBroker && S.simBroker.reject) failPending('رفض من وسيط المحاكاة');
}
function confirmOrder(px, ts) {
  const pd = S.pending;
  if (!pd) return;
  if (ts - pd.sendTs > CFG.confirmMs / 1000) { failPending('تأخر التأكيد'); return; }
  S.pending = null;
  const e = pd.e;
  e.auto = true; e.confirmed = 'sim'; e.dur = CFG.tf; e.entryPx = px; e.entryTs = ts; e.expTs = ts + CFG.tf; e.openAt = Date.now();
  S.open = e; S.hourly.push(Date.now()); S.failRow = 0;
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
function watchdog() {
  const now = Date.now(), pd = S.pending;
  if (pd && now - pd.at > CFG.confirmMs) failPending('لم يتأكد فتح الصفقة (لم تصل بيانات بعد الإرسال)');
  const e = S.open;
  if (e && now - e.openAt > (e.dur + 25) * 1000) {
    S.pausedUntil = Math.max(S.pausedUntil, now + CFG.staleRestMs);
    voidTrade(e, 'لم تصل نتيجة الصفقة');
  }
}
setInterval(() => { try { watchdog(); } catch (err) {} }, 1000);
function onWsDown() {
  if (EX.modal) cancelExec('انقطع الاتصال: أُغلقت نافذة التأكيد ولم يُرسل شيء');
  if (S.pending) failPending('انقطاع الاتصال قبل التأكيد');
  if (S.open) voidTrade(S.open, 'انقطاع الاتصال أثناء الصفقة');
}
function killSwitch(why) {
  CFG.auto = false; S.halted = true; S.haltWhy = why || 'إيقاف طارئ';
  if (S.pending) { const e = S.pending.e; S.pending = null; e.failed = true; e.reason = 'إيقاف طارئ'; }
  if (S.open) voidTrade(S.open, 'إيقاف طارئ', false);
  logErr('KILL', 'إيقاف طارئ يدوي');
  saveAll();
}
function setTf(v) {
  if (![15, 30, 60].includes(+v)) return false;
  if (S.pending) failPending('تغيير مدة الشمعة');
  if (S.open) voidTrade(S.open, 'تغيير مدة الشمعة', false);
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
  LSset(KEY_LIVE, {}); LSset(KEY_LOG, []); LSset(KEY_JOURNAL, []); saveState();
  try { IDB.del('bak').catch(() => {}); } catch (e) {}
}
function maybeTrade(asset, r, c, A) {
  const g = gate(r, A), now = Date.now();
  const why = [];
  // v3.3: لا محاكاة. الدخول الآلي = تنفيذ حقيقي عبر autoRun فقط؛ هنا نسجّل الإشارة والقرار.
  if (!(CFG.auto && EX.auto)) why.push('الدخول الآلي الحقيقي متوقف');
  if (EX.halted) why.push('التنفيذ موقوف' + (EX.haltWhy ? ': ' + EX.haltWhy : ''));
  if (CFG.gate && !g.ok) why.push('البوابة: ' + g.why);
  const e = { t: now, asset, dir: r.d, conf: r.conf, entry: c.c, ct: c.t, exit: null, win: null, auto: false, proven: g.ok };
  S.decision = { t: now, asset, dir: r.d, conf: r.conf, entered: !!(e.try && !e.failed), why, ctx: r.ctx ? r.ctx.label + ' ' + r.ctx.clarity + '%' : '' };
  S.log.unshift(e);
  if (S.log.length > 200) S.log.pop();
  if (S.P[asset]) S.P[asset].log = e;
  if (S.onFlash) { try { S.onFlash(e); } catch (_) {} }
}

// ================= مساعدات المنصة (للعرض فقط، لا نقر ولا إرسال) =================
const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
const ASSET_SEL = ['.current-symbol', '.pair-name', '.chart-item .pair', '.symbol-name', '[class*="current-symbol"]', '[class*="symbol-name"]'];
function readShownAsset() {
  try { for (const s of ASSET_SEL) { const el = document.querySelector(s); const t = el && (el.textContent || '').trim(); if (t) return t; } } catch (e) {}
  return null;
}
function verifyActiveAsset(asset) {
  const shown = readShownAsset();
  if (!shown) return S.lock === asset ? { ok: true, why: 'الأصل مقفول يدويًا (تعذّرت قراءة الاسم)' } : { ok: false, why: 'تعذّر قراءة الأصل المعروض: اقفل الأصل' };
  return norm(asset) === norm(shown) ? { ok: true, why: shown } : { ok: false, why: 'المعروض "' + shown + '" ≠ ' + asset };
}
function readExpiry() {
  try {
    for (const i of document.querySelectorAll('input')) {
      const m = /^(\d\d):(\d\d):(\d\d)$/.exec((i.value || '').trim());
      if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3];
    }
  } catch (e) {}
  return null;
}

// ================= v2.8: تنفيذ يدوي مؤكد =================
// لا يوجد تنفيذ تلقائي على المنصة إطلاقًا. التنفيذ يتم فقط بنقرة تأكيد من المستخدم داخل نافذة التأكيد،
// وعبر نقر زر CALL/PUT الظاهر في واجهة المنصة نفسها (أي نفس ما يفعله المستخدم بيده). مبلغ الصفقة ومدتها يبقيان من إعدادات المنصة.
const KEY_SENT = 'wsnf25_sent';
const KEY_EXS = 'wsnf25_exstop';
const KEY_LIM = 'wsnf25_lim', KEY_EXH = 'wsnf25_exh';
const EX = { sent: {}, busy: false, modal: null, note: '', halted: false, haltWhy: '', hist: [], auto: false, autoWhy: '' };
// حدود التنفيذ (قيم افتراضية متحفظة؛ يعدّلها المستخدم). المبلغ نفسه يُقرأ من المنصة؛ إن تعذّرت قراءته لا يمكن التحقق من الحد فيُحجب التنفيذ.
const LIM_DEF = { maxAmount: 10, maxDayStake: 50, maxPerHour: 5, maxPerDay: 20, maxLossRow: 3, maxDayLoss: 30 };
const LIM = { ...LIM_DEF };
const INT_LIM = ['maxPerHour', 'maxPerDay', 'maxLossRow'];
function setLim(k, v) {
  if (!(k in LIM_DEF)) return false;
  let n = +v;
  if (v === '' || v === null || !Number.isFinite(n) || n <= 0) return false;
  if (INT_LIM.includes(k)) n = Math.max(1, Math.round(n));
  // تناقض الحدود: حد الصفقة الواحدة لا يمكن أن يتجاوز الحد اليومي (وإلا تُحجب كل صفقة دائمًا)
  if (k === 'maxAmount' && n > LIM.maxDayStake) { EX.note = 'حد الصفقة (' + n + ') أكبر من الحد اليومي (' + LIM.maxDayStake + '): ارفع الحد اليومي أولًا'; return false; }
  if (k === 'maxDayStake' && n < LIM.maxAmount) { EX.note = 'الحد اليومي (' + n + ') أصغر من حد الصفقة (' + LIM.maxAmount + '): اخفض حد الصفقة أولًا'; return false; }
  LIM[k] = n; LSset(KEY_LIM, LIM);
  return true;
}
function loadLim() {
  const o = LSget(KEY_LIM, null);
  Object.assign(LIM, LIM_DEF);
  if (o && typeof o === 'object') for (const k in LIM_DEF) if (o[k] !== null && Number.isFinite(+o[k]) && +o[k] > 0) LIM[k] = INT_LIM.includes(k) ? Math.max(1, Math.round(+o[k])) : +o[k];
  // إعدادات محفوظة متناقضة (حد الصفقة > الحد اليومي): نرفع الحد اليومي ليسع صفقة واحدة على الأقل
  if (LIM.maxAmount > LIM.maxDayStake) { LIM.maxDayStake = LIM.maxAmount; LSset(KEY_LIM, LIM); }
}
function loadHist() {
  const a = LSget(KEY_EXH, []), now = Date.now();
  EX.hist = Array.isArray(a) ? a.filter(h => h && Number.isFinite(+h.t) && now - +h.t < 6048e5).slice(-500).map(h => ({
    t: +h.t, key: String(h.key || ''), amt: h.amt == null || !Number.isFinite(+h.amt) ? null : +h.amt, exp: +h.exp || 0, win: h.win === true ? true : h.win === false ? false : null,
    asset: h.asset ? String(h.asset) : '', dir: h.dir === 'call' || h.dir === 'put' ? h.dir : '', px: Number.isFinite(+h.px) ? +h.px : null, ets: Number.isFinite(+h.ets) ? +h.ets : null, est: !!h.est, tie: !!h.tie
  })) : [];
}
const saveHist = () => LSset(KEY_EXH, EX.hist.slice(-500));
function parseAmt(v) {
  if (v === null || v === undefined) return null;
  let t = String(v).replace(/[^\d.,]/g, '');
  if (!t) return null;
  const lc = t.lastIndexOf(','), ld = t.lastIndexOf('.');
  if (lc >= 0 && ld >= 0) t = lc > ld ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, ''); // آخر فاصل هو الكسري
  else if (lc >= 0) t = /^\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
  else if ((t.match(/\./g) || []).length > 1) t = t.replace(/\./g, '');
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}
const pnlOf = h => h.win === null || h.tie ? 0 : h.win ? (h.amt || 0) * CFG.payout : -(h.amt || 0);
function limitStats(now = Date.now()) {
  const day = new Date(now).toDateString();
  const today = EX.hist.filter(h => new Date(h.t).toDateString() === day);
  let row = 0;
  for (let i = today.length - 1; i >= 0; i--) { if (today[i].tie) continue; if (today[i].win === false) row++; else if (today[i].win === true) break; }
  return {
    day: today.length, hour: EX.hist.filter(h => now - h.t < 36e5).length,
    stake: today.reduce((a, h) => a + (h.amt || 0), 0), net: today.reduce((a, h) => a + pnlOf(h), 0), row,
    open: EX.hist.some(h => now < h.exp), unrecorded: EX.hist.filter(h => h.win === null && now >= h.exp)
  };
}
function limitsCheck(amt) {
  const out = [], L = limitStats();
  if (amt === null) out.push('تعذّرت قراءة مبلغ الصفقة: لا يمكن التحقق من الحدود');
  else if (!(amt > 0)) out.push('مبلغ الصفقة غير صالح');
  else {
    if (amt > LIM.maxAmount) out.push('المبلغ ' + amt + ' يتجاوز حد الصفقة ' + LIM.maxAmount);
    if (L.stake + amt > LIM.maxDayStake) out.push('إجمالي مبالغ اليوم سيتجاوز ' + LIM.maxDayStake + ' (المنفَّذ اليوم ' + +L.stake.toFixed(2) + ' + هذه الصفقة ' + amt + ')');
  }
  if (L.day >= LIM.maxPerDay) out.push('بلغت حد الصفقات اليومي (' + LIM.maxPerDay + ')');
  if (L.hour >= LIM.maxPerHour) out.push('بلغت حد الصفقات بالساعة (' + LIM.maxPerHour + ')');
  if (L.open) out.push('توجد صفقة منفّذة لم تنتهِ بعد');
  if (L.row >= LIM.maxLossRow) out.push('خسائر متتالية مسجّلة ×' + L.row + ' (الحد ' + LIM.maxLossRow + ')');
  if (L.net <= -LIM.maxDayLoss) out.push('بلغت حد الخسارة اليومي (' + LIM.maxDayLoss + ')');
  return out;
}
function recordResult(t, win) {
  const h = EX.hist.find(x => x.t === +t);
  if (!h || h.win !== null || typeof win !== 'boolean') return false;
  h.win = win; saveHist();
  return true;
}
const execLateS = () => Math.min(20, Math.max(4, CFG.tf / 3)); // نافذة صلاحية الإشارة بعد فتح الشمعة التالية
const sigKey = (a, ct, d) => a + '|' + ct + '|' + d;
function currentSignal(asset) {
  const r = asset ? S.sigBy[asset] : null, P = asset ? S.P[asset] : null;
  if (!asset || !r || r.d === 'none') return { ok: false, dir: null, why: ['لا توجد توصية حالية'] };
  const dir = r.d, why = [], ts = S.tickTs[asset], px = S.lastPx[asset];
  if (r.conf < CFG.minConf) why.push('الثقة أقل من الحد الأدنى');
  if (!P || !P.ok || P.dir !== dir) why.push('الإشارة غير مؤكدة (شمعة غير مكتملة)');
  const key = P ? sigKey(asset, P.ct, dir) : '';
  let left = null, expired = false;
  if (!Number.isFinite(ts) || !Number.isFinite(px)) why.push('لا يوجد سعر حالي');
  else if (P) {
    left = execLateS() - (ts - (P.ct + CFG.tf));
    // الصلاحية بالتوقيت الفعلي أيضًا: لو توقفت التيكات لا تبقى الإشارة صالحة
    if (P.at) left = Math.min(left, execLateS() - (Date.now() - P.at) / 1000);
    if (left < 0) { why.push('انتهت صلاحية الإشارة'); expired = true; }
    if (P.atr > 0 && Number.isFinite(P.entry) && Math.abs(px - P.entry) > CFG.maxDriftAtr * P.atr) { why.push('السعر ابتعد عن سعر الإشارة'); expired = true; }
  }
  if (Date.now() - (S.lastRx[asset] || 0) > CFG.maxTickAgeMs) why.push('بيانات قديمة');
  if (S.wsUp === false) why.push('انقطاع اتصال البيانات');
  else if (S.wsUpAt && Date.now() - S.wsUpAt < 3000) why.push('اتصال جديد: بانتظار استقرار البيانات');
  if (S.loading) why.push('جارٍ تحميل التاريخ');
  const ac = verifyActiveAsset(asset);
  if (!ac.ok) why.push(ac.why);
  if (EX.halted) why.push('التنفيذ موقوف' + (EX.haltWhy ? ': ' + EX.haltWhy : ''));
  if (key && EX.sent[key]) why.push('نُفّذت هذه الإشارة سابقًا');
  return { ok: !why.length, expired, dir, why, key, asset, conf: r.conf, ct: P ? P.ct : null, tf: CFG.tf, price: Number.isFinite(px) ? px : null, left };
}
const BTN_SEL = {
  call: ['.action-high-low .btn-call', 'a.btn-call', '.btn-call', '[class*="btn-call"]', '[data-action="call"]'],
  put: ['.action-high-low .btn-put', 'a.btn-put', '.btn-put', '[class*="btn-put"]', '[data-action="put"]']
};
function usable(el) {
  try {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true' || (el.classList && el.classList.contains('disabled'))) return false;
    if (typeof getComputedStyle === 'function' && el.getBoundingClientRect) {
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      if (!(r.width > 0 && r.height > 0) || cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
  } catch (e) {}
  return true;
}
function findTradeButton(dir) {
  for (const sel of BTN_SEL[dir] || []) {
    try { const el = document.querySelector(sel); if (el && usable(el)) return el; } catch (e) {}
  }
  return null;
}
// خانة المبلغ: محددات معروفة أولًا، ثم أي حقل رقمي قريب من نص «المبلغ/Amount» (استبعاد حقل الزمن 00:00:00)
function findAmountInput() {
  for (const sel of ['.block--bet-amount input', 'input[class*="amount"]']) {
    try { const el = document.querySelector(sel); if (el && String(el.value || '').trim()) return el; } catch (e) {}
  }
  try {
    for (const i of document.querySelectorAll('input')) {
      const v = String(i.value || '').trim();
      if (!v || v.indexOf(':') >= 0 || parseAmt(v) === null) continue;
      let p = i;
      for (let d = 0; d < 4 && p; d++) {
        p = p.parentElement;
        const t = p && String(p.textContent || '');
        if (t && t.length < 80 && /المبلغ|Amount/i.test(t)) return i;
      }
    }
  } catch (e) {}
  return null;
}
function platformInfo() {
  const dur = readExpiry();
  const am = findAmountInput(), amount = am ? String(am.value).trim() : null;
  return { dur, amount, durOK: dur === null || dur === CFG.tf, durKnown: dur !== null };
}
// ملخص ما سيُنفَّذ: الأصل والاتجاه ومدة الصفقة وقيمة الدخول (سعر + مبلغ المنصة) قبل أي إرسال
function execSummary(s) {
  const pf = platformInfo(), warns = [], blockers = [];
  if (!pf.durOK) blockers.push('مدة المنصة ' + pf.dur + ' ث لا تطابق مدة الإشارة ' + CFG.tf + ' ث');
  if (!pf.durKnown) warns.push('تعذّرت قراءة مدة المنصة: تحقق منها يدويًا (' + hzLabel(1) + ')');
  const amt = parseAmt(pf.amount);
  limitsCheck(amt).forEach(x => blockers.push(x));
  const unrec = limitStats().unrecorded.length;
  if (unrec) warns.push('لديك ' + unrec + ' صفقة منتهية بلا نتيجة مسجّلة (تؤثر على حدود الخسارة)');
  try {
    const r = S.sigBy[s.asset], g = gate(r, getA(s.asset));
    if (!g.ok) warns.push('البوابة: ' + g.why);
  } catch (e) {}
  return {
    asset: s.asset, dir: s.dir, dirLabel: s.dir === 'call' ? '▲ شراء (CALL)' : '▼ بيع (PUT)',
    durLabel: hzLabel(1) + (pf.durKnown ? ' (المنصة: ' + pf.dur + ' ث)' : ''),
    price: s.price, amount: pf.amount, amt, conf: s.conf, warns, blockers
  };
}
// فتح نافذة التأكيد (لا يُرسل شيء هنا)
function requestExec(dir) {
  const s = currentSignal(S.cur);
  if (!s.ok) return { ok: false, why: s.why.join(' | ') };
  if (s.dir !== dir) return { ok: false, why: 'الاتجاه المطلوب لا يطابق التوصية الحالية' };
  const sm = execSummary(s);
  if (sm.blockers.length) return { ok: false, why: sm.blockers.join(' | ') };
  EX.modal = { ...s, at: Date.now(), sm };
  return { ok: true };
}
// تنفيذ تلقائي حقيقي (اختياري، يُفعَّل يدويًا لكل جلسة، ويمر بنفس كل الفحوص: صلاحية، حدود، منع تكرار، إيقاف، بوابة الإثبات إن كانت مفعّلة)
function setAuto(on) {
  if (on && EX.halted) return false;
  EX.auto = !!on; EX.autoWhy = '';
  CFG.auto = EX.auto; try { saveCfg(); } catch (e) {} // مفتاح واحد: الدخول الآلي = حقيقي، ويُحفظ
  return true;
}
function autoRun(asset) {
  if (!EX.auto || EX.busy || EX.modal) return null;
  const s = currentSignal(asset);
  if (!s.ok) { EX.autoWhy = 'لم يُنفَّذ: ' + s.why.join(' | '); return null; }
  if (CFG.gate) {
    const g = gate(S.sigBy[asset], getA(asset));
    if (!g.ok) { EX.autoWhy = 'لم يُنفَّذ — البوابة: ' + g.why; return null; }
  }
  EX.modal = { ...s, at: Date.now(), mode: 'auto' };
  const r = confirmExec();
  EX.autoWhy = r.ok ? 'نُفّذت آخر إشارة تلقائيًا' : 'لم يُنفَّذ: ' + r.why;
  return r;
}
// نتيجة تقديرية للصفقات الحقيقية من التيك (سعر الدخول عند النقر مقابل سعر الانتهاء): تُغذّي حدود الخسارة تلقائيًا.
// قد تختلف قليلًا عن نتيجة المنصة؛ يمكنك تصحيحها يدويًا من أزرار ربح/خسارة إن لم تُسجَّل.
function resolveReal(asset, p, ts) {
  let ch = false;
  for (const h of EX.hist) {
    if (h.win !== null || h.asset !== asset || !h.ets || !Number.isFinite(h.px)) continue;
    const end = h.ets + CFG.tf;
    if (ts < end) continue;
    if (ts - end <= CFG.lateTolS && p !== h.px) { h.win = (h.dir === 'call') === (p > h.px); h.est = true; ch = true; }
    else if (ts - end <= CFG.lateTolS) { h.win = false; h.tie = true; h.est = true; ch = true; } // تعادل: يُردّ المبلغ (لا ربح ولا خسارة)
  }
  if (ch) saveHist();
}
function cancelExec(note) { EX.modal = null; if (note) EX.note = note; }
// التأكيد: يُستهلك مرة واحدة، ويُعاد التحقق من كل شيء لحظة النقر (قد تكون الإشارة تغيّرت أو انتهت أثناء فتح النافذة)
// إيقاف فوري: يغلق نافذة التأكيد ويمنع أي إرسال حتى يستأنف المستخدم يدويًا. الحالة تبقى بعد إعادة تحميل الصفحة.
function execStop(why) {
  EX.halted = true; EX.haltWhy = why || 'إيقاف يدوي';
  EX.auto = false; CFG.auto = false; try { saveCfg(); } catch (e) {}
  EX.modal = null;
  LSset(KEY_EXS, { h: true, w: EX.haltWhy, at: Date.now() });
  logErr('EXEC_STOP', EX.haltWhy);
  return true;
}
function execResume() {
  EX.halted = false; EX.haltWhy = '';
  LSset(KEY_EXS, { h: false });
  return true;
}
function loadSent() {
  const st = LSget(KEY_EXS, null);
  EX.halted = !!(st && st.h === true); EX.haltWhy = EX.halted ? String(st.w || '') : '';
  const o = LSget(KEY_SENT, {}), now = Date.now();
  EX.sent = {};
  if (o && typeof o === 'object') for (const k in o) if (Number.isFinite(+o[k]) && now - +o[k] < 864e5) EX.sent[k] = +o[k];
}
function saveSent() {
  const now = Date.now();
  for (const k in EX.sent) if (now - EX.sent[k] >= 864e5) delete EX.sent[k];
  return LSset(KEY_SENT, EX.sent);
}
function confirmExec() {
  if (EX.busy) return { ok: false, why: 'عملية تنفيذ جارية' };
  EX.busy = true;
  try { return doConfirm(); }
  catch (e) {
    // خطأ غير متوقع: لا إعادة محاولة تلقائية أبدًا. إن كان بعد النقر فالإشارة مسجّلة كمنفّذة أصلًا.
    EX.modal = null;
    EX.note = 'خطأ غير متوقع: تحقق من المنصة يدويًا قبل أي محاولة جديدة';
    logErr('EXEC_ERR', String(e && e.message || e));
    return { ok: false, why: EX.note };
  }
  finally { EX.busy = false; }
}
function doConfirm() {
  const m = EX.modal;
  if (!m) return { ok: false, why: 'لا توجد نافذة تأكيد مفتوحة' };
  EX.modal = null;
  const fail = why => { EX.note = why; logErr('EXEC_BLOCKED', why, { asset: m.asset, dir: m.dir }); return { ok: false, why }; };
  const s = currentSignal(m.asset);
  if (!s.ok || s.key !== m.key) return fail('لم يُرسل: تغيّرت الإشارة أو انتهت صلاحيتها (' + (s.why || []).join(' | ') + ')');
  const sm = execSummary(s);
  if (sm.blockers.length) return fail('لم يُرسل: ' + sm.blockers.join(' | '));
  const btn = findTradeButton(s.dir);
  if (!btn) { try { const c = [...document.querySelectorAll('a,button,div')].filter(x => /call|put|higher|lower|high|low/i.test(String(x.className || ''))).slice(0, 8).map(x => x.tagName + '.' + String(x.className).slice(0, 60)); logErr('BTN_NOT_FOUND', c.join(' | ') || 'لا مرشحين'); } catch (e) {} }
  if (!btn) return fail('لم يُرسل: لم يُعثر على زر ' + (s.dir === 'call' ? 'CALL' : 'PUT') + ' ظاهر ومفعّل في المنصة');
  // نسجّل الإشارة كمنفَّذة قبل النقر مباشرة وبشكل دائم: لو تعطّل أي شيء بعده لا تتكرر
  // إن تعذّر الحفظ الدائم لا نرسل أصلًا: بدونه لا نضمن منع التكرار بعد إعادة التحميل
  const h = { t: Date.now(), key: s.key, amt: sm.amt, exp: Date.now() + (CFG.tf + 5) * 1000, win: null, asset: s.asset, dir: s.dir, px: s.price, ets: S.tickTs[s.asset], est: false };
  EX.sent[s.key] = h.t; EX.hist.push(h);
  if (!saveSent() || !saveHist()) {
    delete EX.sent[s.key]; EX.hist.pop();
    return fail('لم يُرسل: تعذّر حفظ سجل منع التكرار في المتصفح');
  }
  let unsure = '';
  try { btn.click(); } catch (e) { unsure = String(e && e.message || e); }
  const e = { t: Date.now(), asset: s.asset, dir: s.dir, conf: s.conf, entry: s.price, ct: s.ct, exit: null, win: null, auto: false, try: false, manual: true, proven: false, reason: m.mode === 'auto' ? 'تنفيذ تلقائي حقيقي' : 'تنفيذ يدوي مؤكد' };
  if (unsure) { e.reason = 'غير مؤكد: ' + unsure.slice(0, 60); e.unc = true; }
  S.log.unshift(e);
  if (S.log.length > 200) S.log.pop();
  simTrace('manual_sent', { asset: s.asset, dir: s.dir, px: s.price, unsure: !!unsure });
  saveLog();
  if (unsure) {
    // لا إعادة محاولة: قد تكون المنصة استقبلت الأمر. المستخدم هو من يتحقق ويقرر.
    logErr('EXEC_UNSURE', unsure, { asset: s.asset, dir: s.dir });
    EX.note = 'حدث خطأ أثناء النقر وقد تكون الصفقة أُرسلت. تحقق من المنصة. لن يُعاد الإرسال تلقائيًا ولن تُنفَّذ هذه الإشارة ثانية.';
    return { ok: false, unsure: true, why: EX.note };
  }
  EX.note = 'تم نقر زر ' + (s.dir === 'call' ? 'CALL' : 'PUT') + ' في المنصة. تحقق من فتح الصفقة هناك (لا يوجد تأكيد برمجي من المنصة).';
  return { ok: true };
}

// ================= اعتراض WebSocket (قراءة فقط) =================
let expect = null, expectWs = null, chain = Promise.resolve();
const toText = d => d instanceof Blob ? d.text() : Promise.resolve(new TextDecoder().decode(d));
function handle(kind, j) {
  try {
    if (kind === 'stream' && Array.isArray(j)) j.forEach(x => { if (Array.isArray(x) && x.length >= 3) feedTick(String(x[0]), +x[1], +x[2]); });
    if (kind === 'hist' && j && j.asset && Array.isArray(j.history)) {
      const a = j.asset;
      S.loading = true;
      S.candles[a] = []; S.P[a] = null;
      const A = getA(a);
      for (const k in A.s) A.s[k].hn = A.s[k].hw = 0;
      for (const k in A.b) A.b[k].hn = A.b[k].hw = 0;
      for (const k in A.z) A.z[k].hn = A.z[k].hw = 0;
      S.SH[a] = []; S.sdh[a] = [];
      A.e.hn = A.e.hw = 0;
      j.history.forEach(x => feedTick(a, +x[0], +x[1]));
      S.loading = false;
      S.loadedCount = j.history.length;
      try { rebuildClusters(); evalVariants(); } catch (e) { logErr('VAR_ERR', String(e && e.message || e)); }
    }
  } catch (e) { S.loading = false; logErr('HANDLE', String(e && e.message || e)); }
}
const liveSockets = new Set();
let wsDownTimer = null;
const WS_GRACE_MS = 3000; // مهلة قبل اعتبار الانقطاع حقيقيًا (إعادة اتصال المنصة العادية تستغرق ثوانٍ قليلة)
function onMsg(ev) {
  const d = ev.data;
  if (typeof d === 'string') {
    if (/^45\d-/.test(d)) {
      expect = d.includes('updateStream') ? 'stream' : /updateHistoryNew/.test(d) ? 'hist' : null;
      expectWs = expect ? ev.target : null;
      return;
    }
    const m = /^42\d*(\[[\s\S]*)$/.exec(d);
    if (m) {
      try {
        const j = JSON.parse(m[1]);
        if (j[0] === 'updateStream') handle('stream', j[1]);
        else if (/^updateHistoryNew/.test(j[0])) handle('hist', j[1]);
      } catch (e) {}
    }
    return;
  }
  if (expect && (!expectWs || ev.target === expectWs)) {
    const kind = expect; expect = null; expectWs = null;
    chain = chain.then(() => toText(d)).then(t => handle(kind, JSON.parse(t))).catch(e => { logErr('WS_PARSE', String(e && e.message || e)); });
  }
}
const NativeWS = window.WebSocket;
if (NativeWS) {
  window.WebSocket = function (url, proto) {
    const ws = proto !== undefined ? new NativeWS(url, proto) : new NativeWS(url);
    ws.addEventListener('message', onMsg);
    ws.addEventListener('open', () => {
      liveSockets.add(ws); S.wsUp = true; S.wsUpAt = Date.now();
      if (wsDownTimer) { clearTimeout(wsDownTimer); wsDownTimer = null; } // رجع الاتصال خلال المهلة: لا انقطاع فعلي
    });
    ws.addEventListener('close', () => {
      const wasLive = liveSockets.delete(ws);
      if (expectWs === ws) { expect = null; expectWs = null; } // لا نفسّر رسالة ثنائية قادمة من اتصال مغلق
      if (!wasLive) return;            // اتصال فشل قبل أن يفتح: ليس انقطاعًا جديدًا
      if (liveSockets.size) return;    // ما زال هناك اتصال حي آخر
      S.wsUp = false;                  // نوقف الدخول فورًا
      if (wsDownTimer) return;         // الانقطاع مسجَّل قيد المهلة أصلًا
      wsDownTimer = setTimeout(() => { // لكن لا نسجّل خطأ ولا نُلغي صفقة إلا لو طال الانقطاع
        wsDownTimer = null;
        if (liveSockets.size) return;
        logErr('WS_DOWN', 'انقطع اتصال WebSocket');
        onWsDown();
      }, WS_GRACE_MS);
    });
    return ws; // v2.5: لا نعترض send ولا نرسل شيئًا
  };
  window.WebSocket.prototype = NativeWS.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(k => { window.WebSocket[k] = NativeWS[k]; });
}
restore();
loadLim(); loadHist(); loadSent(); loadSV();
EX.auto = CFG.auto && !EX.halted; // v3.3: يستمر التنفيذ الحقيقي بعد إعادة تحميل الصفحة ما لم تضغط إيقاف
idbRestore();

// ================= العرض والبيانات =================
const pc = (x, d = 0) => (x * 100).toFixed(d) + '%';
function resLabel(e) {
  if (e.win === null) return e.manual ? 'مُرسلة للمنصة' : e.failed ? 'مرفوض' : e.voided ? 'ملغاة' : e.unc ? 'غير مؤكد' : e.stale ? '؟' : e.tie ? 'تعادل' : '...';
  return e.win ? 'ربح' : 'خسارة';
}
function simSummary() {
  const sim = S.log.filter(e => e.try);
  return {
    tried: sim.length,
    w: sim.filter(e => e.auto && e.win === true).length,
    l: sim.filter(e => e.auto && e.win === false).length,
    tie: sim.filter(e => e.tie).length,
    bad: sim.filter(e => e.failed || e.voided || e.unc).length
  };
}
function view() {
  const asset = S.cur, A = asset ? getA(asset) : null, r = asset ? S.sigBy[asset] : null;
  const arr = asset ? S.candles[asset] || [] : [];
  const g = gate(r, A || { b: {} }), be = BE();
  const vq = arr.length >= 60 ? verifyCandles(arr.slice(-CFG.window)) : { ok: false, why: 'لا يكفي' };
  const now = Date.now();
  const curRg = r && r.regime ? r.regime : '-';
  const strat = A ? STR.map(([k, kind]) => {
    const ak = vk(k), W = wtR(A, ak, curRg), [n, w] = A.s[ak] ? nw(A.s[ak]) : [0, 0];
    return { k, ak, kind, n, w, p: n ? w / n : 0, W };
  }).sort((a, b) => b.W.w - a.W.w) : [];
  const rows = strat.map(s => {
    const cls = s.W.mode === 'رابحة' ? 'u' : s.W.mode === 'عكسية' ? 'g' : s.W.mode === 'معطلة' || s.W.mode === 'متدهورة' ? 'd' : 'm';
    return `<tr><td>${NM[s.k]}${s.ak !== s.k ? ' <small class="note">✦ معدّلة</small>' : ''}</td><td>${s.kind === 'T' ? 'اتجاه' : s.kind === 'R' ? 'ارتداد' : 'نمط'}</td><td>${s.n}</td><td>${s.n ? pc(s.p, 1) : '-'}</td><td>${s.n ? pc(s.W.lb, 0) : '-'}</td><td><i class="wb" style="width:${Math.min(100, s.W.w * 80)}%"></i></td><td><span class="chip c-${cls}">${s.W.mode}</span><small class="note"> ${s.W.src}${s.W.rg ? ' · ' + curRg : ''}${s.W.rp !== undefined ? ' · آخر' + CFG.driftN + ': ' + pc(s.W.rp, 0) : ''}</small></td></tr>`;
  }).join('');
  const bks = A ? Object.keys(A.b).sort().map(k => {
    const n = A.b[k].ln, w = A.b[k].lw, acc = n ? w / n : 0, ok = n >= CFG.minLive && wil(n, w, CFG.gateZ) > be;
    return `<tr><td>${k}%+</td><td>${n}</td><td>${n ? pc(acc, 1) : '-'}</td><td><span class="chip c-${ok ? 'u' : 'm'}">${ok ? 'مسموحة' : n < CFG.minLive ? 'عينة ' + n + '/' + CFG.minLive : 'غير مثبتة'}</span></td></tr>`;
  }).join('') : '';
  const log = S.log.slice(0, 60).map(e => {
    const tm = new Date(e.t).toTimeString().slice(0, 8);
    return `<tr><td>${tm}</td><td>${e.dir === 'call' ? '▲ شراء' : '▼ بيع'}</td><td>${e.conf}%</td><td>${e.manual ? (String(e.reason || '').includes('تلقائي') ? 'آلي حقيقي' : 'يدوي') : e.auto ? 'محاكاة' : e.try ? 'محاولة' : 'إشارة'}</td><td class="${e.win === null ? '' : e.win ? 'w' : 'l'}">${resLabel(e)}</td></tr>`;
  }).join('');
  const [en, ew] = A ? nw(A.e) : [0, 0];
  const sessW = S.log.filter(e => e.win === true).length, sessL = S.log.filter(e => e.win === false).length;
  let lifeW = 0, lifeL = 0;
  for (const a in S.A) { lifeW += S.A[a].e.lw + S.A[a].e.hw; lifeL += (S.A[a].e.ln - S.A[a].e.lw) + (S.A[a].e.hn - S.A[a].e.hw); }
  const cd = asset && S.lastTs[asset] && arr.length ? Math.max(0, CFG.tf - (S.lastTs[asset] - arr[arr.length - 1].t)) : null;
  const paused = now < S.pausedUntil, cooling = now < S.cdUntil;
  const best = A ? bestBucket(A) : null;
  const ageMs = asset && S.lastRx[asset] ? now - S.lastRx[asset] : null;
  const ac = asset ? verifyActiveAsset(asset) : { ok: false, why: 'لا أصل' };
  const checks = [
    { ok: arr.length >= 60, t: 'شموع كافية (' + arr.length + '/60)' },
    { ok: vq.ok, t: 'جودة البيانات: ' + vq.why },
    { ok: !!r && r.d !== 'none', t: 'إشارة قوية موجودة' },
    { ok: !!r && r.d !== 'none' && r.htfOK && r.htf !== 0, t: 'توافق مع الإطار الأعلى' },
    { ok: g.ok, t: 'بوابة الإثبات: ' + g.why },
    { ok: ageMs !== null && ageMs <= CFG.maxTickAgeMs && S.wsUp !== false, t: 'بيانات حديثة واتصال سليم' + (ageMs !== null ? ' (' + Math.round(ageMs / 1000) + 'ث)' : '') },
    { ok: ac.ok, t: 'الأصل المعروض (معلومة): ' + ac.why },
    { ok: !cooling && !paused && !S.halted, t: 'لا تهدئة ولا إيقاف' }
  ];
  const meta = LSget(KEY_META, null);
  const ss = simSummary();
  return {
    asset, r, g, n: arr.length, rows, bks, log, en, ew, acc: en ? ew / en : 0, be, cd,
    liveN: A ? A.e.ln : 0, liveW: A ? A.e.lw : 0, liveLb: A && A.e.ln ? wil(A.e.ln, A.e.lw, 1.64) : 0,
    price: arr.length ? arr[arr.length - 1].c : null, checks, paused, cooling,
    loaded: S.loadedCount, sessW, sessL, lifeW, lifeL, best, savedAt: meta && meta.at,
    logCount: S.log.length, sim: ss, errRate: ss.tried ? ss.bad / ss.tried : 0
  };
}
function drawChart(cv) {
  const all = S.candles[S.cur] || [];
  const arr = all.slice(-90);
  const ctx = cv.getContext('2d');
  const dpr = (typeof devicePixelRatio !== 'undefined' && devicePixelRatio) || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W) return;
  if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (arr.length < 3) {
    ctx.fillStyle = '#8d9ad0'; ctx.font = '14px sans-serif';
    ctx.fillText('بانتظار البيانات...', 20, 30);
    return;
  }
  let hi = -1e9, lo = 1e9;
  arr.forEach(c => { hi = Math.max(hi, c.h); lo = Math.min(lo, c.l); });
  const pad = (hi - lo) * .08 || 1e-6; hi += pad; lo -= pad;
  const y = v => H - (v - lo) / (hi - lo) * H, cw = W / arr.length;
  ctx.strokeStyle = '#26336e88'; ctx.lineWidth = 1;
  for (let i = 1; i < 5; i++) { ctx.beginPath(); ctx.moveTo(0, H * i / 5); ctx.lineTo(W, H * i / 5); ctx.stroke(); }
  arr.forEach((c, i) => {
    const x = i * cw + cw / 2, up = c.c >= c.o;
    ctx.strokeStyle = ctx.fillStyle = up ? '#3ddbb0' : '#ff6b7a';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(x, y(c.h)); ctx.lineTo(x, y(c.l)); ctx.stroke();
    ctx.fillRect(x - cw * .32, Math.min(y(c.o), y(c.c)), cw * .64, Math.max(1.5, Math.abs(y(c.o) - y(c.c))));
  });
  const closes = all.map(c => c.c);
  [[9, '#f5c45e'], [21, '#7aa2ff']].forEach(([n, col]) => {
    const e = ema(closes, n).slice(-arr.length);
    ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.beginPath();
    e.forEach((v, i) => { const x = i * cw + cw / 2; i ? ctx.lineTo(x, y(v)) : ctx.moveTo(x, y(v)); });
    ctx.stroke();
  });
  S.log.filter(e => e.asset === S.cur).forEach(e => {
    const i = arr.findIndex(c => c.t === e.ct + CFG.tf);
    if (i < 0) return;
    const x = i * cw + cw / 2, yy = y(e.entry);
    ctx.fillStyle = e.win === null ? '#f5c45e' : e.win ? '#3ddbb0' : '#ff6b7a';
    ctx.beginPath();
    if (e.dir === 'call') { ctx.moveTo(x, yy - 9); ctx.lineTo(x - 6, yy + 2); ctx.lineTo(x + 6, yy + 2); }
    else { ctx.moveTo(x, yy + 9); ctx.lineTo(x - 6, yy - 2); ctx.lineTo(x + 6, yy - 2); }
    ctx.fill();
  });
}

// ================= النسخ الاحتياطي =================
function buildExport() { return { app: 'wsnf smart bot', v: VERSION, at: Date.now(), live: snapshot(), log: S.log.slice(0, 200), journal: S.journal, cfg: cfgSnap() }; }
function download(name, obj, pretty) {
  const blob = new Blob([JSON.stringify(obj, null, pretty ? 1 : 0)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); // تنزيل ملف فقط
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function exportData() { download('wsnf-memory-' + new Date().toISOString().slice(0, 10) + '.json', buildExport()); }
function importData(text) {
  const d = JSON.parse(text);
  if (!d || d.app !== 'wsnf smart bot' || !d.live || typeof d.live !== 'object') throw new Error('ملف غير صالح');
  if (S.open || S.pending) throw new Error('أوقف الصفقة المفتوحة أولًا');
  for (const a in S.A) delete S.A[a];
  applySnapshot(d.live);
  S.log = cleanLog(d.log);
  if (Array.isArray(d.journal)) S.journal = cleanJournal(d.journal);
  if (d.cfg) applyCfg(d.cfg, true);
  saveAll();
}
function diagnostics() {
  return {
    app: 'wsnf diag', v: '3.3', at: Date.now(), simOnly: SIM_ONLY, errors: S.errors, trace: S.trace, decision: S.decision,
    cfg: CFG, audit: S.audit, adopted: S.adopted, corr: corrReport(100, .8), simSummary: simSummary(),
    exec: { auto: EX.auto, halted: EX.halted, why: EX.haltWhy, autoWhy: EX.autoWhy, note: EX.note, lim: LIM, today: (() => { try { const L = limitStats(); return { day: L.day, hour: L.hour, stake: L.stake, net: L.net, row: L.row, open: L.open, unrecorded: L.unrecorded.length }; } catch (e) { return null; } })() },
    state: { halted: S.halted, why: S.haltWhy, wsUp: S.wsUp, shown: readShownAsset(), cur: S.cur, lock: S.lock, net: S.net, storeErr: S.storeErr }
  };
}

// ================= الواجهة =================
const CSS = `
:host{all:initial}*{box-sizing:border-box;margin:0}
.full{position:fixed;inset:0;z-index:2147483647;overflow:auto;direction:rtl;font:13px/1.6 "Segoe UI",Tahoma,sans-serif;color:#e8ecff;background:#070b1ef7;padding:18px;animation:fin .5s ease both}
.full::before{content:"";position:fixed;inset:-20%;background:radial-gradient(600px 400px at 80% 10%,#4b5bff33,transparent 70%),radial-gradient(500px 380px at 10% 90%,#3ddbb022,transparent 70%);animation:drift 18s ease-in-out infinite alternate;pointer-events:none;z-index:-1}
@keyframes drift{from{transform:translate(0,0)}to{transform:translate(40px,-30px)}}
@keyframes fin{from{opacity:0;transform:scale(.985)}to{opacity:1;transform:none}}
.full.hide{display:none}
.splash{position:fixed;inset:0;z-index:2147483647;display:grid;place-content:center;justify-items:center;gap:18px;background:radial-gradient(circle at 50% 40%,#1b2a7a,#070b1e 70%);direction:rtl;transition:opacity .8s ease,visibility .8s}
.splash.out{opacity:0;visibility:hidden}
.sp-ring{position:absolute;width:260px;height:260px;border-radius:50%;border:2px solid transparent;border-top-color:#7aa2ff;border-right-color:#3ddbb0;animation:spin 1.6s linear infinite;opacity:.8}
.sp-ring.r2{width:200px;height:200px;border-top-color:#3ddbb0;border-right-color:transparent;animation-duration:1.1s;animation-direction:reverse}
@keyframes spin{to{transform:rotate(360deg)}}
.sp-logo{position:relative;font-size:46px;font-weight:900;letter-spacing:2px;display:flex;gap:2px;direction:ltr}
.sp-logo .ch{display:inline-block;background:linear-gradient(180deg,#fff,#7aa2ff 55%,#3ddbb0);-webkit-background-clip:text;background-clip:text;color:transparent;opacity:0;transform:translateY(-40px) scale(.6);animation:drop .7s cubic-bezier(.2,1.4,.4,1) forwards;animation-delay:calc(var(--i) * .08s + .2s)}
.sp-logo .sp{width:14px}
@keyframes drop{to{opacity:1;transform:none}}
.sp-sub{position:relative;color:#8fa0d6;font-size:13px;letter-spacing:1px;opacity:0;animation:fadeup .6s ease forwards 1.4s}
.sp-bar{position:relative;width:260px;height:4px;border-radius:4px;background:#1f2a60;overflow:hidden;opacity:0;animation:fadeup .4s ease forwards 1.2s}
.sp-bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#7aa2ff,#3ddbb0);box-shadow:0 0 12px #3ddbb0;animation:load 1.6s ease forwards 1.2s}
@keyframes load{to{width:100%}}
@keyframes fadeup{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px;padding:10px 14px;border:1px solid #1f2a60;border-radius:16px;background:linear-gradient(90deg,#0e1538cc,#0b1230cc)}
.brand{font-size:20px;font-weight:900;display:flex;gap:2px;align-items:center;letter-spacing:.5px;direction:ltr}
.brand .ch{display:inline-block;background:linear-gradient(180deg,#ffffff,#7aa2ff 60%,#3ddbb0);-webkit-background-clip:text;background-clip:text;color:transparent;animation:wave 2.6s ease-in-out infinite;animation-delay:calc(var(--i) * .09s)}
.brand .sp{width:6px}
.brand .dot{width:10px;height:10px;border-radius:50%;background:#3ddbb0;box-shadow:0 0 14px #3ddbb0;animation:pl 1.6s infinite;margin-inline-start:8px}
.brand small{color:#7f8cc4;font-weight:500;font-size:11.5px;margin-inline-start:8px;letter-spacing:0;direction:rtl}
@keyframes wave{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
@keyframes pl{50%{opacity:.35;transform:scale(.7)}}
.nav{display:flex;gap:6px;flex-wrap:wrap}
.nav button{border-radius:12px;padding:7px 14px;background:transparent;border:1px solid #26336e;color:#9fb0e6}
.nav button.on{background:linear-gradient(135deg,#3b4fd6,#1fa98a);color:#fff;border-color:transparent;box-shadow:0 6px 18px #3b4fd655}
.chips{display:flex;gap:8px;flex-wrap:wrap}
.chip{padding:2px 10px;border-radius:20px;font-size:11.5px;border:1px solid #26336e;background:#131c42;white-space:nowrap}
.c-u{color:#3ddbb0;border-color:#3ddbb066}.c-d{color:#ff6b7a;border-color:#ff6b7a66}.c-g{color:#f5c45e;border-color:#f5c45e66}.c-m{color:#8d9ad0}
button,select,input{font:inherit;color:#e8ecff;background:#131c42;border:1px solid #26336e;border-radius:10px;padding:6px 12px;cursor:pointer;transition:transform .15s,background .2s,border-color .2s,box-shadow .2s}
button:hover{transform:translateY(-1px);border-color:#4a5bb0;box-shadow:0 4px 14px #0006}
button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #f5c45e}
.page{display:none;animation:fin .35s ease both}
.page.on{display:grid;gap:14px}
.p-home{grid-template-columns:340px 1fr}
.p-chart,.p-log{grid-template-columns:1fr}
.p-strat{grid-template-columns:1.3fr 1fr}
@media(max-width:1000px){.p-home,.p-strat{grid-template-columns:1fr}}
.card{background:linear-gradient(160deg,#16204bd9,#0c1334d9);border:1px solid #1f2a60;border-radius:18px;padding:14px;box-shadow:0 14px 34px #0007;animation:fin .5s ease both;position:relative;overflow:hidden}
.card h3{font-size:12.5px;color:#8fa0d6;font-weight:700;margin-bottom:10px;letter-spacing:.3px;display:flex;justify-content:space-between;align-items:center;gap:8px}
.hero{text-align:center;transition:box-shadow .5s,border-color .5s}
.hero.u{border-color:#3ddbb0;box-shadow:0 0 44px #3ddbb033}
.hero.d{border-color:#ff6b7a;box-shadow:0 0 44px #ff6b7a33}
.gw{position:relative;width:190px;height:190px;margin:6px auto}
.gw svg{width:100%;height:100%;transform:rotate(-90deg)}
.gw circle{fill:none;stroke-width:10;stroke-linecap:round}
.gbg{stroke:#1f2a60}
.gfg{stroke:#8d9ad0;stroke-dasharray:326.7;stroke-dashoffset:326.7;transition:stroke-dashoffset 1s cubic-bezier(.2,.8,.2,1),stroke .4s;filter:drop-shadow(0 0 6px currentColor)}
.gm{position:absolute;inset:0;display:grid;place-content:center}
.gm b{font-size:30px;font-weight:900}
.arrow{font-size:34px;line-height:1;transition:transform .4s}
.hero.u .arrow{animation:bob 1.2s ease-in-out infinite}
.hero.d .arrow{animation:bob 1.2s ease-in-out infinite reverse}
@keyframes bob{50%{transform:translateY(-5px)}}
.dirT{font-size:19px;font-weight:800;margin:6px 0}
.notes{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin:8px 0}
.cdb{height:6px;border-radius:6px;background:#1f2a60;overflow:hidden;margin-top:8px}
.cdb i{display:block;height:100%;width:0;background:linear-gradient(90deg,#7aa2ff,#3ddbb0);transition:width 1s linear}
.row{display:flex;gap:8px;align-items:center;justify-content:space-between;margin:8px 0;flex-wrap:wrap}
.tgl{min-width:130px;font-weight:700}
.tgl.on{background:linear-gradient(135deg,#3ddbb0,#1fa98a)!important;color:#06281f!important;border-color:transparent!important}
.checks{list-style:none;padding:0;display:grid;gap:6px}
.checks li{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;padding:6px 8px;border-radius:10px;background:#0a0f2a88;border:1px solid #1f2a60}
.checks li b{width:16px;text-align:center;flex:none}
.checks li.ok b{color:#3ddbb0}.checks li.no b{color:#ff6b7a}
.checks li.ok{border-color:#3ddbb044}
.score{display:flex;align-items:center;justify-content:space-around;gap:10px;padding:6px 0}
.score div{text-align:center}
.score b{display:block;font-size:44px;font-weight:900;line-height:1;text-shadow:0 0 22px currentColor}
.score span{color:#8fa0d6;font-size:12px}
.score .vs{font-size:30px;color:#3b4a88;text-shadow:none}
.wr{height:10px;border-radius:10px;background:#1f2a60;overflow:hidden;margin-top:12px}
.wr i{display:block;height:100%;width:0;background:linear-gradient(90deg,#ff6b7a,#f5c45e,#3ddbb0);transition:width .8s cubic-bezier(.2,.8,.2,1)}
.wrt{display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;font-size:11.5px;color:#8fa0d6;margin-top:4px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.st{background:#0a0f2a99;border:1px solid #1f2a60;border-radius:12px;padding:8px 10px}
.st span{color:#8fa0d6;font-size:11px;display:block}
.st b{display:block;font-size:17px}
.st small{font-size:11px;color:#8fa0d6}
.mem{display:grid;gap:8px;font-size:12px}
.mem .row{margin:0}
canvas{width:100%;height:420px;display:block;border-radius:12px;background:#0a0f29}
table{width:100%;border-collapse:collapse;font-size:12px}
th{color:#8fa0d6;font-weight:600;text-align:right;padding:6px 5px;position:sticky;top:0;background:#0f1638}
td{padding:6px 5px;border-top:1px solid #1f2a6088}
tbody tr{transition:background .2s}tbody tr:hover{background:#1a2456aa}
.wb{display:block;height:6px;border-radius:6px;background:linear-gradient(90deg,#7aa2ff,#3ddbb0)}
.w{color:#3ddbb0}.l{color:#ff6b7a}
.scroll{max-height:480px;overflow:auto}
.note{color:#8fa0d6;font-size:11.5px;line-height:1.8}
.warn{color:#f5c45e}
.btn-danger{color:#ff8a95;border-color:#ff6b7a55}
.modal{position:fixed;inset:0;display:none;place-items:center;background:#020510aa;z-index:2147483647;direction:rtl;font:13px/1.6 "Segoe UI",Tahoma,sans-serif;color:#e8ecff}
.modal.show{display:grid}
.mbox{width:min(460px,92vw);padding:18px;border-radius:20px;background:linear-gradient(160deg,#16204b,#0c1334);border:2px solid #4a5bb0;box-shadow:0 20px 60px #000c;animation:fin .25s ease both}
.mbox h2{font-size:17px;margin-bottom:10px}
.mok{background:linear-gradient(135deg,#3b4fd6,#1fa98a);border-color:transparent;font-weight:800}
.mok:disabled{opacity:.35;cursor:not-allowed}
.exbtns{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.ex{padding:14px 8px;font-size:16px;font-weight:900;border-radius:14px;letter-spacing:.3px}
.ex.call:not(:disabled){background:linear-gradient(135deg,#3ddbb0,#1fa98a);color:#06281f;border-color:transparent}
.ex.put:not(:disabled){background:linear-gradient(135deg,#ff6b7a,#d63a4b);color:#2a060b;border-color:transparent}
.ex:disabled{opacity:.35;cursor:not-allowed;transform:none;box-shadow:none}
.ex:not(:disabled){animation:pl 1.4s infinite}
.shine::after{content:"";position:absolute;inset:0;background:linear-gradient(110deg,transparent 30%,#ffffff12 50%,transparent 70%);transform:translateX(-100%);animation:shine 5s ease-in-out infinite;pointer-events:none}
@keyframes shine{0%,60%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
.flash{position:fixed;inset:0;display:none;place-items:center;pointer-events:none;z-index:2147483646}
.flash.show{display:grid}
.fbox{padding:26px 38px;border-radius:24px;text-align:center;background:#0b1230e6;border:2px solid;box-shadow:0 0 60px currentColor;animation:pop 2.2s ease forwards}
.fbox b{display:block;font-size:44px;font-weight:900;letter-spacing:1px}
.fbox span{font-size:14px;color:#c9d3ff}
.flash.call .fbox,.flash.win .fbox{color:#3ddbb0}
.flash.put .fbox,.flash.loss .fbox{color:#ff6b7a}
@keyframes pop{0%{opacity:0;transform:scale(.4) rotate(-6deg)}12%{opacity:1;transform:scale(1.08) rotate(0)}22%{transform:scale(1)}78%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(.96)}}
.tick{display:flex;gap:6px;overflow:hidden;white-space:nowrap;flex-wrap:wrap}
.tick span{padding:3px 10px;border-radius:8px;font-size:11.5px;animation:slide .6s ease both;border:1px solid #26336e}
@keyframes slide{from{transform:translateY(-8px);opacity:0}to{transform:none;opacity:1}}
.mini{position:fixed;z-index:2147483647;width:74px;height:74px;border-radius:20px;display:none;place-content:center;text-align:center;cursor:pointer;user-select:none;touch-action:none;background:linear-gradient(160deg,#1b2556,#0f1638);border:2px solid #26336e;color:#e8ecff;font:12px/1.3 "Segoe UI",Tahoma,sans-serif;box-shadow:0 8px 28px #0009;transition:border-color .4s,box-shadow .4s;animation:fin .4s ease both}
.mini.show{display:grid}
.mini b{font-size:24px;display:block}
.mini.u{border-color:#3ddbb0;box-shadow:0 0 22px #3ddbb055}
.mini.d{border-color:#ff6b7a;box-shadow:0 0 22px #ff6b7a55}
.mini .ad{position:absolute;top:6px;right:6px;width:9px;height:9px;border-radius:50%;background:#3ddbb0;display:none}
.mini.auto .ad{display:block;animation:pl 1.2s infinite}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;
const NAME = 'wsnf smart bot';
const letters = s => [...s].map((ch, i) => ch === ' ' ? '<span class="sp"></span>' : `<span class="ch" style="--i:${i}">${ch}</span>`).join('');
const HTML = `
<div class="splash" id="splash">
  <div class="sp-ring"></div><div class="sp-ring r2"></div>
  <div class="sp-logo">${letters(NAME)}</div>
  <div class="sp-sub">تحليل • تعلّم • محاكاة</div>
  <div class="sp-bar"><i></i></div>
</div>
<div class="full" id="full">
<header>
  <div class="brand">${letters(NAME)}<i class="dot"></i><small>v2.8 · تنفيذ حقيقي بحدود</small></div>
  <nav class="nav" id="nav">
    <button data-p="home" class="on">الرئيسية</button>
    <button data-p="chart">الشارت</button>
    <button data-p="strat">الاستراتيجيات</button>
    <button data-p="lab">المختبر</button>
    <button data-p="log">السجل</button>
    <button data-p="mem">الذاكرة</button>
    <button data-p="err">الأخطاء</button>
  </nav>
  <div class="chips" id="chips"></div>
  <button id="min">تصغير ▾</button>
</header>
<section class="page p-home on" data-page="home">
  <div style="display:grid;gap:14px;align-content:start">
    <div class="card hero shine" id="hero">
      <h3><span id="assetT">—</span></h3>
      <div class="gw">
        <svg viewBox="0 0 120 120"><circle class="gbg" cx="60" cy="60" r="52"/><circle class="gfg" id="arc" cx="60" cy="60" r="52"/></svg>
        <div class="gm"><div class="arrow" id="arrow">—</div><b id="conf">0%</b></div>
      </div>
      <div class="dirT" id="dirT">أحلّل السوق...</div>
      <div class="chip" id="badge">—</div>
      <div class="notes" id="notes"></div>
      <div class="cdb"><i id="cdb"></i></div>
      <div class="note" id="cdt"></div>
    </div>
    <div class="card" id="exCard">
      <h3>تنفيذ التوصية على المنصة (يدوي بتأكيد أو آلي)</h3>
      <div class="exbtns">
        <button class="ex call" id="bCall" disabled>▲ شراء CALL</button>
        <button class="ex put" id="bPut" disabled>▼ بيع PUT</button>
      </div>
      <div class="row"><button class="tgl" id="exAuto" style="width:100%">التنفيذ التلقائي الحقيقي: متوقف</button></div>
      <div class="row"><button class="btn-danger" id="exStop" style="width:100%;font-weight:800">⛔ إيقاف التنفيذ فورًا</button></div>
      <div class="exsum" id="exSum"></div>
      <div class="note" id="exNote"></div>
    </div>
    <div class="card" id="limCard">
      <h3>حدود التنفيذ والمخاطر <span class="note" id="limSt"></span></h3>
      <div class="stats" id="limIn">
        <div class="st"><span>أقصى مبلغ للصفقة</span><input data-lim="maxAmount" type="number" min="0.01" step="any"></div>
        <div class="st"><span>أقصى إجمالي يومي</span><input data-lim="maxDayStake" type="number" min="0.01" step="any"></div>
        <div class="st"><span>أقصى خسارة يومية</span><input data-lim="maxDayLoss" type="number" min="0.01" step="any"></div>
        <div class="st"><span>صفقات/ساعة</span><input data-lim="maxPerHour" type="number" min="1" step="1"></div>
        <div class="st"><span>صفقات/يوم</span><input data-lim="maxPerDay" type="number" min="1" step="1"></div>
        <div class="st"><span>خسائر متتالية</span><input data-lim="maxLossRow" type="number" min="1" step="1"></div>
      </div>
      <div id="resBox"></div>
      <div class="note">حدود الخسارة تُحسب من النتائج التي تسجّلها أنت فقط (لا يقرأ البوت رصيد المنصة). غير المسجّلة لا تُحتسب.</div>
    </div>
    <div class="card">
      <h3>التحكم</h3>
      <div class="row">
        <button class="tgl" id="auto">الدخول الآلي (حقيقي على المنصة): متوقف</button>
        <button class="tgl" id="gate">بوابة الإثبات: تعمل</button>
      </div>
      <div class="row"><button class="btn-danger" id="kill">⛔ إيقاف طارئ</button></div>
      <div class="row"><span>أقل ثقة <b id="cv">65</b>%</span><input id="cs" type="range" min="50" max="90" value="65" style="flex:1"></div>
      <div class="row"><span>مدة الشمعة</span>
        <select id="tf"><option value="15">15 ثانية</option><option value="30">30 ثانية</option><option value="60" selected>دقيقة</option></select>
        <button id="lock">قفل الأصل</button>
      </div>
      <div class="row"><span>العائد %</span><input id="po" type="number" min="60" max="98" value="92" style="width:80px"></div>
      <div class="note" id="ctlnote"></div>
    </div>
  </div>
  <div style="display:grid;gap:14px;align-content:start">
    <div class="card shine">
      <h3>عدّاد الصفقات <span id="sessNote" class="note"></span></h3>
      <div class="score">
        <div><b class="w" id="sw">0</b><span>ربح</span></div>
        <div class="vs">:</div>
        <div><b class="l" id="sl">0</b><span>خسارة</span></div>
      </div>
      <div class="wr"><i id="wr"></i></div>
      <div class="wrt"><span id="wrL">نسبة الربح: —</span><span id="lifeL">الإجمالي: —</span></div>
    </div>
    <div class="card">
      <h3>فحص الإشارة قبل الدخول</h3>
      <ul class="checks" id="checks"></ul>
      <div class="note" id="decNote"></div>
    </div>
    <div class="card">
      <h3>الإحصاءات</h3>
      <div class="stats" id="stats"></div>
    </div>
  </div>
</section>
<section class="page p-chart" data-page="chart">
  <div class="card">
    <h3><span>الشارت (آخر 90 شمعة من أصل 5000)</span></h3>
    <div class="tick" id="tick" style="margin-bottom:10px"></div>
    <canvas id="cv2"></canvas>
  </div>
</section>
<section class="page p-strat" data-page="strat">
  <div class="card">
    <h3>الاستراتيجيات الـ17 (تتعلم ذاتيًا)</h3>
    <div class="scroll">
      <table><thead><tr><th>الاسم</th><th>النوع</th><th>عينة</th><th>دقة</th><th>حد أدنى</th><th>وزن</th><th>الحالة</th></tr></thead><tbody id="strat"></tbody></table>
    </div>
  </div>
  <div class="card">
    <h3>دقة الإشارات حسب الثقة (حي فقط)</h3>
    <table><thead><tr><th>الفئة</th><th>عينة</th><th>دقة</th><th>الدخول الآلي</th></tr></thead><tbody id="bks"></tbody></table>
  </div>
</section>
<section class="page p-lab" data-page="lab" style="grid-template-columns:1fr">
  <div class="card">
    <h3>جودة البيانات والتدقيق</h3>
    <div class="stats" id="labQ"></div>
    <div class="note">تُقاس الفجوات الزمنية والشموع المسطحة والقفزات الشاذة وتأخر التيك. تحت حد الجودة لا تصدر توصية. التدقيق يتأكد أن كل تحليل بُني على شمعة مغلقة وأن قراءات الشمعة السابقة لا تتغير بعد إغلاقها. أثناء إعادة تشغيل التاريخ لا يُستخدم إلا ما تعلّمه البوت حتى تلك اللحظة.</div>
  </div>
  <div class="card">
    <h3>مقارنة مدد الانتهاء (على إشارات الأساس)</h3>
    <div class="scroll"><table><thead><tr><th>المدة</th><th>حي: عينة</th><th>دقة</th><th>حد أدنى</th><th>تاريخ: عينة</th><th>دقة</th><th></th></tr></thead><tbody id="labH"></tbody></table></div>
    <div class="note" id="labHn"></div>
    <div class="scroll"><table id="labRM"></table></div>
    <div class="note">المدد مضاعفات الشمعة. الدقة في المصفوفة تجمع الحي والتاريخ لكل حالة سوق (تظهر بعد 20 حالة).</div>
  </div>
  <div class="card">
    <h3>فلتر الإشارات الكاذبة: أداء الإشارات المحجوبة</h3>
    <div class="scroll"><table><thead><tr><th>الفحص</th><th>عدد المحجوبة</th><th>دقتها لو دخلنا</th><th>الحكم</th></tr></thead><tbody id="labV"></tbody></table></div>
    <div class="note">الفحص مفيد إذا كانت الإشارات التي يحجبها أقل دقة من نقطة التعادل. إن حجب إشارات رابحة فهو مرشح للإلغاء.</div>
  </div>
  <div class="card">
    <h3>أداء كل حالة سوق (لو دخلنا بلا فلتر الحالة)</h3>
    <div class="scroll"><table><thead><tr><th>الحالة</th><th>عدد الإشارات</th><th>الدقة</th><th>الحكم</th></tr></thead><tbody id="labCX"></tbody></table></div>
    <div class="note">قبل كل توصية يحدد البوت حالة السوق (اتجاه، نطاق، اختراق صالح/وهمي، انعكاس، انضغاط، فوضى). «انضغاط/فوضوي/غير واضح» ممنوع فيها الدخول، وبقية الحالات يُسمح فيها باتجاه واحد فقط. هذا الجدول يقيس هل الحالة المسموحة رابحة فعلًا.</div>
  </div>
  <div class="card">
    <h3>مقارنة الاستراتيجيات: الأصل × حالة السوق × مدة الصفقة</h3>
    <div class="scroll"><table id="labSC"></table></div>
    <div class="note" id="labSCn"></div>
    <div class="note">كل خلية دقة إشارة الاستراتيجية بعد N شمعات على هذا الأصل وفي حالة السوق الحالية. الاستراتيجية «المختارة» هي التي يتجاوز حدها الأدنى (Wilson) نقطة التعادل، وتُوزن في القرار حسب أدائها في هذه الحالة. «أنسب مدة» تظهر في شرائح التحليل للإشارة الحالية؛ مدة الصفقة الفعلية تبقى ما تضبطه أنت في المنصة.</div>
  </div>
  <div class="card">
    <h3>اختبار الاستراتيجيات المعدّلة قبل اعتمادها (✦)</h3>
    <div class="scroll"><table><thead><tr><th>الاستراتيجية</th><th>القديمة</th><th>المعدّلة</th><th>العينة</th><th>المستخدمة الآن</th><th>الحكم</th></tr></thead><tbody id="labVT"></tbody></table></div>
    <div class="note" id="labVL"></div>
    <div class="note">النسختان تعملان على نفس الشموع. لا تُعتمد المعدّلة إلا بعد ≥100 إشارة لكل منهما وتفوق ≥1% بدلالة z ≥ 1 ودون فقدان أكثر من ثلاثة أرباع التغطية، وتُسحب تلقائيًا إن ثبت أنها أسوأ. النتائج الحية تُفضَّل على التاريخية.</div>
  </div>
  <div class="card">
    <h3>عزل المؤشرات المتشابهة</h3>
    <div class="scroll"><table><thead><tr><th>العنقود (يُعدّ دليلًا مستقلًا واحدًا)</th><th>الحالة</th></tr></thead><tbody id="labCR"></tbody></table></div>
    <div class="note" id="labCRn"></div>
    <div class="note">داخل كل عنقود يُخفَّض وزن كل مؤشر حسب الارتباط المقاس بين إشاراتها (مؤشران متطابقان = دليل واحد). إن ثبت تطابق مجموعتين مختلفتين (متوسط ρ ≥ 0.6 عبر ≥3 أزواج، كل زوج ≥100 حالة) دُمجتا، فلا تُحسبان اتفاقًا مستقلًا.</div>
  </div>
  <div class="card">
    <h3>الامتناع عند غياب فرصة واضحة</h3>
    <div class="stats" id="labAb"></div>
    <div class="note">الامتناع مفيد إذا كانت دقة الحالات التي امتنع عنها أقل من دقة المُصدرة.</div>
  </div>
  <div class="card">
    <h3>مختبر التجارب (صفقات ظلّية لا تؤثر على القرار)</h3>
    <div class="scroll"><table><thead><tr><th>التجربة</th><th>حي: عينة</th><th>دقة</th><th>حد ويلسون</th><th>تاريخ: عينة</th><th>دقة</th><th>الحالة</th><th></th></tr></thead><tbody id="labX"></tbody></table></div>
    <div class="note">لا تُعتمد تجربة إلا بعد عينة حية كافية وحد أدنى فوق التعادل وتفوّق على الأساس بـ 2% على الأقل.</div>
    <div class="row"><button id="labReset">إرجاع القواعد للإعدادات الافتراضية</button></div>
  </div>
  <div class="card">
    <h3>الدفتر والنسخة الاحتياطية</h3>
    <div class="stats" id="labJ"></div>
    <div class="note">كل إشارة مرشحة ونتائجها بمدد مختلفة تُحفظ في المتصفح ونسخة ثانية في IndexedDB. إن مُسح التخزين المحلي تُستعاد الذاكرة تلقائيًا.</div>
  </div>
</section>
<section class="page p-log" data-page="log">
  <div class="card">
    <h3>سجل الإشارات (محفوظ)</h3>
    <div class="scroll">
      <table><thead><tr><th>الوقت</th><th>الاتجاه</th><th>الثقة</th><th>النوع</th><th>النتيجة</th></tr></thead><tbody id="log"></tbody></table>
    </div>
  </div>
</section>
<section class="page p-mem" data-page="mem" style="grid-template-columns:1fr">
  <div class="card">
    <h3>ذاكرة البوت</h3>
    <div class="mem">
      <div class="st"><span>آخر حفظ</span><b id="memAt" style="font-size:14px">—</b></div>
      <div class="st"><span>أفضل فئة ثقة تعلّمها</span><b id="memBest" style="font-size:14px">—</b></div>
      <div class="st"><span>الصفقات المحفوظة في السجل</span><b id="memLog">0</b></div>
      <div class="row">
        <button id="exp">تصدير نسخة احتياطية</button>
        <button id="imp">استيراد نسخة</button>
        <input type="file" id="impFile" accept="application/json" style="display:none">
      </div>
      <div class="row"><button class="btn-danger" id="reset">مسح كل التعلّم</button></div>
      <div class="note">الذاكرة وإعدادات الحماية والإحصاءات تُحفظ تلقائيًا داخل المتصفح. إن مسحت بيانات الموقع ستضيع، لذلك صدّر نسخة احتياطية من وقت لآخر.</div>
    </div>
  </div>
</section>
<section class="page p-err" data-page="err" style="grid-template-columns:1fr">
  <div class="card">
    <h3>سجل الأخطاء والأحداث</h3>
    <div class="row"><button id="expDiag">تصدير التشخيص</button><button id="clrErr">مسح السجل</button></div>
    <div class="scroll"><table><thead><tr><th>الوقت</th><th>الرمز</th><th>الوصف</th></tr></thead><tbody id="errs"></tbody></table></div>
  </div>
  <div class="card">
    <h3>تتبع أحداث المحاكاة (آخر 40)</h3>
    <div class="scroll"><table><thead><tr><th>الوقت</th><th>النوع</th><th>الحدث</th></tr></thead><tbody id="trc"></tbody></table></div>
    <div class="note">أحداث الأوامر الافتراضية فقط. لا تُرسل أي أوامر إلى المنصة.</div>
  </div>
</section>
</div>
<div class="modal" id="modal"><div class="mbox">
  <h2 id="mdTitle">تأكيد تنفيذ الصفقة</h2>
  <div id="mdBody"></div>
  <div class="note" id="mdLeft"></div>
  <div class="row"><button id="mdNo">إلغاء</button><button class="mok" id="mdYes">تأكيد وإرسال</button></div>
  <div class="note">لن يُرسل شيء قبل نقرك على «تأكيد وإرسال». المبلغ والمدة يؤخذان من إعدادات المنصة.</div>
</div></div>
<div class="flash" id="flash"><div class="fbox" id="fbox"><b id="fA">—</b><span id="fS"></span></div></div>
<div class="mini" id="mini"><span class="ad"></span><div><b id="mA">—</b><span id="mT">انتظار</span></div></div>`;

function build() {
  if (window.__WSNF25_NOUI) return;
  if (document.getElementById('wsnf25-host')) return;
  const host = document.createElement('div');
  host.id = 'wsnf25-host';
  document.documentElement.appendChild(host);
  const sh = host.attachShadow({ mode: 'open' });
  sh.innerHTML = '<style>' + CSS + '</style>' + HTML;
  const $ = id => sh.getElementById(id);
  const ui = LSget(KEY_UI, { min: false, x: 12, y: 90 });
  const full = $('full'), mini = $('mini'), flash = $('flash'), fbox = $('fbox'), splash = $('splash');
  $('cs').value = CFG.minConf; $('po').value = Math.round(CFG.payout * 100); $('tf').value = String(CFG.tf);

  setTimeout(() => splash.classList.add('out'), 3000);
  setTimeout(() => { splash.style.display = 'none'; }, 3900);

  const setMin = m => {
    ui.min = m; LSset(KEY_UI, ui);
    full.classList.toggle('hide', m);
    mini.classList.toggle('show', m);
  };
  mini.style.left = ui.x + 'px';
  mini.style.top = ui.y + 'px';
  $('min').onclick = () => setMin(true);
  let drag = null;
  mini.onpointerdown = e => { drag = { sx: e.clientX, sy: e.clientY, x: mini.offsetLeft, y: mini.offsetTop, mv: false }; mini.setPointerCapture(e.pointerId); };
  mini.onpointermove = e => {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 5) drag.mv = true;
    if (drag.mv) { mini.style.left = Math.max(0, drag.x + dx) + 'px'; mini.style.top = Math.max(0, drag.y + dy) + 'px'; }
  };
  mini.onpointerup = () => {
    if (drag && !drag.mv) setMin(false);
    else if (drag) { ui.x = mini.offsetLeft; ui.y = mini.offsetTop; LSset(KEY_UI, ui); }
    drag = null;
  };

  const cv = $('cv2');
  $('nav').onclick = e => {
    const b = e.target.closest('button[data-p]');
    if (!b) return;
    sh.querySelectorAll('#nav button').forEach(x => x.classList.toggle('on', x === b));
    sh.querySelectorAll('.page').forEach(p => p.classList.toggle('on', p.dataset.page === b.dataset.p));
    if (b.dataset.p === 'chart') drawChart(cv);
  };

  $('auto').onclick = () => {
    if (CFG.auto || EX.auto) { CFG.auto = false; setAuto(false); saveCfg(); saveState(); paint(); return; }
    if (!confirm('تفعيل الدخول الآلي الحقيقي؟\nسينقر البوت زر CALL/PUT في المنصة بنفسه عند كل إشارة تجتاز الفحوص والحدود، وبأموال الحساب المفتوح حاليًا. يتوقف بزر «إيقاف». يستمر بعد إعادة تحميل الصفحة حتى تضغط إيقاف.')) return;
    CFG.auto = true; S.halted = false; S.haltWhy = ''; S.net = 0; S.unkRow = 0; S.failRow = 0;
    execResume(); setAuto(true);
    saveCfg(); saveState(); paint();
  };
  $('kill').onclick = () => { killSwitch('إيقاف طارئ'); execStop('إيقاف طارئ'); };
  $('clrErr').onclick = () => { S.errors = []; S.trace = []; LSset(KEY_ERR, []); };
  $('expDiag').onclick = () => download('wsnf-diag-' + Date.now() + '.json', diagnostics(), true);
  $('gate').onclick = () => { CFG.gate = !CFG.gate; saveCfg(); };
  $('labX').onclick = e => { const b = e.target.closest('button[data-adopt]'); if (b) adoptExp(b.dataset.adopt); };
  $('labReset').onclick = () => { resetCfg(); };
  $('cs').oninput = e => { CFG.minConf = +e.target.value; $('cv').textContent = CFG.minConf; saveCfg(); };
  $('po').onchange = e => { CFG.payout = clamp(+e.target.value, 60, 98) / 100; $('po').value = Math.round(CFG.payout * 100); saveCfg(); };
  $('tf').onchange = e => { if (!setTf(+e.target.value)) $('tf').value = String(CFG.tf); };
  $('lock').onclick = e => {
    const shown = readShownAsset(), hit = shown && Object.keys(S.candles).find(a => norm(a) === norm(shown));
    S.lock = S.lock ? null : (hit || S.cur);
    e.target.textContent = S.lock ? 'فك القفل' : 'قفل الأصل';
  };

  $('exp').onclick = () => exportData();
  $('imp').onclick = () => $('impFile').click();
  $('impFile').onchange = e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try { importData(String(rd.result)); alert('تم استيراد الذاكرة بنجاح'); }
      catch (err) { alert('فشل الاستيراد: ' + err.message); }
    };
    rd.readAsText(f);
    e.target.value = '';
  };
  $('reset').onclick = () => {
    if (!confirm('سيتم مسح كل ما تعلّمه البوت نهائيًا. متابعة؟')) return;
    resetLearning();
  };

  const showFlash = (cls, main, sub) => {
    flash.className = 'flash show ' + cls;
    fbox.style.animation = 'none'; void fbox.offsetWidth; fbox.style.animation = '';
    $('fA').textContent = main; $('fS').textContent = sub;
    clearTimeout(showFlash.t);
    showFlash.t = setTimeout(() => { flash.className = 'flash'; }, 2300);
  };
  S.onFlash = e => {
    const buy = e.dir === 'call';
    showFlash(buy ? 'call' : 'put', buy ? '▲ دخول شراء' : '▼ دخول بيع', (e.try ? 'تنفيذ محاكاة' : 'إشارة') + ' · ثقة ' + e.conf + '%');
    const tk = $('tick');
    tk.insertAdjacentHTML('afterbegin', `<span style="color:${buy ? '#3ddbb0' : '#ff6b7a'}">${buy ? '▲' : '▼'} ${e.conf}%</span>`);
    while (tk.children.length > 10) tk.lastElementChild.remove();
  };
  S.onResult = win => showFlash(win ? 'win' : 'loss', win ? '✔ ربح' : '✖ خسارة', 'نتيجة الصفقة الأخيرة');

  const openExec = dir => { let q; try { q = requestExec(dir); } catch (e) { logErr('EXEC_ERR', String(e && e.message || e)); q = { ok: false, why: 'خطأ غير متوقع' }; } EX.note = q.ok ? '' : q.why; paint(); if (q.ok) $('mdNo').focus(); };
  sh.querySelectorAll('#limIn input').forEach(i => {
    i.onchange = () => { if (!setLim(i.dataset.lim, i.value)) EX.note = 'قيمة حد غير صالحة'; i.value = LIM[i.dataset.lim]; paint(); };
  });
  $('resBox').onclick = e => {
    const b = e.target.closest('button[data-res]');
    if (b) { recordResult(+b.dataset.t, b.dataset.res === 'w'); paint(); }
  };
  $('exAuto').onclick = () => {
    if (EX.auto) setAuto(false);
    else if (confirm('تفعيل التنفيذ التلقائي الحقيقي؟\nسينقر البوت زر CALL/PUT في المنصة بنفسه عند كل إشارة تجتاز الفحوص والحدود، وبأموال الحساب المفتوح. يتوقف بزر «إيقاف التنفيذ» ويستمر بعد إعادة تحميل الصفحة حتى تضغط إيقاف. يُنصح بحساب Demo أولًا.')) setAuto(true);
    paint();
  };
  $('exStop').onclick = () => {
    if (EX.halted) { if (confirm('استئناف التنفيذ اليدوي؟')) execResume(); }
    else execStop('إيقاف يدوي');
    paint();
  };
  $('mdNo').onclick = () => { cancelExec('أُلغي التنفيذ'); paint(); };
  $('mdYes').onclick = () => { $('mdYes').disabled = true; confirmExec(); paint(); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && EX.modal) { cancelExec('أُلغي التنفيذ'); paint(); } });
  $('bCall').onclick = () => openExec('call');
  $('bPut').onclick = () => openExec('put');
  let lastLab = '';
  function paintExec() {
    const sg = currentSignal(S.cur);
    $('bCall').disabled = !(sg.ok && sg.dir === 'call');
    $('bPut').disabled = !(sg.ok && sg.dir === 'put');
    $('exNote').innerHTML = !sg.dir ? 'لا توجد توصية حالية'
      : sg.ok ? '<span class="w">التوصية ' + (sg.dir === 'call' ? 'CALL' : 'PUT') + ' صالحة للتنفيذ ' + Math.max(0, Math.ceil(sg.left)) + ' ث أخرى</span>'
        : '<span class="warn">غير متاح: ' + ESC(sg.why.join(' | ')) + '</span>';
    if (EX.note) $('exNote').innerHTML += '<br><span class="warn">' + ESC(EX.note) + '</span>';
    if (EX.auto && EX.autoWhy) $('exNote').innerHTML += '<br><span class="note">آلي: ' + ESC(EX.autoWhy) + '</span>';
    $('exSum').innerHTML = sg.dir ? sumHtml(execSummary(sg)) : '';
  }
  function paintModal() {
    const md = $('modal'), m = EX.modal;
    if (!m) { md.classList.remove('show'); return; }
    const s = currentSignal(m.asset);
    if (!s.ok || s.key !== m.key) { cancelExec('أُغلقت نافذة التأكيد: ' + (s.why || ['تغيّرت الإشارة']).join(' | ')); md.classList.remove('show'); return; }
    const sm = execSummary(s);
    $('mdBody').innerHTML = sumHtml(sm);
    $('mdLeft').innerHTML = 'تنتهي صلاحية الإشارة بعد <b>' + Math.max(0, Math.ceil(s.left)) + '</b> ث';
    $('mdYes').disabled = sm.blockers.length > 0;
    $('mdYes').textContent = 'تأكيد وإرسال ' + (s.dir === 'call' ? '▲ CALL' : '▼ PUT');
    md.classList.add('show');
  }
  const sumHtml = m =>
    '<div class="stats">' +
    `<div class="st"><span>الأصل</span><b>${ESC(m.asset)}</b></div>` +
    `<div class="st"><span>الاتجاه</span><b class="${m.dir === 'call' ? 'w' : 'l'}">${m.dirLabel}</b></div>` +
    `<div class="st"><span>مدة الصفقة</span><b>${ESC(m.durLabel)}</b></div>` +
    `<div class="st"><span>سعر الدخول</span><b>${m.price === null ? '-' : m.price}</b></div>` +
    `<div class="st"><span>مبلغ الصفقة (المنصة)</span><b>${m.amount === null ? '؟' : ESC(m.amount)}</b></div>` +
    `<div class="st"><span>الثقة</span><b>${m.conf}%</b></div></div>` +
    m.blockers.map(x => '<div class="note l">✖ ' + ESC(x) + '</div>').join('') +
    m.warns.map(x => '<div class="note warn">⚠ ' + ESC(x) + '</div>').join('');
  function paint() {
    paintExec(); paintModal();
    sh.querySelectorAll('#limIn input').forEach(i => { if (sh.activeElement !== i) i.value = LIM[i.dataset.lim]; });
    const LS = limitStats();
    $('limSt').textContent = 'اليوم: ' + LS.day + ' صفقة · مبالغ ' + LS.stake + ' · صافي مسجّل ' + LS.net.toFixed(2);
    $('resBox').innerHTML = LS.unrecorded.slice(-5).map(h => `<div class="row"><span class="note">صفقة ${new Date(h.t).toTimeString().slice(0, 8)} · مبلغ ${h.amt === null ? '؟' : h.amt}</span><span><button data-res="w" data-t="${h.t}">ربح</button> <button data-res="l" data-t="${h.t}">خسارة</button></span></div>`).join('');
    $('exAuto').textContent = 'التنفيذ التلقائي الحقيقي: ' + (EX.auto ? 'يعمل' : 'متوقف');
    $('exAuto').classList.toggle('on', EX.auto);
    $('exStop').textContent = EX.halted ? '▶ استئناف التنفيذ (موقوف)' : '⛔ إيقاف التنفيذ فورًا';
    const V = view(), r = V.r, d = r ? r.d : 'none';
    const col = d === 'call' ? '#3ddbb0' : d === 'put' ? '#ff6b7a' : '#f5c45e';
    S.exp = readExpiry();
    $('assetT').textContent = V.asset
      ? V.asset + ' | ' + V.n + ' شمعة' + (V.price ? ' | ' + V.price : '')
      : 'لا بيانات بعد: حدّث الصفحة (F5) وانتظر';
    $('hero').className = 'card hero shine ' + (d === 'call' ? 'u' : d === 'put' ? 'd' : '');
    $('arc').style.strokeDashoffset = 326.7 * (1 - (r && d !== 'none' ? r.conf / 100 : .12));
    $('arc').style.stroke = col;
    $('arrow').textContent = d === 'call' ? '▲' : d === 'put' ? '▼' : '—';
    $('arrow').style.color = col;
    $('conf').textContent = (r && d !== 'none' ? r.conf : 0) + '%';
    $('dirT').textContent = !r ? 'أحلّل السوق...' : d === 'call' ? 'إشارة شراء' : d === 'put' ? 'إشارة بيع' : 'لا توجد فرصة واضحة الآن' + (r.abst && r.abst.length ? ' — ' + r.abst[0] : '');
    $('dirT').style.color = col;
    $('badge').textContent = V.g.ok ? '✔ ' + V.g.why : d === 'none' ? (r ? r.regime + ' | امتناع' : '—') : '⏳ ' + V.g.why;
    $('badge').className = 'chip ' + (V.g.ok ? 'c-u' : 'c-g');
    $('notes').innerHTML = r && r.notes ? r.notes.slice(0, 8).map(n => '<span class="chip">' + ESC(n) + '</span>').join('') : '';
    $('cdb').style.width = V.cd === null ? '0' : (100 - V.cd / CFG.tf * 100) + '%';
    $('cdt').textContent = V.cd === null ? '' : 'تُغلق الشمعة بعد ' + Math.ceil(V.cd) + ' ث';
    $('chips').innerHTML =
      (EX.auto ? '<span class="chip c-d">⚠ تنفيذ تلقائي حقيقي يعمل</span>' : '<span class="chip c-u">الدخول الآلي متوقف</span>') +
      `<span class="chip ${V.asset ? 'c-u' : 'c-d'}">${V.asset ? '✓ بيانات حية' : 'لا بيانات'}</span>` +
      (V.loaded ? `<span class="chip c-m">تاريخ: ${V.loaded}</span>` : '') +
      (V.asset && S.dq[V.asset] ? `<span class="chip ${S.dq[V.asset].q >= CFG.minQ ? 'c-m' : 'c-d'}">جودة البيانات ${S.dq[V.asset].q}%</span>` : '') +
      (S.exp !== null ? `<span class="chip c-m">مدة المنصة ${S.exp}ث</span>` : '') +
      (S.halted ? '<span class="chip c-d">توقف: ' + ESC(S.haltWhy || 'حد الخسارة') + '</span>' : '') +
      (S.unkRow ? '<span class="chip c-g">صفقة بلا نتيجة ×' + S.unkRow + '</span>' : '') +
      (V.paused ? '<span class="chip c-g">استراحة بعد خسائر</span>' : '') +
      (V.cooling && !V.paused ? '<span class="chip c-g">تهدئة</span>' : '') +
      (S.wsUp === false ? '<span class="chip c-d">انقطاع الاتصال</span>' : '') +
      (S.pending ? '<span class="chip c-g">بانتظار تأكيد المحاكاة</span>' : '') +
      (S.open ? '<span class="chip c-m">صفقة مفتوحة (محاكاة)</span>' : '') +
      (S.storeErr ? '<span class="chip c-d">تعذّر الحفظ في المتصفح</span>' : '');
    $('auto').textContent = (CFG.auto && EX.auto) ? 'الدخول الآلي (حقيقي على المنصة): يعمل' : 'الدخول الآلي (حقيقي على المنصة): متوقف';
    $('auto').classList.toggle('on', CFG.auto && EX.auto);
    $('gate').textContent = CFG.gate ? 'بوابة الإثبات: تعمل' : 'بوابة الإثبات: متجاوَزة';
    $('gate').classList.toggle('on', CFG.gate);
    $('cv').textContent = CFG.minConf;
    $('ctlnote').innerHTML =
      '<span class="warn">«الدخول الآلي» ينقر زر CALL/PUT في المنصة فعليًا (يتوقف افتراضيًا بعد كل إعادة تحميل). النتائج لا تضمن أرباحًا؛ الحدود في بطاقة «حدود التنفيذ» تعمل دائمًا.</span><br>' +
      (CFG.gate
        ? 'لا يدخل إلا إذا أثبتت فئة الثقة دقتها فوق التعادل على ' + CFG.minLive + ' إشارة حية (z=' + CFG.gateZ + ') ونجحت أيضًا في آخر ' + CFG.recentN + ' إشارة.'
        : '<span class="warn">البوابة متجاوَزة: يدخل أي إشارة فوق حد الثقة.</span>');
    $('decNote').innerHTML = S.decision
      ? 'قرار آخر (' + new Date(S.decision.t).toTimeString().slice(0, 8) + '): ' + (S.decision.entered ? 'تم الدخول' : 'لم يدخل: ' + ESC(S.decision.why.join(' | ')))
      : 'لا قرارات بعد';
    $('errs').innerHTML = S.errors.slice(0, 60).map(e => `<tr><td>${new Date(e.t).toTimeString().slice(0, 8)}</td><td>${ESC(e.code)}</td><td>${ESC(e.msg)}</td></tr>`).join('') || '<tr><td colspan="3" class="note">لا أخطاء</td></tr>';
    $('trc').innerHTML = S.trace.map(x => `<tr><td>${new Date(x.t).toTimeString().slice(0, 8)}</td><td>${ESC(x.dir)}</td><td style="direction:ltr;text-align:left">${ESC(x.raw)}</td></tr>`).join('') || '<tr><td colspan="3" class="note">لا أحداث بعد</td></tr>';
    $('checks').innerHTML = V.checks.map(c => `<li class="${c.ok ? 'ok' : 'no'}"><b>${c.ok ? '✔' : '✖'}</b><span>${ESC(c.t)}</span></li>`).join('');
    const tot = V.sessW + V.sessL;
    $('sw').textContent = V.sessW;
    $('sl').textContent = V.sessL;
    $('sessNote').textContent = tot ? '(المسجّل: ' + tot + ')' : '';
    $('wr').style.width = (tot ? V.sessW / tot * 100 : 0) + '%';
    $('wrL').textContent = 'نسبة الربح: ' + (tot ? pc(V.sessW / tot, 1) : '—');
    const lt = V.lifeW + V.lifeL;
    $('lifeL').textContent = 'الإجمالي: ' + V.lifeW + ' ربح / ' + V.lifeL + ' خسارة' + (lt ? ' (' + pc(V.lifeW / lt, 1) + ')' : '');
    const livep = V.liveN ? pc(V.liveW / V.liveN, 1) : '-';
    $('stats').innerHTML =
      `<div class="st"><span>دقة كلية</span><b>${V.en ? pc(V.acc, 1) : '-'}</b></div>` +
      `<div class="st"><span>نقطة التعادل</span><b>${pc(V.be, 1)}</b></div>` +
      `<div class="st"><span>عينة كلية</span><b>${V.en}</b></div>` +
      `<div class="st"><span>دقة حية</span><b>${livep}</b><small>${V.liveN} إشارة</small></div>` +
      `<div class="st"><span>حد ويلسون الأدنى (حي)</span><b>${V.liveN ? pc(V.liveLb, 1) : '-'}</b></div>` +
      `<div class="st"><span>صافي المحاكاة</span><b class="${S.net >= 0 ? 'w' : 'l'}">${S.net >= 0 ? '+' : ''}${S.net.toFixed(2)}</b><small>وحدة</small></div>` +
      `<div class="st"><span>محاكاة هذه الساعة</span><b>${S.hourly.filter(t => Date.now() - t < 36e5).length}/${CFG.maxPerHour}</b></div>` +
      `<div class="st"><span>نسبة الأخطاء</span><b>${V.sim.tried ? pc(V.errRate, 0) : '-'}</b><small>${V.sim.bad}/${V.sim.tried} محاولة</small></div>` +
      `<div class="st"><span>صفقات المحاكاة</span><b>${V.sim.w}/${V.sim.l}</b><small>ربح/خسارة</small></div>`;
    $('strat').innerHTML = V.rows;
    $('bks').innerHTML = V.bks || '<tr><td colspan="4" class="note">لم تتجمع بيانات بعد</td></tr>';
    $('log').innerHTML = V.log || '<tr><td colspan="5" class="note">لا إشارات بعد</td></tr>';
    $('memAt').textContent = V.savedAt ? new Date(V.savedAt).toLocaleString('ar-SA') : 'لم يُحفظ بعد';
    $('memBest').textContent = V.best ? V.best.k + '%+ بدقة ' + pc(V.best.acc, 1) + ' من ' + V.best.n : 'تحتاج عينة أكبر';
    $('memLog').textContent = V.logCount;
    if (sh.querySelector('.p-lab.on')) {
      const L = labView(), key = L.q + L.h + L.hn + L.rm + L.v + L.cx + L.scT + L.vt + L.cr + L.ab + L.x + L.j;
      if (key !== lastLab) {
        lastLab = key;
        $('labQ').innerHTML = L.q; $('labH').innerHTML = L.h; $('labHn').textContent = L.hn; $('labRM').innerHTML = L.rm;
        $('labV').innerHTML = L.v; $('labCX').innerHTML = L.cx; $('labSC').innerHTML = L.scT; $('labSCn').textContent = L.scn; $('labVT').innerHTML = L.vt; $('labVL').textContent = L.vl ? 'آخر التبديلات: ' + L.vl : ''; $('labCR').innerHTML = L.cr; $('labCRn').textContent = L.crn ? 'أزواج شديدة التطابق: ' + L.crn : ''; $('labAb').innerHTML = L.ab; $('labX').innerHTML = L.x; $('labJ').innerHTML = L.j;
      }
    }
    mini.className = 'mini' + (ui.min ? ' show' : '') + (d === 'call' ? ' u' : d === 'put' ? ' d' : '') + (CFG.auto ? ' auto' : '');
    $('mA').textContent = d === 'call' ? '▲' : d === 'put' ? '▼' : '—';
    $('mA').style.color = col;
    $('mT').textContent = r && d !== 'none' ? r.conf + '%' : 'انتظار';
  }
  setInterval(() => { try { paint(); } catch (e) { console.warn('wsnf paint', e); } }, 1000);
  setInterval(() => {
    if (ui.min || !sh.querySelector('.p-chart.on')) return;
    try { drawChart(cv); } catch (e) {}
  }, 400);
  setMin(ui.min);
  paint();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
else build();
window.__WSNF25 = {
  SIM_ONLY, S, CFG, feedTick, onClose, analyze, handle, getA, AK, gate, wt, statOf, dampen, verifyCandles,
  maybeTrade, placeOrder, confirmOrder, watchdog, finishOpen, settle, voidTrade, failPending, onWsDown, killSwitch,
  setTf, resetLearning, saveAll, buildExport, exportData, importData, view, resLabel, simSummary,
  corrReport, diagnostics, restore, BE, wil, bestBucket, GRP,
  EX, setAuto, autoRun, LIM, LIM_DEF, setLim, loadLim, loadHist, parseAmt, limitStats, limitsCheck, recordResult, execStop, execResume, currentSignal, execSummary, confirmExec, loadSent, saveSent, findTradeButton, platformInfo, requestExec, cancelExec, sigKey,
  decide, EXPS, HZ, IMP, IMPK, vk, evalVariants, variantVerdict, poolS, cellOf, bestHz, stratMatrix, rebuildClusters, pairRho, clusterOf, dampen, loadSV, qk, marketContext, ctxPermit, breakoutScan, reversalScan, adxOf, swings, dataQuality, falseSignals, rawVotes, labView, adoptExp, resetCfg, zAgg, expReady, cleanJournal, idbRestore, mirror, IDB, wtR, snapshot, applySnapshot, applyCfg, cfgSnap
};
})();