'use strict';
// المرحلة D: مسجّل الشموع — الدقة، منع التكرار والنقص، الفجوات، عدم وجود بيانات مستقبلية، الحفظ والاستعادة، الاستيراد والتصدير.
// الشموع المتوقعة تُحسب هنا بشكل مستقل من التيكات (وليس بكود البوت).
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness');

const A = 'EURUSD_otc', TF = 60;
const TOL = Math.max(5, .15 * TF);

// مرجع مستقل: يبني الشموع من تيكات مرتبة ويطبّق قواعد الاكتمال الموثّقة في docs/RECORDER_DESIGN.md
function expected(ticks, tf = TF, src = 'live') {
  const out = [];
  let c = null;
  const close = closeTs => {
    if (!c) return;
    const ok = c.ft - c.t <= TOL && c.t + tf - c.lt <= TOL && c.mg <= tf / 2;
    if (ok) out.push({ a: A, tf, t: c.t, tc: c.t + tf, o: c.o, h: c.h, l: c.l, c: c.c, n: c.n, ft: c.ft, lt: c.lt, mg: +c.mg.toFixed(3), cts: closeTs, src });
  };
  for (const [ts, p] of ticks) {
    const t = Math.floor(ts / tf) * tf;
    if (!c || t > c.t) { close(ts); c = { t, o: p, h: p, l: p, c: p, n: 1, ft: ts, lt: ts, mg: 0 }; }
    else { c.mg = Math.max(c.mg, ts - c.lt); c.h = Math.max(c.h, p); c.l = Math.min(c.l, p); c.c = p; c.lt = ts; c.n++; }
  }
  return out; // الشمعة الأخيرة مفتوحة: لا تُسجَّل
}
const strip = r => { const o = { ...r }; delete o.rx; delete o.v; return o; };
async function boot(opts = {}) {
  const B = H.load({ recMem: opts.recMem || {}, store: opts.store || {} });
  await B.W.REC.openP;
  B.W.S.wsUp = true;
  return B;
}
function live(B, ticks) { for (const [ts, px] of ticks) { B.setNow(ts * 1000); B.W.feedTick(A, ts, px); } }
const all = B => B.W.recFlush().then(() => B.W.REC.backend.range(A, TF));

test('D1 كل شمعة مسجّلة تطابق حرفيًا شمعة مبنية بشكل مستقل من التيكات (OHLC، الأوقات، العدد)', async () => {
  const B = await boot();
  const ticks = H.randomWalkTicks(41, 3 * 3600);
  live(B, ticks);
  const got = await all(B), exp = expected(ticks);
  assert.ok(exp.length > 170, 'عدد متوقع ' + exp.length);
  assert.equal(got.length, exp.length);
  got.forEach((r, i) => assert.deepEqual(JSON.parse(JSON.stringify(strip(r))), exp[i], 'شمعة ' + r.t));
  assert.ok(got.every(r => r.v === 1 && Number.isFinite(r.rx)));
  assert.equal(B.W.REC.sess.rejected, 1, 'الشمعة الأولى ناقصة (بدأ البث في منتصفها)');
});

test('D2 لا معلومات مستقبلية: الشمعة لا تُسجَّل قبل تيك بعد نهايتها، ولا تحوي إلا تيكاتها', async () => {
  const B = await boot();
  const ticks = H.randomWalkTicks(42, 1800);
  const tb = Math.floor(ticks[900][0] / TF) * TF; // حد شمعة
  live(B, ticks.filter(x => x[0] < tb));
  const before = await all(B);
  assert.ok(!before.some(r => r.t === tb - TF), 'سُجّلت الشمعة قبل انتهائها');
  live(B, ticks.filter(x => x[0] >= tb && x[0] < tb + 1));
  const after = await all(B);
  const r = after.find(x => x.t === tb - TF);
  assert.ok(r, 'لم تُسجَّل بعد انتهائها');
  assert.ok(after.every(x => x.cts >= x.tc && x.lt < x.tc && x.ft >= x.t), 'تيك خارج حدود الشمعة');
  // تغيير كل التيكات بعد اللحظة T لا يغيّر أي شمعة انتهت قبلها
  const T = tb + 0.5;
  const alt = ticks.filter(x => x[0] <= T).concat(H.randomWalkTicks(77, 900, { t0: Math.ceil(T) + .3, p0: 2 }));
  const B1 = await boot(), B2 = await boot();
  live(B1, ticks); live(B2, alt);
  const k = rs => JSON.stringify(rs.filter(x => x.tc <= tb).map(strip));
  assert.equal(k(await all(B2)), k(await all(B1)));
});

test('D3 منع التكرار: إعادة إرسال التاريخ لا تكرر، والحي يبقى عند التعارض ويُقاس الفرق', async () => {
  const B = await boot();
  const ticks = H.randomWalkTicks(43, 2 * 3600);
  live(B, ticks);
  const n0 = (await all(B)).length;
  B.W.handle('hist', { asset: A, history: ticks });
  B.W.handle('hist', { asset: A, history: ticks });
  const r1 = await all(B);
  assert.equal(r1.length, n0);
  assert.ok(r1.every(r => r.src === 'live' || r.src === 'mixed'));
  assert.ok(B.W.REC.sess.dup >= n0, 'dup=' + B.W.REC.sess.dup);
  const shifted = ticks.map(([ts, p]) => [ts, +(p * 1.001).toFixed(5)]);
  B.W.handle('hist', { asset: A, history: shifted });
  const r2 = await all(B);
  assert.equal(JSON.stringify(r2), JSON.stringify(r1), 'التاريخ المختلف لا يستبدل الحي');
  assert.ok(B.W.REC.sess.conflicts > 0 && B.W.REC.sess.maxDiff > 5e-4);
});

test('D3b التاريخ أولًا ثم ملف حي للفترة نفسها: الحي يستبدل التاريخي', async () => {
  const B = await boot();
  const ticks = H.randomWalkTicks(44, 3600);
  B.W.handle('hist', { asset: A, history: ticks });
  const h = await all(B);
  assert.ok(h.length > 50 && h.every(r => r.src === 'hist'));
  const file = (await B.W.recExport('jsonl')).text.replace(/"src":"hist"/g, '"src":"live"');
  const lines = file.split('\n'); const head = JSON.parse(lines[0]); delete head.checksum; lines[0] = JSON.stringify(head);
  const o = await B.W.recImport(lines.join('\n'));
  assert.equal(o.replaced, h.length);
  assert.ok((await all(B)).every(r => r.src === 'live'));
});

test('D4 رفض الشموع الناقصة: بداية متأخرة، فجوة تيكات داخلية، انقطاع أثناء الشمعة', async () => {
  const B = await boot();
  const t0 = 1700000040; // حد دقيقة
  const mk = (from, to, p = 1.1) => { const o = []; for (let s = from; s < to; s++) o.push([t0 + s + .3, p + s * 1e-5]); return o; };
  live(B, mk(0, 60).concat(mk(80, 120)).concat(mk(120, 130)).concat(mk(130, 160)).concat(mk(190, 240)));
  // الشمعة 0: كاملة · 60: تبدأ عند +20 ث (ناقصة) · 120: فجوة 40 ث داخلها (130→170 مفقودة ثم 190 في الشمعة التالية)
  const sess = B.W.REC.sess, rs = await all(B);
  assert.equal(JSON.stringify(rs.map(r => r.t - t0)), '[0]');
  assert.ok(Object.keys(sess.reasons).some(k => /ناقصة/.test(k)), JSON.stringify(sess.reasons));
  // فجوة داخلية خالصة: الحواف سليمة لكن 40 ث بلا تيك في المنتصف
  const B2 = await boot();
  live(B2, mk(0, 10).concat(mk(50, 60)).concat(mk(60, 61)));
  assert.equal((await all(B2)).length, 0);
  assert.ok(Object.keys(B2.W.REC.sess.reasons).some(k => /فجوة تيكات/.test(k)), JSON.stringify(B2.W.REC.sess.reasons));
  // انقطاع WebSocket أثناء الشمعة
  const B3 = await boot();
  live(B3, mk(0, 30));
  B3.W.S.wsCloseAt = B3.ctx.Date.now();
  live(B3, mk(30, 61));
  assert.equal((await all(B3)).length, 0);
  assert.ok(Object.keys(B3.W.REC.sess.reasons).some(k => /انقطاع/.test(k)));
});

test('D4b قواعد صحة السجل (كل سبب رفض)', () => {
  const { recCheck } = H.load().W;
  const ok = { a: A, tf: 60, t: 120, tc: 180, o: 1, h: 1.2, l: .9, c: 1.1, n: 50, ft: 120.4, lt: 179.6, mg: 2, cts: 180.2, src: 'live', rx: 1, v: 1 };
  assert.equal(recCheck(ok), '');
  const bad = [
    [{ t: 130, tc: 190 }, /محاذ/], [{ tc: 200 }, /إغلاق/], [{ h: 1.05 }, /OHLC/], [{ l: 1.05 }, /OHLC/], [{ l: 0 }, /OHLC/],
    [{ n: 0 }, /تيكات/], [{ ft: 119 }, /خارج/], [{ lt: 180 }, /خارج/], [{ cts: 179.9 }, /مستقبلية/], [{ src: 'x' }, /مصدر/],
    [{ o: NaN }, /رقمية/], [{ a: '' }, /أصل/], [{ tf: 0 }, /إطار/], [{ v: 2 }, /مخطط/], [{ mg: 61 }, /فجوة/]
  ];
  for (const [patch, re] of bad) assert.match(recCheck({ ...ok, ...patch }), re, JSON.stringify(patch));
});

test('D5 اكتشاف الفجوات حيًا ومن البيانات المخزّنة + أحداث الانقطاع', async () => {
  const B = await boot();
  const a = H.randomWalkTicks(45, 3600), last = a[a.length - 1];
  const b = H.randomWalkTicks(46, 1800, { t0: last[0] + 600, p0: last[1] }); // ثقب 10 دقائق
  live(B, a.concat(b));
  await B.W.recFlush();
  const ev = B.W.REC.events.filter(e => e.type === 'gap');
  assert.equal(ev.length, 1, JSON.stringify(ev));
  const exp = expected(a.concat(b)), ts = exp.map(r => r.t);
  const expMissing = (ts[ts.length - 1] - ts[0]) / TF + 1 - ts.length;
  const scan = await B.W.recScanGaps();
  assert.equal(scan[0].gaps, 1);
  assert.equal(scan[0].missing, expMissing);
  assert.equal(ev[0].n, expMissing);
  // انقطاع وعودة الاتصال
  const ws = new B.ctx.WebSocket('wss://x'); ws.emit('open'); ws.emit('close');
  B.W.onWsDown(); ws.emit('open');
  const types = B.W.REC.events.map(e => e.type);
  assert.ok(types.includes('ws_down') && types.includes('ws_up'));
});

test('D6 الحفظ والاستعادة بعد إعادة التحميل، والفجوة عبر إعادة التحميل تُكتشف', async () => {
  const recMem = {}, store = {};
  const B1 = await boot({ recMem, store });
  const a = H.randomWalkTicks(47, 2 * 3600);
  live(B1, a);
  const r1 = await all(B1);
  const B2 = await boot({ recMem, store }); // «إعادة تحميل»: كائن جديد بالكامل، نفس التخزين
  const r2 = await B2.W.REC.backend.range(A, TF);
  assert.equal(JSON.stringify(r2), JSON.stringify(r1));
  assert.equal(B2.W.REC.series[A + '|' + TF].count, r1.length);
  const last = a[a.length - 1];
  live(B2, H.randomWalkTicks(48, 1200, { t0: last[0] + 1800, p0: last[1] }));
  await B2.W.recFlush();
  assert.equal(B2.W.REC.events.filter(e => e.type === 'gap').length, 1, 'فجوة عبر إعادة التحميل');
  B2.W.recSetOn(false);
  const B3 = await boot({ recMem, store });
  assert.equal(B3.W.REC.on, false, 'حالة التشغيل تُحفظ');
  assert.ok((await B3.W.REC.backend.events(500)).length > 0, 'الأحداث تُحفظ');
});

test('D7 تصدير/استيراد JSONL وCSV يعيد نفس البيانات حرفيًا، والملف المعدّل يُرفض', async () => {
  const B = await boot();
  live(B, H.randomWalkTicks(49, 2 * 3600));
  const orig = await all(B);
  const j = await B.W.recExport('jsonl'), c = await B.W.recExport('csv');
  assert.equal(j.count, orig.length);
  const head = JSON.parse(j.text.split('\n')[0]);
  assert.equal(head.type, 'wsnf-candles'); assert.equal(head.count, orig.length); assert.match(head.checksum, /^fnv1a32:[0-9a-f]{8}$/);
  for (const text of [j.text, c.text]) {
    const B2 = await boot();
    const o = await B2.W.recImport(text);
    assert.equal(o.added, orig.length, JSON.stringify(o));
    assert.equal(o.rejected, 0);
    assert.equal(JSON.stringify(await all(B2)), JSON.stringify(orig));
    const again = await B2.W.recImport(text);
    assert.equal(again.added, 0); assert.equal(again.dup, orig.length);
  }
  // التصدير حتمي
  assert.equal((await B.W.recExport('jsonl')).text.split('\n').slice(1).join('\n'), j.text.split('\n').slice(1).join('\n'));
  // تعديل سعر واحد ⇒ رفض كامل
  const lines = j.text.split('\n');
  lines[5] = lines[5].replace(/"c":([0-9.]+)/, (m, v) => '"c":' + (+v + 0.001));
  const B3 = await boot();
  await assert.rejects(B3.W.recImport(lines.join('\n')), /checksum/);
  assert.equal((await all(B3)).length, 0);
  await assert.rejects(B3.W.recImport('{"type":"other"}\n'), /ليس ملف/);
});

test('D7b استيراد CSV يرفض الأسطر غير الصالحة ويقبل الصالحة', async () => {
  const B = await boot();
  live(B, H.randomWalkTicks(50, 1800));
  const c = (await B.W.recExport('csv')).text.trim().split('\n');
  const n = c.length - 1;
  c[2] = c[2].replace(/,live,/, ',banana,');           // مصدر غير معروف
  c[3] = c[3].split(',').map((v, i) => i === 6 ? '0.0001' : v).join(','); // قمة أقل من الإغلاق
  const B2 = await boot();
  const o = await B2.W.recImport(c.join('\n') + '\nnot,a,row\n');
  assert.equal(o.rejected, 3, JSON.stringify(o.reasons));
  assert.equal(o.added, n - 2);
});

test('D8 المسجّل لا يؤثر على التحليل: القرارات متطابقة مع التسجيل وبدونه', async () => {
  const ticks = H.randomWalkTicks(51, 86400, { drift: 2e-6 });
  const run = async on => {
    const B = await boot(), out = [];
    if (!on) B.W.recSetOn(false);
    H.subscribe(B.W, 'signal', e => out.push([e.ct, e.dir, e.conf].join()));
    H.runFeed(B, A, ticks, 21600);
    await B.W.recFlush();
    return { out, n: (await B.W.REC.backend.range(A, TF)).length };
  };
  const on = await run(true), off = await run(false);
  assert.ok(on.out.length > 0);
  assert.deepEqual(on.out, off.out);
  assert.ok(on.n > 1000); assert.equal(off.n, 0);
});

test('D9 حد السلسلة: يتوقف التسجيل دون حذف أي قديم', async () => {
  const B = await boot();
  B.W.CFG.recMaxPerSeries = 50;
  live(B, H.randomWalkTicks(52, 2 * 3600));
  const rs = await all(B);
  assert.equal(rs.length, 50);
  assert.ok(B.W.REC.events.some(e => e.type === 'cap'));
  assert.ok(Object.keys(B.W.REC.sess.reasons).some(k => /الحد الأقصى/.test(k)));
  assert.equal(rs[0].t, Math.min(...rs.map(r => r.t)), 'الأقدم باقٍ');
});

test('D10 كل إطار زمني سلسلة منفصلة', async () => {
  const B = await boot();
  const t = H.randomWalkTicks(53, 3600);
  live(B, t.slice(0, 1800));
  B.W.setTf(30);
  live(B, t.slice(1800));
  await B.W.recFlush();
  const keys = Object.keys(B.W.REC.series).sort();
  assert.deepEqual(keys, [A + '|30', A + '|60']);
  assert.ok((await B.W.REC.backend.range(A, 30)).every(r => r.t % 30 === 0 && r.tc - r.t === 30));
  assert.ok(B.W.REC.events.some(e => e.type === 'tf'));
});

test('D11 التاريخ يُعلَّم «hist» والشمعة التي جمعت تاريخًا وحيًا تُعلَّم «mixed»', async () => {
  const B = await boot();
  const t = H.randomWalkTicks(54, 7200);
  const cut = t.findIndex(x => x[0] % 60 > 30 && x[0] > t[0][0] + 3600);
  B.W.handle('hist', { asset: A, history: t.slice(0, cut) });
  live(B, t.slice(cut));
  const rs = await all(B);
  const at = Math.floor(t[cut][0] / 60) * 60;
  assert.equal(rs.find(r => r.t === at).src, 'mixed');
  assert.ok(rs.filter(r => r.t < at).every(r => r.src === 'hist'));
  assert.ok(rs.filter(r => r.t > at).every(r => r.src === 'live'));
});

test('D12 فشل الحفظ: السجلات تبقى في الانتظار ثم تُحفظ مرة واحدة فقط عند النجاح', async () => {
  const B = await boot();
  const be = B.W.REC.backend, real = be.putMany.bind(be);
  let fail = true;
  be.putMany = recs => fail ? Promise.reject(new Error('QuotaExceededError (محاكاة)')) : real(recs);
  const ticks = H.randomWalkTicks(55, 1800);
  live(B, ticks);
  await B.W.recFlush();
  assert.match(B.W.REC.sess.flushErr, /Quota/);
  assert.ok(B.W.REC.q.size > 20, 'السجلات يجب أن تبقى في الانتظار: ' + B.W.REC.q.size);
  assert.ok(B.W.S.errors.some(e => e.code === 'REC_FLUSH'));
  fail = false;
  await B.W.recFlush();
  const rs = await all(B);
  assert.equal(B.W.REC.sess.flushErr, '');
  assert.equal(B.W.REC.q.size, 0);
  assert.equal(JSON.stringify(rs.map(strip)), JSON.stringify(expected(ticks)));
  assert.equal(B.W.REC.series[A + '|' + TF].count, rs.length);
});
