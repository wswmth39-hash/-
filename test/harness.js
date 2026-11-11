'use strict';
// يحمّل ملف الـ Userscript كما هو (دون تعديل) داخل Node مع بدائل بسيطة للمتصفح.
// يُستخدم لاختبار النسخة الأصلية والنسخة المعدّلة بنفس الاختبارات.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILES = {
  original: path.join(ROOT, 'original', 'wsnf_v3.3.user.js'),
  v35: path.join(ROOT, 'backup', 'wsnf_v3.5.user.js'),       // آخر نسخة قبل فصل المحرك (المرحلة C) — مرجع الاختبار الذهبي
  v36: path.join(ROOT, 'backup', 'wsnf_v3.6.user.js'),       // قبل ترقية الاتصال (v4)
  current: path.join(ROOT, 'dist', 'wsnf.user.js')            // الناتج المبني من src/ (node build.js)
};
const target = () => FILES[process.env.WSNF_TARGET || 'current'] || process.env.WSNF_TARGET;
const source = (file = target()) => fs.readFileSync(file, 'utf8');

// عنصر DOM وهمي يسجّل كل نقرة عليه
function fakeEl(props = {}) {
  const el = {
    clicks: 0, disabled: false, value: '', textContent: '', className: '', tagName: 'BUTTON', parentElement: null,
    classList: { contains: () => false }, getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 50, height: 20 }),
    click() { el.clicks++; },
    ...props
  };
  return el;
}

// fakePlatform: يحاكي صفحة المنصة بأزرار CALL/PUT وخانة مبلغ واسم الأصل. أي نقر يُسجَّل في clicks.
function load({ file = target(), store = {}, now = 1.7e12, platform = null, ui = false, recMem = null } = {}) {
  let clock = now;
  const sockets = [];
  const els = platform ? {
    call: fakeEl({ className: 'btn-call' }),
    put: fakeEl({ className: 'btn-put' }),
    amount: fakeEl({ tagName: 'INPUT', value: '1' }),
    symbol: fakeEl({ tagName: 'DIV', textContent: platform.asset })
  } : null;
  const sel = s => {
    if (!els) return null;
    if (/btn-call|action="call"/.test(s)) return els.call;
    if (/btn-put|action="put"/.test(s)) return els.put;
    if (/bet-amount|amount/.test(s)) return els.amount;
    if (/symbol|pair/.test(s)) return els.symbol;
    return null;
  };
  class FakeWS {
    constructor(url) { this.url = url; this.ls = {}; sockets.push(this); }
    addEventListener(t, f) { (this.ls[t] = this.ls[t] || []).push(f); }
    emit(t, ev = {}) { (this.ls[t] || []).forEach(f => f({ target: this, ...ev })); }
  }
  const DateC = class extends Date {
    constructor(...a) { a.length ? super(...a) : super(clock); }
    static now() { return clock; }
  };
  const ctx = {
    console: { warn() {}, log() {}, error() {} },
    localStorage: {
      getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }
    },
    document: {
      readyState: 'complete', visibilityState: 'visible', addEventListener() {},
      querySelector: sel, querySelectorAll: s => (s === 'input' && els ? [els.amount] : []),
      getElementById: () => null
    },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    setInterval: () => 0, setTimeout: () => 0, clearTimeout() {}, clearInterval() {},
    TextDecoder, URL, Promise, JSON, Math, Date: DateC, Number, String, Object, Array, Set, Map, Error, RegExp, isFinite, parseFloat, Symbol,
    Blob: class { constructor(p) { this.p = p; } text() { return Promise.resolve(this.p.join('')); } }
  };
  ctx.window = ctx;
  ctx.__WSNF25_NOUI = !ui;
  ctx.__WSNF_TEST = true; // النسخة المعدّلة لا تكشف واجهتها الداخلية إلا في وضع الاختبار
  if (recMem) ctx.__WSNF_REC_MEM = recMem; // مخزن مسجّل مشترك بين «إعادات التحميل» في الاختبار
  ctx.addEventListener = () => {};
  ctx.WebSocket = FakeWS;
  ctx.indexedDB = undefined;
  ctx.confirm = () => true; ctx.alert = () => {};
  vm.createContext(ctx);
  vm.runInContext(source(file), ctx, { filename: path.basename(file) });
  return {
    W: ctx.__WSNF25, ctx, store, els, sockets,
    setNow: t => { clock = t; },
    clicks: () => (els ? els.call.clicks + els.put.clicks : 0)
  };
}

// ---------- مولدات بيانات مصطنعة (قابلة للتكرار) ----------
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }
// تيك كل ثانية من حركة عشوائية (لا يمكن التنبؤ بها)
// jitter: تذبذب توقيت التيك داخل الثانية (0 = كل ثانية + 0.3 بالضبط)، أكثر واقعية ويكشف أخطاء دقة الوقت
function randomWalkTicks(seed, seconds, { t0 = 1.7e9, p0 = 1.1, vol = 4e-5, drift = 0, jitter = 0 } = {}) {
  const r = rng(seed), rj = rng(seed ^ 0x5bd1e995), out = [];
  let p = p0;
  for (let s = 0; s < seconds; s++) { p *= 1 + drift + gauss(r) * vol; out.push([+(t0 + s + 0.3 + (jitter ? (rj() - .5) * jitter : 0)).toFixed(3), +p.toFixed(5)]); }
  return out;
}
const candle = (t, o, h, l, c) => ({ t, o, h, l, c });

// تشغيل كامل: تاريخ ثم بث حي بنفس مسار الكود الحقيقي
function runFeed(B, asset, ticks, histN) {
  B.W.handle('hist', { asset, history: ticks.slice(0, histN) });
  B.W.S.wsUp = true;
  for (const [ts, px] of ticks.slice(histN)) { B.setNow(ts * 1000); B.W.feedTick(asset, ts, px); }
}

// الاشتراك في أحداث المحرك: v3.6 عبر ناقل الأحداث (on)، والنسخ الأقدم عبر S.onFlash/S.onResult
function subscribe(W, type, fn) {
  if (typeof W.on === 'function') return W.on(type, fn);
  W.S[type === 'signal' ? 'onFlash' : 'onResult'] = fn;
}

module.exports = { subscribe, load, FILES, target, source, rng, gauss, randomWalkTicks, candle, runFeed, fakeEl };
