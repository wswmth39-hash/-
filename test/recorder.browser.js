'use strict';
// اختبار المسجّل على IndexedDB حقيقي داخل Chromium (Playwright):
// الحفظ ← إعادة تحميل حقيقية للصفحة ← الاستعادة، تعدد الأصول والأطر، منع التكرار، التصدير/الاستيراد، وقياس الحجم الفعلي.
// الاستخدام: node test/recorder.browser.js [screenshot.png]
const { chromium } = require('playwright');
const fs = require('fs');
const H = require('./harness');

(async () => {
  const src = fs.readFileSync(H.target(), 'utf8');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.route('https://wsnf.test/**', r => r.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }));
  const boot = async () => {
    await page.goto('https://wsnf.test/');
    await page.evaluate(() => { class FakeWS extends EventTarget { constructor(u) { super(); this.url = u; } send() {} } window.WebSocket = FakeWS; window.__WSNF_TEST = true; });
    await page.addScriptTag({ content: src });
    await page.evaluate(() => window.__WSNF25.REC.openP);
  };
  const res = {}, fails = [];
  const check = (ok, what) => { if (!ok) fails.push(what); };

  await boot();
  res.kind = await page.evaluate(() => window.__WSNF25.REC.kind);
  check(res.kind === 'indexeddb', 'التخزين ليس IndexedDB: ' + res.kind);
  const now = Math.floor(Date.now() / 1000);
  const t1 = H.randomWalkTicks(61, 3 * 3600, { t0: now - 3 * 3600 });
  const t2 = H.randomWalkTicks(62, 3600, { t0: now - 3600, p0: 0.66 });
  res.first = await page.evaluate(async ([t1, t2]) => {
    const W = window.__WSNF25, ws = new window.WebSocket('wss://fake');
    ws.dispatchEvent(new Event('open'));
    const send = (a, ts, p) => ws.dispatchEvent(new MessageEvent('message', { data: '42["updateStream",[["' + a + '",' + ts + ',' + p + ']]]' }));
    W.handle('hist', { asset: 'EURUSD_otc', history: t1.slice(0, 7200) });
    for (const [ts, p] of t1.slice(7200)) send('EURUSD_otc', ts, p);
    W.setTf(30);
    for (const [ts, p] of t2) send('AUDCAD_otc', ts, p);
    W.handle('hist', { asset: 'AUDCAD_otc', history: t2 }); // إعادة إرسال تاريخ لفترة مسجّلة حيًا
    await W.recFlush();
    const ser = await W.REC.backend.series();
    const data = {};
    for (const s of ser) data[s.a + '|' + s.tf] = await W.REC.backend.range(s.a, s.tf);
    return { ser, sess: W.REC.sess, sample: JSON.stringify(data) };
  }, [t1, t2]);
  const ser = res.first.ser;
  check(ser.length === 2, 'عدد السلاسل ' + ser.length);
  check(res.first.sess.dup > 50, 'لم يُكتشف التكرار عند إعادة إرسال التاريخ (dup=' + res.first.sess.dup + ')');

  // إعادة تحميل حقيقية للصفحة
  await page.screenshot({ path: '/dev/null' }).catch(() => {});
  await boot();
  res.after = await page.evaluate(async () => {
    const W = window.__WSNF25, ser = await W.REC.backend.series(), data = {};
    for (const s of ser) data[s.a + '|' + s.tf] = await W.REC.backend.range(s.a, s.tf);
    const ev = await W.REC.backend.events(1000);
    return { ser, sample: JSON.stringify(data), evTypes: [...new Set(ev.map(e => e.type))], auto: W.CFG.auto };
  });
  check(res.after.sample === res.first.sample, 'البيانات بعد إعادة التحميل لا تطابق ما قبلها');
  check(JSON.stringify(res.after.ser) === JSON.stringify(ser), 'السلاسل بعد إعادة التحميل لا تطابق');
  check(res.after.evTypes.includes('hist') && res.after.evTypes.includes('tf'), 'الأحداث لم تُحفظ: ' + res.after.evTypes);

  // تصدير ثم مسح ثم استيراد في المتصفح نفسه
  res.rt = await page.evaluate(async () => {
    const W = window.__WSNF25, j = await W.recExport('jsonl'), c = await W.recExport('csv');
    await W.recClear();
    const empty = (await W.REC.backend.series()).length;
    const o1 = await W.recImport(j.text);
    const ser = await W.REC.backend.series(), data = {};
    for (const s of ser) data[s.a + '|' + s.tf] = await W.REC.backend.range(s.a, s.tf);
    const o2 = await W.recImport(c.text);
    return { n: j.count, empty, o1, o2, sample: JSON.stringify(data), jBytes: j.text.length, cBytes: c.text.length };
  });
  check(res.rt.empty === 0, 'المسح لم يفرغ القاعدة');
  check(res.rt.o1.added === res.rt.n && res.rt.o1.rejected === 0, 'استيراد JSONL: ' + JSON.stringify(res.rt.o1));
  check(res.rt.o2.dup === res.rt.n && res.rt.o2.added === 0, 'استيراد CSV فوق نفس البيانات: ' + JSON.stringify(res.rt.o2));
  check(res.rt.sample === res.first.sample, 'البيانات بعد التصدير/الاستيراد لا تطابق الأصل');

  // قياس الحجم الفعلي على القرص لـ 50,000 شمعة
  res.size = await page.evaluate(async () => {
    const W = window.__WSNF25, N = 50000, recs = [];
    let p = 1.1;
    for (let i = 0; i < N; i++) {
      const t = 1600000020 + i * 60, o = p; p = +(p * (1 + (Math.random() - .5) * 1e-3)).toFixed(5);
      const h = +(Math.max(o, p) + 1e-5).toFixed(5), l = +(Math.min(o, p) - 1e-5).toFixed(5);
      recs.push({ a: 'SIZE_TEST_otc', tf: 60, t: t - (t % 60), tc: t - (t % 60) + 60, o, h, l, c: p, n: 58, ft: t - (t % 60) + .31, lt: t - (t % 60) + 59.81, mg: 1.2, cts: t - (t % 60) + 60.3, src: 'live', rx: Date.now(), v: 1 });
    }
    const e0 = await navigator.storage.estimate();
    for (let i = 0; i < N; i += 5000) await W.REC.backend.putMany(recs.slice(i, i + 5000));
    await new Promise(r => setTimeout(r, 1500));
    const e1 = await navigator.storage.estimate();
    return { N, before: e0.usage, after: e1.usage, perCandle: Math.round((e1.usage - e0.usage) / N), json: Math.round(recs.map(r => JSON.stringify(r).length).reduce((a, b) => a + b) / N) };
  });

  // صفحة المسجّل في الواجهة
  const shot = process.argv[2];
  const ui = await page.evaluate(async () => {
    const sh = document.getElementById('wsnf25-host').shadowRoot;
    sh.querySelector('.splash').style.display = 'none';
    sh.querySelector('#nav button[data-p="rec"]').click();
    await window.__WSNF25.recRefreshSeries(); // سلسلة قياس الحجم كُتبت مباشرة في القاعدة
    await window.__WSNF25.recScanGaps();
    await new Promise(r => setTimeout(r, 1300));
    return { st: sh.getElementById('recSt').textContent, rows: sh.getElementById('recSer').children.length, ser: sh.getElementById('recSer').textContent.slice(0, 300) };
  });
  check(ui.rows >= 3, 'صفوف السلاسل في الواجهة: ' + ui.rows);
  check(/IndexedDB/.test(ui.st), 'الواجهة لا تعرض نوع التخزين');
  if (shot) await page.screenshot({ path: shot });
  await browser.close();
  if (errors.length) fails.push('JS errors: ' + errors.slice(0, 3).join(' | '));
  console.log(JSON.stringify({ kind: res.kind, series: ser.map(s => s.a + '|' + s.tf + ':' + s.count), dupOnHistResend: res.first.sess.dup,
    conflicts: res.first.sess.conflicts, rejected: res.first.sess.rejected, reasons: res.first.sess.reasons, events: res.after.evTypes,
    roundtrip: { n: res.rt.n, jsonlBytes: res.rt.jBytes, csvBytes: res.rt.cBytes }, size: res.size, ui }, null, 1));
  console.log(fails.length ? 'RECORDER BROWSER: FAIL\n- ' + fails.join('\n- ') : 'RECORDER BROWSER: PASS');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
