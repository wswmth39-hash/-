'use strict';
// الاختبار الذهبي للمرحلة C: فصل المحرك عن الواجهة يجب ألا يغيّر أي نتيجة.
// يشغّل سيناريو طويلًا ومعقدًا عبر مسار WebSocket الحقيقي على v3.5 (قبل الفصل) وعلى الناتج الجديد،
// ويقارن بصمة كاملة بايتًا ببايت: كل قرار، كل إحصاء، كل ما حُفظ في التخزين، كل شمعة وحدث في المسجّل.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness');

const REF = process.env.WSNF_GOLDEN_A || 'v35';
const NEW = process.env.WSNF_GOLDEN_B || 'current';
const file = t => H.FILES[t] || t;

async function scenario(target) {
  const store = {}, recMem = {};
  const B = H.load({ file: file(target), store, recMem });
  const W = B.W, A1 = 'EURUSD_otc', A2 = 'AUDCAD_otc';
  await W.REC.openP;
  const ws = new B.ctx.WebSocket('wss://fake');
  ws.emit('open');
  const stream = (a, ticks) => { for (const [ts, p] of ticks) { B.setNow(ts * 1000 + 120); ws.emit('message', { data: '42["updateStream",[["' + a + '",' + ts + ',' + p + ']]]' }); } };
  const hist = (a, ticks) => ws.emit('message', { data: '42["updateHistoryNewFast",' + JSON.stringify({ asset: a, history: ticks }) + ']' });
  const signals = [];
  H.subscribe(W, 'signal', e => signals.push([e.asset, e.ct, e.dir, e.conf, e.try ? 1 : 0].join()));
  const results = [];
  H.subscribe(W, 'result', w => results.push(w ? 1 : 0));

  const t0 = 1700000000;
  const all = H.randomWalkTicks(201, 30 * 3600, { t0, drift: 4e-6, vol: 6e-5, jitter: .5 });
  hist(A1, all.slice(0, 8 * 3600));
  W.CFG.auto = true; W.CFG.gate = false; W.CFG.minConf = 55; W.CFG.maxPerHour = 30;
  stream(A1, all.slice(8 * 3600, 20 * 3600));
  W.setPayout(A1, .85);
  const g = all[20 * 3600 - 1];
  const after = H.randomWalkTicks(202, 6 * 3600, { t0: g[0] + 900, p0: g[1], drift: -1e-6 }); // فجوة 15 دقيقة
  stream(A1, after.slice(0, 2 * 3600));
  ws.emit('close'); W.onWsDown(); ws.emit('open');                // انقطاع ثم عودة
  stream(A1, after.slice(2 * 3600, 4 * 3600));
  const lt = after[4 * 3600 - 1][0];
  B.setNow((lt + 30) * 1000); W.watchdog();                         // تقادم السعر
  stream(A2, H.randomWalkTicks(203, 2 * 3600, { t0: lt + 40, p0: .66 }));
  hist(A1, all.slice(0, 8 * 3600));                                 // إعادة إرسال التاريخ
  W.setTf(30);
  stream(A1, H.randomWalkTicks(204, 3 * 3600, { t0: lt + 7300, p0: 1.1, drift: 2e-6 }));
  W.saveAll();
  await W.recFlush();

  const recs = recMem.c ? [...recMem.c.values()].sort((x, y) => (x.a + x.tf + x.t) < (y.a + y.tf + y.t) ? -1 : 1) : [];
  const S = W.S;
  return {
    signals, results,
    log: S.log, snapshot: W.snapshot(), journal: S.journal, audit: S.audit, net: S.net, halted: S.halted, haltWhy: S.haltWhy,
    pausedUntil: S.pausedUntil, hourly: S.hourly, corr: S.corr, corrH: S.corrH, errors: S.errors, trace: S.trace,
    decision: S.decision, sigBy: Object.fromEntries(Object.entries(S.sigBy).map(([k, r]) => [k, { d: r.d, conf: r.conf, abst: r.abst, regime: r.regime, notes: r.notes }])),
    sv: S.sv, svLog: S.svLog, clusters: W.clusterOf ? W.GRP && Object.keys(W.GRP).map(k => W.clusterOf(k)) : null,
    store: Object.keys(store).sort().map(k => [k, store[k]]),
    rec: recs, recEvents: recMem.e, recSess: W.REC.sess, recSeries: W.REC.series
  };
}

let ref = null, cur = null;
const get = async () => { if (!ref) { ref = await scenario(REF); cur = await scenario(NEW); } return [ref, cur]; };

test('G0 السيناريو غني بما يكفي ليكون الاختبار ذا معنى', async () => {
  const [a] = await get();
  assert.ok(a.signals.length > 50, 'إشارات: ' + a.signals.length);
  assert.ok(a.results.length > 5, 'نتائج: ' + a.results.length);
  assert.ok(a.rec.length > 1000, 'شموع مسجّلة: ' + a.rec.length);
  assert.ok(a.log.some(e => e.auto), 'صفقات افتراضية');
  assert.ok(a.recEvents.some(e => e.type === 'gap') && a.recEvents.some(e => e.type === 'ws_down') && a.recEvents.some(e => e.type === 'stale'));
});
for (const k of ['signals', 'results', 'log', 'snapshot', 'journal', 'audit', 'net', 'halted', 'haltWhy', 'pausedUntil', 'hourly', 'corr', 'corrH', 'errors', 'trace',
  'decision', 'sigBy', 'sv', 'svLog', 'clusters', 'store', 'rec', 'recEvents', 'recSess', 'recSeries']) {
  test('G ' + k + ' متطابق بايتًا ببايت مع ' + REF, async () => {
    const [a, b] = await get();
    assert.equal(JSON.stringify(b[k]), JSON.stringify(a[k]));
  });
}
