'use strict';
// المرحلة A: السلامة — المحاكاة فقط، لا نقر على أزرار المنصة، لا عودة للتنفيذ بعد إعادة التحميل.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness');

const ASSET = 'EURUSD_otc';

test('A1 SIM_ONLY ثابت = true', () => {
  const B = H.load();
  assert.equal(B.W.SIM_ONLY, true);
});

test('A2 لا يوجد في الكود أي محدد لأزرار CALL/PUT ولا نقر عليها', () => {
  const src = H.source();
  assert.doesNotMatch(src, /btn-call|btn-put|BTN_SEL|findTradeButton/);
  // كل click() يجب أن يكون على عنصر يملكه البوت نفسه: رابط تنزيل ينشئه، أو حقل اختيار ملف مخفي داخل واجهته.
  const lines = src.split('\n').filter(l => /\.click\(\)/.test(l));
  const allowed = [/\b(document|doc)\.body\.appendChild\(a\); a\.click\(\); a\.remove\(\);/, /\$\('(impFile|recImpFile)'\)\.click\(\)/];
  for (const l of lines) assert.ok(allowed.some(re => re.test(l)), 'click() غير مسموح: ' + l.trim());
  if (process.env.WSNF_TARGET !== 'original') assert.ok(lines.length <= 3, 'عدد click(): ' + lines.length);
  assert.doesNotMatch(src, /btn\.click\(\)/);
});

test('A3 لا توجد دوال تنفيذ حقيقي مكشوفة', () => {
  const B = H.load();
  for (const f of ['confirmExec', 'autoRun', 'requestExec', 'findTradeButton', 'execSummary', 'platformInfo'])
    assert.equal(B.W[f], undefined, f + ' ما زالت موجودة');
});

test('A4 الواجهة الداخلية لا تُكشف للصفحة خارج وضع الاختبار', () => {
  const store = {};
  const B = H.load({ store });
  // نعيد التحميل بدون علم الاختبار
  const fs = require('fs'), vm = require('vm');
  const ctx = { console: { warn() {} }, localStorage: { getItem: () => null, setItem() {} }, document: { readyState: 'complete', addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] }, setInterval: () => 0, setTimeout: () => 0, clearTimeout() {}, TextDecoder, Promise, JSON, Math, Date, Number, String, Object, Array, Set, Map, Error, RegExp, isFinite, parseFloat, Symbol };
  ctx.window = ctx; ctx.__WSNF25_NOUI = true; ctx.addEventListener = () => {};
  vm.createContext(ctx); vm.runInContext(fs.readFileSync(H.target(), 'utf8'), ctx);
  assert.equal(ctx.__WSNF25, undefined);
  assert.ok(B.W, 'في وضع الاختبار تبقى متاحة للاختبارات');
});

test('A5 الدخول الآلي المحفوظ (من v3.3 أو الجديد) لا يعود بعد إعادة التحميل', () => {
  const store = {
    wsnf25_cfg: JSON.stringify({ auto: true, gate: false, tf: 60 }),
    wsnf25_exstop: JSON.stringify({ h: false }),
    wsnf33s_cfg: JSON.stringify({ auto: true, gate: false, tf: 60 })
  };
  const B = H.load({ store });
  assert.equal(B.W.CFG.auto, false, 'CFG.auto');
  if (B.W.EX) assert.equal(B.W.EX.auto, false, 'EX.auto');
});

test('A6 تشغيل كامل مع الدخول الآلي مفعّل وأزرار منصة وهمية: صفر نقرات', () => {
  const B = H.load({ platform: { asset: ASSET } });
  B.W.CFG.auto = true; B.W.CFG.gate = false;
  if (B.W.EX) { B.W.EX.auto = true; B.W.EX.halted = false; }
  if (B.W.LIM) Object.assign(B.W.LIM, { maxAmount: 1e9, maxDayStake: 1e9, maxDayLoss: 1e9, maxPerHour: 1e9, maxPerDay: 1e9, maxLossRow: 1e9 });
  const ticks = H.randomWalkTicks(3, 86400 * 2, { drift: 2e-6 });
  H.runFeed(B, ASSET, ticks, 43200);
  const sig = B.W.S.log.length;
  assert.ok(sig > 0, 'يجب أن تصدر إشارات حتى يكون الاختبار ذا معنى');
  assert.equal(B.clicks(), 0, 'نقرات على أزرار المنصة: ' + B.clicks() + ' من ' + sig + ' إشارة');
});

test('A7 المحاكاة الورقية تعمل: صفقات افتراضية مُعلَّمة ومسوّاة مع سبب كل إشارة', () => {
  const B = H.load();
  B.W.CFG.auto = true; B.W.CFG.gate = false;
  const ticks = H.randomWalkTicks(3, 86400 * 2, { drift: 2e-6 });
  H.runFeed(B, ASSET, ticks, 43200);
  const L = B.W.S.log;
  const paper = L.filter(e => e.virtual && e.auto);
  assert.ok(paper.length > 0, 'لا صفقات افتراضية');
  assert.ok(paper.every(e => e.virtual === true));
  assert.ok(paper.filter(e => e.win !== null).length > 0, 'لم تُسوَّ أي صفقة افتراضية');
  assert.ok(L.every(e => Array.isArray(e.why) && e.why.length > 0), 'كل إشارة يجب أن تحمل سببها');
  assert.ok(paper.every(e => e.win === null || typeof e.candleWin === 'boolean' || e.candleWin === null));
});

test('A8 حدود المخاطرة تمنع الصفقة الافتراضية (استراحة بعد الخسائر)', () => {
  const B = H.load();
  const W = B.W;
  W.CFG.auto = true; W.CFG.gate = false;
  W.S.pausedUntil = Date.now() + 1e12;
  const ticks = H.randomWalkTicks(3, 86400 * 2, { drift: 2e-6 });
  H.runFeed(B, ASSET, ticks, 43200);
  assert.ok(W.S.log.length > 0);
  assert.equal(W.S.log.filter(e => e.try).length, 0, 'صفقة افتراضية رغم الاستراحة');
  assert.ok(W.S.log.some(e => (e.skip || []).some(x => /استراحة/.test(x))), 'يجب تسجيل سبب عدم الدخول');
});

test('A9 تقادم السعر: بعد توقف التيك تُلغى الإشارة الحالية', () => {
  const B = H.load();
  const ticks = H.randomWalkTicks(5, 7200);
  H.runFeed(B, ASSET, ticks, 3600);
  const last = ticks[ticks.length - 1][0];
  B.setNow((last + 30) * 1000);
  B.W.watchdog();
  const r = B.W.S.sigBy[ASSET];
  assert.equal(r.d, 'none');
  assert.ok(r.stale === true, 'يجب تعليم الإشارة كقديمة');
});

test('A10 فجوة في البيانات: لا تحليل حتى تتجمع شموع متصلة بعدها', () => {
  const B = H.load();
  const a = H.randomWalkTicks(7, 7200);
  const lastT = a[a.length - 1][0];
  const b = H.randomWalkTicks(8, 600, { t0: lastT + 900, p0: a[a.length - 1][1] }); // انقطاع 15 دقيقة
  H.runFeed(B, ASSET, a.concat(b), 3600);
  const r = B.W.S.sigBy[ASSET];
  assert.equal(r.d, 'none');
  assert.match(String(r.abst && r.abst[0]), /فجوة|انقطاع/);
});

test('A11 انقطاع الاتصال: لا تحليل أثناءه', () => {
  const B = H.load();
  const ticks = H.randomWalkTicks(9, 7200);
  H.runFeed(B, ASSET, ticks.slice(0, 7000), 3600);
  B.W.S.wsUp = false;
  for (const [ts, px] of ticks.slice(7000)) { B.setNow(ts * 1000); B.W.feedTick(ASSET, ts, px); }
  const r = B.W.S.sigBy[ASSET];
  assert.equal(r.d, 'none');
  assert.match(String(r.abst && r.abst[0]), /انقطاع/);
});
