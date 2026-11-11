'use strict';
// وظائف سليمة يجب أن تبقى كما هي: هذه الاختبارات يجب أن تنجح على الأصلية والمعدّلة معًا.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness');

const ASSET = 'EURUSD_otc';
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

test('R1 حد ويلسون الأدنى بقيم معروفة', () => {
  const { wil } = H.load().W;
  assert.ok(near(wil(100, 60, 1.96), 0.5020));
  assert.equal(wil(0, 0), 0);
  assert.ok(wil(1000, 500, 1.96) < .5);
});

test('R2 فحص الشموع يرفض المشوّهة والمكررة ويقبل السليمة', () => {
  const { verifyCandles } = H.load().W;
  const ok = [H.candle(0, 1, 1.1, .9, 1.05), H.candle(60, 1.05, 1.2, 1, 1.1)];
  assert.equal(verifyCandles(ok).ok, true);
  assert.equal(verifyCandles([H.candle(0, 1, .9, 1.1, 1)]).ok, false);
  assert.equal(verifyCandles([ok[0], { ...ok[1], t: 0 }]).ok, false);
  assert.equal(verifyCandles([H.candle(0, NaN, 1, 1, 1)]).ok, false);
});

test('R3 إعادة تشغيل التاريخ مرتين لا تضاعف إحصاء التدريب', () => {
  const B = H.load();
  const ticks = H.randomWalkTicks(21, 6 * 3600);
  B.W.handle('hist', { asset: ASSET, history: ticks });
  const A = B.W.getA(ASSET), snap = JSON.stringify(Object.fromEntries(Object.entries(A.s).map(([k, v]) => [k, [v.hn, v.hw]])));
  B.W.handle('hist', { asset: ASSET, history: ticks });
  const snap2 = JSON.stringify(Object.fromEntries(Object.entries(A.s).map(([k, v]) => [k, [v.hn, v.hw]])));
  assert.equal(snap2, snap);
  assert.ok(A.s.trend.hn > 100);
});

test('R4 لا تسرّب للمستقبل: تغيير البيانات بعد لحظة T لا يغيّر أي قرار قبلها', () => {
  const base = H.randomWalkTicks(31, 86400, { drift: 2e-6 });
  const T = base[60000][0];
  const alt = base.slice(0, 60000).concat(H.randomWalkTicks(99, 86400 - 60000, { t0: T + 1, p0: base[59999][1] * 1.01 }));
  const decisions = ticks => {
    const B = H.load(), out = [];
    // نسجّل كل قرار لحظة صدوره (السجل نفسه محدود بـ 200 إدخال)
    B.W.S.onFlash = e => { if (e.ct + 60 <= T) out.push([e.ct, e.dir, e.conf].join()); };
    H.runFeed(B, ASSET, ticks, 21600);
    return out;
  };
  const a = decisions(base), b = decisions(alt);
  assert.ok(a.length > 0);
  assert.deepEqual(b.slice(0, a.length), a);
});

test('R5 اختبار ثبات القراءات بعد إغلاق الشمعة: صفر اختلاف', () => {
  const B = H.load();
  H.runFeed(B, ASSET, H.randomWalkTicks(32, 86400), 21600);
  const au = B.W.S.audit;
  assert.ok(au.tests > 50);
  assert.equal(au.testBad, 0);
});

test('R6 الإحصاءات الحية تبقى بعد إعادة تحميل الصفحة', () => {
  const store = {};
  const B = H.load({ store });
  H.runFeed(B, ASSET, H.randomWalkTicks(33, 86400, { drift: 2e-6 }), 21600);
  B.W.saveAll();
  const A = B.W.getA(ASSET), n = A.e.ln, trend = A.s.trend.ln;
  assert.ok(trend > 0);
  const B2 = H.load({ store });
  const A2 = B2.W.getA(ASSET);
  assert.equal(A2.e.ln, n);
  assert.equal(A2.s.trend.ln, trend);
});

test('R7 تصدير ثم استيراد النسخة الاحتياطية يعيد نفس الذاكرة', () => {
  const B = H.load();
  H.runFeed(B, ASSET, H.randomWalkTicks(34, 43200), 21600);
  const ex = JSON.parse(JSON.stringify(B.W.buildExport()));
  const B2 = H.load();
  B2.W.importData(JSON.stringify(ex));
  assert.equal(JSON.stringify(B2.W.snapshot()), JSON.stringify(ex.live));
});

test('R8 تنظيف السجل المحفوظ يرفض القيم التالفة', () => {
  const B = H.load({ store: { wsnf25_log: '[{"t":"x"},{"t":5,"dir":"put","conf":500,"win":"yes"}]', wsnf33s_log: '[{"t":"x"},{"t":5,"dir":"put","conf":500,"win":"yes"}]' } });
  const L = B.W.S.log;
  assert.equal(L.length, 1);
  assert.equal(L[0].conf, 100);
  assert.equal(L[0].win, null);
});

test('R9 قرار الدخول يمتنع افتراضيًا عند ضعف الإشارة', () => {
  const { decide } = H.load().W;
  const r = { comp: true, sd: 1, sc: .05, agree: 1, agreeS: 1, opp: 0, htfOK: true, vetoes: [], regime: 'اتجاهي', ctx: null };
  const d = decide(r);
  assert.equal(d.ok, false);
  assert.ok(d.why.length >= 2);
});

test('R10 حدود المحاكاة: الخسائر المتتالية تفرض استراحة وحد الخسارة يوقف', () => {
  const B = H.load(), W = B.W;
  for (let i = 0; i < 3; i++) W.settle({ auto: true, asset: ASSET }, 1, false);
  assert.ok(W.S.pausedUntil > B.ctx.Date.now());
  for (let i = 0; i < 3; i++) W.settle({ auto: true, asset: ASSET }, 1, false);
  assert.equal(W.S.halted, true);
  assert.ok(near(W.S.net, -6, 1e-9));
});

test('R11 قراءة رسائل WebSocket (نصية وثنائية)', async () => {
  const B = H.load();
  const ws = new B.ctx.WebSocket('wss://x');
  ws.emit('open');
  ws.emit('message', { data: '42["updateStream",[["' + ASSET + '",1700000000.5,1.1]]]' });
  assert.equal(B.W.S.candles[ASSET].length, 1);
  ws.emit('message', { data: '451-["updateStream",{"_placeholder":true,"num":0}]' });
  ws.emit('message', { data: new TextEncoder().encode('[["' + ASSET + '",1700000061.5,1.2]]') });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(B.W.S.candles[ASSET].length, 2);
  assert.equal(B.W.S.candles[ASSET][1].c, 1.2);
});

test('R12 تغيير مدة الشمعة يفصل الإحصاءات بمفتاح منفصل', () => {
  const W = H.load().W;
  assert.equal(W.AK('X'), 'X');
  W.setTf(30);
  assert.equal(W.AK('X'), 'X@30');
});
