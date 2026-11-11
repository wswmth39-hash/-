'use strict';
// المرحلة C: اختبارات المحرك المفصول — تعمل على الوحدات مباشرة في Node (بلا متصفح وبلا vm وبلا واجهة).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./harness');
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const { analyze, noneR } = require('../src/core/decision');
const { verifyCandles, dataQuality, liveBlock, closedWindowError } = require('../src/core/quality');
const { resample, htfTrend } = require('../src/core/indicators');
const { marketContext } = require('../src/core/context');
const { createLearner } = require('../src/core/learning');
const { createClusters } = require('../src/core/clusters');
const { createEngine, startEngine } = require('../src/engine');
const { createState, KEYS } = require('../src/engine/state');

const read = f => fs.readFileSync(path.join(SRC, f), 'utf8');
const code = f => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const walk = d => fs.readdirSync(path.join(SRC, d)).filter(f => f.endsWith('.js')).map(f => d + '/' + f);

// ---------- أدوات ----------
function candles(seed, n, { tf = 60, t0 = 1.7e9 - (1.7e9 % 3600), drift = 0 } = {}) {
  const r = H.rng(seed), out = []; let p = 1.1;
  for (let i = 0; i < n; i++) {
    const o = p; p = p * (1 + drift + H.gauss(r) * 6e-4);
    out.push({ t: t0 + i * tf, o, h: Math.max(o, p) * (1 + r() * 3e-4), l: Math.min(o, p) * (1 - r() * 3e-4), c: p });
  }
  return out;
}
function coreDeps(cfg, extra = {}) {
  const book = {}, st = { corr: {}, corrH: {} };
  const learner = createLearner({ cfg, book, isLoading: () => false, sv: () => ({}), BE: () => 1 / (1 + cfg.payout) });
  const clusters = createClusters({ cfg, corr: () => st.corr, corrH: () => st.corrH, isLoading: () => false });
  return { cfg, A: { k: 'X', s: {}, b: {}, e: { hn: 0, hw: 0, ln: 0, lw: 0, rc: [] }, z: {} }, learner, clusters, useNew: () => false, sdh: [], tickAgeMs: null, ...extra };
}
const deepFreeze = o => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
const memEnv = (store = {}, t = 1.7e12) => ({ now: () => t, storage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } }, recMem: {} });

// ---------- 1) البنية: الفصل مفروض وليس اتفاقًا ----------
test('C-ARCH1 النواة لا تلمس DOM ولا التخزين ولا الساعة ولا حالة المحرك، ولا تستورد إلا من النواة', () => {
  // (?<![.\w$]) = معرّف حر، لا خاصية (مثل CFG.window التي هي حجم نافذة التحليل وليست كائن المتصفح)
  const banned = /(?<![.\w$])(window|document|localStorage|indexedDB|IDBKeyRange|WebSocket|setInterval|setTimeout|console|globalThis|E)\b|\bDate\.now|\bnew Date\(/;
  for (const f of walk('core')) {
    const c = code(f), m = banned.exec(c);
    assert.equal(m, null, f + ': ' + (m && m[0]));
    for (const r of c.matchAll(/require\('([^']+)'\)/g)) assert.match(r[1], /^\.\/[a-z]+$/, f + ' يستورد ' + r[1]);
    // الوحدتان اللتان تحتاجان حالة (learning/clusters) تأخذانها عبر عرض ضيق محقون للقراءة فقط
    const sUses = c.match(/(?<![.\w$])S\./g) || [];
    if (sUses.length) assert.match(c, /const S = Object\.freeze\(\{ get /, f + ': يستخدم S دون عرض محقون');
  }
});

test('C-ARCH2 الواجهة لا تستورد النواة ولا تقرأ/تكتب حالة المحرك مباشرة', () => {
  const c = code('ui/ui.js');
  assert.doesNotMatch(c, /require\(/, 'ui.js لا يستورد أي وحدة');
  assert.doesNotMatch(c, /\b(S|CFG|REC|E)\.[a-zA-Z]/, 'لا وصول مباشر لحالة المحرك');
  assert.doesNotMatch(c, /\b(wil|ema|rsi|atr|analyze|gate|wtR)\(/, 'لا حسابات تحليلية في الواجهة');
});

test('C-ARCH3 المحرك لا يلمس DOM ولا WebSocket (طبقة المنصة وحدها تفعل)', () => {
  for (const f of [...walk('engine'), ...walk('recorder')]) assert.doesNotMatch(code(f), /(?<![.\w$])(window|document|WebSocket|localStorage|querySelector)\b(?!\s*:)/, f);
  assert.match(code('platform/ws.js'), /win\.WebSocket/);
});

test('C-ARCH4 لا دورات اعتماد بين الوحدات، والنواة لا تعتمد على المحرك', () => {
  const deps = {};
  for (const f of [...walk('core'), ...walk('engine'), ...walk('recorder'), ...walk('platform'), ...walk('ui'), 'main.js']) {
    deps[f.replace(/\.js$/, '')] = [...code(f).matchAll(/require\('([^']+)'\)/g)].map(m => path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1])).replace(/\.js$/, '').replace(/\/index$/, '/index'));
  }
  for (const [m, ds] of Object.entries(deps)) if (m.startsWith('core/')) for (const d of ds) assert.ok(d.startsWith('core/'), m + ' → ' + d);
  const seen = {}, visit = (m, stack) => {
    if (stack.includes(m)) assert.fail('دورة: ' + stack.concat(m).join(' → '));
    if (seen[m]) return; seen[m] = 1;
    for (const d of deps[m] || deps[m + '/index'] || []) visit(d, stack.concat(m));
  };
  Object.keys(deps).forEach(m => visit(m, []));
});

test('C-ARCH5 dist مبني من src الحالي', () => {
  const { build, OUT } = require('../build');
  assert.equal(fs.readFileSync(OUT, 'utf8'), build(), 'شغّل: node build.js');
});

test('C-ARCH6 مفاتيح التخزين لم تتغير عن v3.5 (لا ترحيل في المرحلة C)', () => {
  const old = new Set(fs.readFileSync(H.FILES.v35, 'utf8').match(/'wsnf33s_[a-z_0-9]*'/g));
  const now = new Set(fs.readFileSync(H.FILES.current, 'utf8').match(/'wsnf33s_[a-z_0-9]*'/g));
  assert.deepEqual([...now].sort(), [...old].sort());
  assert.equal(KEYS.LIVE, 'wsnf33s_live');
});

// ---------- 2) عقد الشموع المغلقة ----------
test('C1 المحلّل يرفض نافذة فيها شمعة لم ينتهِ وقتها، ويقبلها فقط بعلَم صريح مع تعليم النتيجة', () => {
  const cfg = createState().CFG, cs = candles(1, 300, { drift: 6e-4 }), end = cs[299].t + 60;
  const closed = analyze(cs, coreDeps(cfg, { asOf: end }));
  assert.equal(closed.comp, true);
  const open = analyze(cs, coreDeps(cfg, { asOf: end - 1 }));
  assert.equal(open.d, 'none'); assert.match(open.abst[0], /غير مكتملة/);
  const forced = analyze(cs, coreDeps(cfg, { asOf: end - 1, allowOpen: true }));
  assert.equal(forced.incomplete, true);
  assert.match(forced.notes[0], /غير مكتملة/);
  assert.equal(closed.incomplete, undefined);
});

test('C2 بلا asOf لا يوجد تحليل (لا افتراض ضمني بأن الشموع مغلقة)', () => {
  const cfg = createState().CFG;
  const r = analyze(candles(2, 300), coreDeps(cfg, { asOf: undefined }));
  assert.equal(r.d, 'none'); assert.match(r.abst[0], /asOf/);
});

test('C3 بيانات ناقصة أو تالفة: لا تحليل مع سبب واضح', () => {
  const cfg = createState().CFG, ok = candles(3, 300), end = ok[299].t + 60;
  const r1 = analyze(ok.slice(0, 59), coreDeps(cfg, { asOf: ok[58].t + 60 }));
  assert.match(r1.abst[0], /تجميع البيانات 59\/60/);
  const bad = ok.map((c, i) => i === 150 ? { ...c, h: NaN } : c);
  assert.match(analyze(bad, coreDeps(cfg, { asOf: end })).abst[0], /غير موثوقة/);
  const unordered = ok.slice(); [unordered[10], unordered[11]] = [unordered[11], unordered[10]];
  assert.match(analyze(unordered, coreDeps(cfg, { asOf: end })).abst[0], /ترتيب/);
  const flat = ok.map(c => ({ ...c, o: 1, h: 1, l: 1, c: 1 }));
  assert.equal(analyze(flat, coreDeps(cfg, { asOf: end })).d, 'none');
});

test('C4 الفجوات: كشف الفجوة الحديثة، رفض كثرة الفجوات، وخفض جودة البيانات', () => {
  const cs = candles(4, 300);
  const holed = cs.filter((c, i) => i < 280 || i > 284).map(c => c); // فجوة 5 شموع قرب النهاية
  assert.match(liveBlock(holed, holed[holed.length - 1].t + 60, { live: true, wsUp: true, tf: 60, contigN: 30 }), /فجوة بيانات حديثة/);
  assert.equal(liveBlock(cs, cs[299].t + 60, { live: true, wsUp: true, tf: 60, contigN: 30 }), '');
  assert.match(liveBlock(cs, cs[299].t + 600, { live: true, wsUp: true, tf: 60, contigN: 30 }), /انقطاع في البيانات/);
  assert.match(liveBlock(cs, cs[299].t + 60, { live: true, wsUp: false, tf: 60, contigN: 30 }), /انقطاع الاتصال/);
  const sparse = cs.filter((c, i) => i % 15 !== 0);
  assert.equal(verifyCandles(sparse, 60, .05).ok, false);
  assert.ok(dataQuality(holed, 60, null, 8000).q < dataQuality(cs, 60, null, 8000).q);
  assert.ok(dataQuality(cs, 60, 30000, 8000).q < dataQuality(cs, 60, null, 8000).q, 'تيك متأخر يخفض الجودة');
});

// ---------- 3) تعدد الأطر الزمنية ----------
test('C5 إعادة التشكيل للإطار الأعلى محاذاة لحدود الساعة لكل إطار ومستبعِدة للناقص', () => {
  for (const tf of [15, 30, 60]) for (const k of [5, 15]) {
    const cs = candles(5, 233, { tf, t0: 1.7e9 - (1.7e9 % 3600) + 7 * tf });
    const h = resample(cs, k, tf), P = tf * k;
    assert.ok(h.length > 5, tf + '/' + k);
    assert.ok(h.every(x => x.t % P === 0), 'محاذاة ' + tf + '/' + k);
    assert.ok(h[0].t >= cs[0].t, 'الأولى ليست ناقصة البداية');
    assert.ok(h[h.length - 1].t + P <= cs[cs.length - 1].t + tf, 'الأخيرة مكتملة');
    const g = cs.filter(x => x.t >= h[1].t && x.t < h[1].t + P);
    assert.equal(h[1].o, g[0].o); assert.equal(h[1].c, g[g.length - 1].c);
    assert.equal(h[1].h, Math.max(...g.map(x => x.h))); assert.equal(h[1].l, Math.min(...g.map(x => x.l)));
  }
  assert.throws(() => resample(candles(5, 10), 5), /tf/);
});

test('C6 ثبات التحليل عبر الأطر: نفس الشموع بزمن مقاس على tf=15/30/60 تعطي نفس القرار', () => {
  const base = candles(6, 300, { drift: 5e-4 });
  const res = {};
  for (const tf of [15, 30, 60]) {
    const cfg = createState().CFG; cfg.tf = tf;
    const t0 = base[0].t - (base[0].t % (tf * 15));
    const cs = base.map((c, i) => ({ ...c, t: t0 + i * tf }));
    const r = analyze(cs, coreDeps(cfg, { asOf: cs[299].t + tf }));
    res[tf] = JSON.stringify({ d: r.d, conf: r.conf, sc: r.sc, agree: r.agree, regime: r.regime, raw: r.raw, ctx: r.ctx, vetoes: r.vetoes, htf: r.htf });
  }
  assert.ok(JSON.parse(res[60]).raw && Object.keys(JSON.parse(res[60]).raw).length > 10);
  assert.equal(res[30], res[60]); assert.equal(res[15], res[60]);
});

test('C7 الإطار الأعلى بلا شموع كافية: لا انهيار ولا اتجاه مفترض', () => {
  const cs = candles(7, 70);
  assert.equal(htfTrend(cs, 5, 60), 0);
  const ctx = marketContext(cs, { tf: 60, htfK: 5 });
  assert.equal(ctx.f15d, 0);
  assert.ok(typeof ctx.kind === 'string');
});

// ---------- 4) النواة دوال بحتة ----------
test('C8 النواة لا تعدّل مدخلاتها، وتعطي نفس النتيجة لنفس المدخلات', () => {
  const cfg = createState().CFG, cs = deepFreeze(candles(8, 300, { drift: 4e-4 }));
  const d1 = coreDeps(cfg, { asOf: cs[299].t + 60 });
  d1.A.s.trend = { hn: 400, hw: 230, ln: 0, lw: 0, rc: [] };
  deepFreeze(d1.A);
  const a = analyze(cs, d1), b = analyze(cs, d1);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

// ---------- 5) المحرك ككائن مستقل ----------
function run(E, ticks, asset = 'EURUSD_otc') {
  const out = [];
  E.on('signal', e => out.push([e.ct, e.dir, e.conf].join()));
  for (const [ts, p] of ticks) { E.env.now = () => ts * 1000; E.clock = () => ts * 1000; E.fn.feedTick(asset, ts, p); }
  return out;
}
test('C9 محركان في نفس العملية مستقلان تمامًا (لا حالة مشتركة بين الوحدات)', () => {
  const t1 = H.randomWalkTicks(91, 12 * 3600, { drift: 3e-6 }), t2 = H.randomWalkTicks(92, 12 * 3600, { drift: -3e-6 });
  const solo = startEngine(createEngine(memEnv())); solo.S.wsUp = true;
  const a0 = run(solo, t1);
  const E1 = startEngine(createEngine(memEnv())), E2 = startEngine(createEngine(memEnv()));
  E1.S.wsUp = E2.S.wsUp = true;
  const a1 = [], b1 = [];
  E1.on('signal', e => a1.push([e.ct, e.dir, e.conf].join())); E2.on('signal', e => b1.push(1));
  for (let i = 0; i < t1.length; i++) { E1.fn.feedTick('EURUSD_otc', t1[i][0], t1[i][1]); E2.fn.feedTick('EURUSD_otc', t2[i][0], t2[i][1]); }
  assert.ok(a0.length > 0 && b1.length > 0);
  assert.deepEqual(a1, a0);
});

test('C10 المحرك بلا واجهة في Node يطابق الملف المبني داخل بيئة المتصفح المحاكاة', () => {
  const ticks = H.randomWalkTicks(93, 16 * 3600, { drift: 3e-6 });
  let now = 1.7e12;
  const store = {};
  const E = createEngine({ now: () => now, storage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } }, recMem: {} });
  startEngine(E); E.S.wsUp = true;
  const a = []; E.on('signal', e => a.push([e.ct, e.dir, e.conf].join()));
  E.fn.loadHistory('EURUSD_otc', ticks.slice(0, 4 * 3600));
  for (const [ts, p] of ticks.slice(4 * 3600)) { now = ts * 1000; E.fn.feedTick('EURUSD_otc', ts, p); }
  const B = H.load(), b = [];
  H.subscribe(B.W, 'signal', e => b.push([e.ct, e.dir, e.conf].join()));
  H.runFeed(B, 'EURUSD_otc', ticks, 4 * 3600);
  assert.ok(a.length > 5);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(E.fn.snapshot()), JSON.stringify(B.W.snapshot()));
});

// ---------- 6) نموذج العرض للقراءة فقط ----------
const hashState = E => JSON.stringify([E.S, E.CFG, E.fn.REC.series, E.fn.REC.sess], (k, v) => v instanceof Map ? [...v] : (typeof v === 'function' ? undefined : v));
test('C11 قراءة نموذج العرض (كل الصفحات، بلا بيانات وبعدها) لا تغيّر حالة المحرك إطلاقًا', () => {
  const E = startEngine(createEngine(memEnv())); E.S.wsUp = true;
  const readAll = () => { E.fn.view('EURUSD OTC'); E.fn.lab(); E.fn.recorder(); E.fn.chart(); E.fn.settings(); };
  const h0 = hashState(E); readAll(); assert.equal(hashState(E), h0, 'قبل أي بيانات');
  run(E, H.randomWalkTicks(94, 6 * 3600, { drift: 3e-6 }));
  E.fn.setTf(30); // إطار بلا أي سجل إحصاء بعد: v3.5 كانت تُنشئ سجلًا فارغًا هنا لمجرد العرض
  const h1 = hashState(E);
  for (let i = 0; i < 20; i++) readAll();
  assert.equal(hashState(E), h1);
  assert.equal(E.S.A['EURUSD_otc@30'], undefined);
});

test('C12 نموذج العرض يعيد نسخًا: تعديلها لا يصل إلى المحرك', () => {
  const E = startEngine(createEngine(memEnv())); E.S.wsUp = true;
  run(E, H.randomWalkTicks(95, 8 * 3600, { drift: 3e-6 }));
  const h = hashState(E), V = E.fn.view(null), Lb = E.fn.lab(), R = E.fn.recorder();
  V.log.forEach(e => { e.win = 'x'; }); V.st.errors.push(1); V.cfg.minConf = 1; if (V.r) V.r.notes.push('x');
  Lb.audit.n = -1; R.sess.added = -1; R.series.push({});
  assert.equal(hashState(E), h);
});

test('C13 الأوامر هي القناة الوحيدة للكتابة وتطابق سلوك أزرار v3.5', () => {
  const E = startEngine(createEngine(memEnv()));
  E.S.halted = true; E.S.net = -3;
  assert.equal(E.cmd.toggleAuto(), true);
  assert.equal(E.CFG.auto, true); assert.equal(E.S.halted, false); assert.equal(E.S.net, 0);
  assert.equal(E.cmd.toggleAuto(), false);
  assert.equal(E.cmd.toggleGate(), false); assert.equal(E.CFG.gate, false);
  assert.equal(E.cmd.setMinConf(70), 70);
  E.S.cur = 'EURUSD_otc'; E.S.candles = { EURUSD_otc: [] };
  assert.equal(E.cmd.setPayoutPct(85), 85); assert.equal(E.CFG.payoutBy.EURUSD_otc, .85);
  assert.equal(E.cmd.toggleLock('EURUSD OTC'), 'EURUSD_otc'); assert.equal(E.cmd.toggleLock(null), null);
  assert.equal(E.cmd.setTf(7), false); assert.equal(E.cmd.setTf(30), true);
  const mem = E.cmd.exportMemory(); assert.equal(mem.app, 'wsnf smart bot');
  E.cmd.kill(); assert.equal(E.S.halted, true); assert.equal(E.CFG.auto, false);
  assert.equal(Object.keys(E.cmd).some(k => /click|exec|send|order|real/i.test(k)), false, 'لا أوامر تنفيذ');
});
