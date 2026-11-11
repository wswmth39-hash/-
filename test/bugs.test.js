'use strict';
// المرحلة B: كل اختبار هنا يثبت خطأً محددًا من التقرير (يفشل على الأصلية) ويثبت إصلاحه (ينجح على المعدّلة).
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const H = require('./harness');

const ASSET = 'EURUSD_otc';
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// يستخرج دالة سهمية من المستوى الأعلى من المصدر (للأصلية التي لا تكشف المؤشرات)
function pick(name, extra = {}) {
  const B = H.load();
  if (B.W.IND && B.W.IND[name]) return B.W.IND[name];
  const src = H.source();
  const m = new RegExp('(?:const|function) ' + name + '\\b[\\s\\S]*?\\n}\\;?').exec(src);
  if (!m) throw new Error('not found ' + name);
  const ctx = { Math, CFG: { tf: 60, htfK: 5 }, ...extra };
  vm.createContext(ctx);
  vm.runInContext(m[0].replace(/^const /, 'var ') + '\n;this.__f=' + name + ';', ctx);
  return ctx.__f;
}

// RSI مرجعي (Wilder) مكتوب هنا بشكل مستقل
function rsiWilder(c, n = 14) {
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  if (g === 0 && l === 0) return 50;
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

function rwCandles(seed, n, t0 = 0) {
  const r = H.rng(seed), out = [];
  let p = 1;
  for (let i = 0; i < n; i++) {
    const o = p, c = p * (1 + H.gauss(r) * 5e-4);
    out.push(H.candle(t0 + i * 60, o, Math.max(o, c) * (1 + r() * 2e-4), Math.min(o, c) * (1 - r() * 2e-4), c));
    p = c;
  }
  return out;
}

test('B17 RSI = 50 في السوق الساكن (كان 100 → إشارة بيع كاذبة)', () => {
  const rsi = pick('rsi');
  assert.equal(rsi(new Array(300).fill(1)), 50);
});

test('B17 RSI يطابق طريقة Wilder المرجعية', () => {
  const rsi = pick('rsi');
  const c = rwCandles(1, 300).map(x => x.c);
  assert.ok(near(rsi(c), rsiWilder(c), 1e-9), rsi(c) + ' vs ' + rsiWilder(c));
});

test('B16/B17 سوق ثابت: لا يصوّت أي مؤشر (كان trend=-1 rsi=-1 streak=+0.9)', () => {
  const B = H.load();
  const flat = []; for (let i = 0; i < 300; i++) flat.push(H.candle(i * 60, 1, 1, 1, 1));
  const v = B.W.rawVotes(flat);
  const nz = Object.entries(v).filter(([, x]) => x !== 0);
  assert.deepEqual(nz, []);
});

test('B16 شموع الدوجي لا تُحسب هابطة (تتابع الإنهاك)', () => {
  const B = H.load();
  const cs = rwCandles(2, 294);
  const p = cs[cs.length - 1].c;
  for (let i = 0; i < 6; i++) cs.push(H.candle(cs[cs.length - 1].t + 60, p, p * 1.0003, p * 0.9997, p));
  assert.equal(B.W.rawVotes(cs).streak, 0);
});

test('B18 الإطار الأعلى مبني على حدود الساعة ويستبعد الشمعة غير المكتملة', () => {
  const resample = pick('resample');
  const cs = rwCandles(3, 103, 60); // يبدأ عند 60 ث (ليس من مضاعفات 300)
  const h = resample(cs, 5);
  assert.ok(h.length > 0);
  assert.ok(h.every(x => x.t % 300 === 0), 'بدايات: ' + h.slice(0, 3).map(x => x.t));
  const lastEnd = cs[cs.length - 1].t + 60;
  assert.ok(h[h.length - 1].t + 300 <= lastEnd, 'آخر شمعة أعلى يجب أن تكون مكتملة');
});

test('B20 انفجار الانضغاط يعمل عند اختراق بعد انضغاط فعلي', () => {
  const B = H.load();
  const cs = [];
  let t = 0;
  for (let i = 0; i < 299; i++) {
    const amp = i < 150 ? 3e-3 : 3e-3 * (1 - (i - 150) / 160); // تذبذب واسع ثم انضغاط تدريجي
    const c = 1 + amp * Math.sin(i * 0.9);
    const o = i ? cs[i - 1].c : 1;
    cs.push(H.candle(t, o, Math.max(o, c) + amp * .1, Math.min(o, c) - amp * .1, c)); t += 60;
  }
  const o = cs[298].c;
  cs.push(H.candle(t, o, o + 2.2e-3, o - 1e-5, o + 2e-3)); // شمعة اختراق صاعدة
  assert.ok(B.W.rawVotes(cs).squeeze > 0, 'squeeze=' + B.W.rawVotes(cs).squeeze);
});

test('B11 الثقة لا تُقصّ صناعيًا عند 70% بسبب حجم العينة', () => {
  const B = H.load();
  const cs = []; let p = 1;
  for (let i = 0; i < 300; i++) { const o = p; p *= 1.0006; cs.push(H.candle(i * 60, o, p * 1.0001, o * .9999, p)); }
  const r = B.W.analyze(cs, B.W.getA('TREND'), null);
  assert.ok(r.conf0 > 70, 'conf0=' + r.conf0);
  assert.ok(r.conf0 <= 95);
});

test('B14 الأصوات الضعيفة (مثل MACD ±0.3) تُسجَّل في الإحصاء كما تُستخدم في القرار', () => {
  const B = H.load();
  const { S, getA } = B.W;
  const arr = [H.candle(0, 1, 1.001, .999, 1), H.candle(60, 1, 1.002, .999, 1.001)];
  arr[1].ft = 60.5; arr[1].lt = 119.5; arr[1].nt = 60;
  S.P[ASSET] = { entry: 1, ct: 0, raw: { macd: .3 }, dir: 'none', bk: null, log: null, ok: true, regime: '-', at: 1, atr: 1e-3 };
  B.W.onClose(ASSET, arr, 120, 120.2);
  const o = getA(ASSET).s.macd;
  assert.ok(o && o.ln === 1 && o.lw === 1, JSON.stringify(o));
});

test('B12/B13 عتبة «معطلة» لا تستبعد استراتيجية بسبب الضوضاء (n=113, 44%)', () => {
  const B = H.load();
  const A = B.W.getA('X');
  A.s.cci = { hn: 113, hw: 50, ln: 0, lw: 0, rc: [] };
  assert.notEqual(B.W.wt(A, 'cci').mode, 'معطلة');
  A.s.kelt = { hn: 4000, hw: 1880, ln: 0, lw: 0, rc: [] }; // 47% على 4000: أسوأ من العشوائي بثبات
  assert.equal(B.W.wt(A, 'kelt').mode, 'معطلة');
});

test('B13 تبديل النسخة «المعدّلة» يحتاج دلالة إحصائية حقيقية (z=1.27 لا يكفي)', () => {
  const B = H.load();
  const A = B.W.getA('X');
  A.s.boll = { hn: 0, hw: 0, ln: 500, lw: 250, rc: [] };
  A.s['boll+'] = { hn: 0, hw: 0, ln: 500, lw: 270, rc: [] };
  assert.equal(B.W.variantVerdict('boll').better, false);
});

test('B28 تيك متأخر داخل الشمعة نفسها لا يغيّر سعر الإغلاق', () => {
  const B = H.load();
  B.W.S.loading = true; // نتجنب الحفظ وغيره
  B.W.feedTick(ASSET, 1.7e9 + 0.5, 1);
  B.W.feedTick(ASSET, 1.7e9 + 10, 2);
  B.W.feedTick(ASSET, 1.7e9 + 5, 3);
  const c = B.W.S.candles[ASSET].slice(-1)[0];
  assert.equal(c.c, 2);
  assert.equal(c.h, 3);
});

test('B23 إعادة إرسال التاريخ نفسه لا تضاعف عدّاد الترابط', () => {
  const B = H.load();
  const ticks = H.randomWalkTicks(11, 6 * 3600);
  B.W.handle('hist', { asset: ASSET, history: ticks });
  const sum = () => Object.values(B.W.S.corr).reduce((a, o) => a + o[0], 0) + (B.W.corrHistTotal ? B.W.corrHistTotal() : 0);
  const once = sum();
  B.W.handle('hist', { asset: ASSET, history: ticks });
  assert.ok(once > 0);
  assert.equal(sum(), once);
});

test('B7 عائد لكل أصل ونقطة تعادل لكل أصل', () => {
  const B = H.load();
  assert.equal(typeof B.W.setPayout, 'function');
  B.W.setPayout('AUDCAD_otc', .8);
  assert.ok(near(B.W.BE('AUDCAD_otc'), 1 / 1.8));
  assert.ok(near(B.W.BE('OTHER'), 1 / (1 + B.W.CFG.payout)));
});

test('B25/A10 «الإجمالي» لا يضيف نتائج إعادة تشغيل التاريخ (داخل العينة)', () => {
  const B = H.load();
  const ticks = H.randomWalkTicks(12, 86400, { drift: 2e-6 });
  B.W.handle('hist', { asset: ASSET, history: ticks });
  const A = B.W.getA(ASSET);
  assert.ok(A.e.hn > 0, 'يجب أن تكون هناك نتائج تاريخية حتى يكون الاختبار ذا معنى');
  const V = B.W.view();
  assert.equal(V.lifeW + V.lifeL, 0);
});

test('B26 تدقيق المستقبل يكتشف تحليل شمعة قبل انتهاء وقتها', () => {
  const B = H.load();
  const S = B.W.S;
  const arr = [H.candle(0, 1, 1, 1, 1), H.candle(60, 1, 1, 1, 1)];
  arr[1].ft = 60.5; arr[1].lt = 100; arr[1].nt = 5;
  const before = S.audit.bad;
  B.W.onClose(ASSET, arr, 120, 110); // التيك الحالي عند 110 ث والشمعة تنتهي عند 120 ث
  assert.equal(S.audit.bad, before + 1);
});
