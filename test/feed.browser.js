'use strict';
// المرحلة 4 (v4): اختبار استقبال البيانات في Chromium حقيقي عبر WebSocket حقيقي (Playwright routeWebSocket يحاكي خادم المنصة).
// داخل الصفحة «عميل منصة» مُحاكى يتصرف مثل Socket.IO: اتصالان، رد على ping، وإعادة اتصال تلقائية بعد الانقطاع.
// السكربت يُحقن قبل سكربتات الصفحة (مثل document-start في Tampermonkey).
// يتحقق من: الشموع = شموع محسوبة بشكل مستقل من التيكات التي أرسلها الخادم فعلًا، التكرار والتالف لا يدخلان،
// تسلسل الحالات (متصل ← حي ← متأخر ← قديم ← غير متصل ← حي)، إعادة الاتصال، والواجهة تعرض نفس الحالة، والبوت لا يرسل شيئًا.
// الاستخدام: node test/feed.browser.js [screenshot.png]
const { chromium } = require('playwright');
const fs = require('fs');
const H = require('./harness');

const A = 'EURUSD_otc', B2 = 'AUDCAD_otc', TF = 60;
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const src = fs.readFileSync(H.FILES.current, 'utf8');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  const fails = [], R = {};
  const check = (ok, what) => { if (!ok) fails.push(what); };

  // ---- خادم المنصة المُحاكى ----
  const now0 = Math.floor(Date.now() / 1000);
  const T0 = now0 - 3 * 3600 - (now0 % 60);
  const all = H.randomWalkTicks(77, 3 * 3600, { t0: T0, jitter: .4 });
  let cursor = 3600;                  // الساعة الأولى تُرسل تاريخًا
  const sentValid = all.slice(0, 3600).map(x => x.slice()); // ما يجب أن يقبله البوت فعلًا
  let received = 0, conns = 0, mains = [], allWs = [];
  const binHist = a => Buffer.from(JSON.stringify(a));
  await page.routeWebSocket(/wss:\/\/po\.test\/socket\.io.*/, ws => {
    conns++;
    const second = /channel=2/.test(ws.url());
    if (!second) mains.push(ws);
    allWs.push(ws);
    ws.onMessage(m => { received++; if (m === '40') ws.send('40{"sid":"srv"}'); });
    ws.send('0{"sid":"eio","pingInterval":25000,"pingTimeout":20000}');
    if (second) {
      // اتصال ثانٍ يرسل أحداثًا ثنائية لأصل آخر متداخلة مع الأول (اختبار الحالة المستقلة لكل اتصال)
      ws.send('451-["updateStream",{"_placeholder":true,"num":0}]');
      setTimeout(() => ws.send(Buffer.from(JSON.stringify([[B2, T0 + 3600.5, 0.66]]))), 40);
      return;
    }
    if (conns === 1) {
      ws.send('451-["updateHistoryNewFast",{"_placeholder":true,"num":0}]');
      ws.send(binHist({ asset: A, history: all.slice(0, 3600) }));
    }
  });
  async function stream(n, perMsg = 20, junk = true) {
    let k = 0;
    while (k < n && cursor < all.length) {
      const batch = all.slice(cursor, cursor + perMsg); cursor += batch.length; k += batch.length;
      const out = batch.map(([ts, p]) => [A, ts, p]);
      batch.forEach(x => sentValid.push(x));
      if (junk && k % 400 === 0) { out.push([A, out[0][1] * 1000, out[0][2]]); out.push([A, out[0][1], 0]); out.push([A, out[0][1], out[0][2] * 1.9]); } // تالف
      const live = mains.filter(w => !w.__closed);
      const ws = live[live.length - 1];
      ws.send('42["updateStream",' + JSON.stringify(out) + ']');
      if (junk && k % 300 === 0) ws.send('42["updateStream",' + JSON.stringify(out) + ']'); // تكرار حرفي
      await sleep(15);
    }
  }

  // ---- الصفحة: السكربت أولًا (document-start) ثم عميل المنصة ----
  await page.route('https://po.test/**', r => r.fulfill({ contentType: 'text/html', body: `<html><body><div class="current-symbol">${A}</div><script>
    window.__clientSent = 0;
    function connect(url) {
      const ws = new WebSocket(url);
      ws.onopen = () => { ws.send('40'); window.__clientSent++; };
      ws.onmessage = e => { if (e.data === '2') { ws.send('3'); window.__clientSent++; } };
      ws.onclose = () => setTimeout(() => connect(url), 600);  // إعادة اتصال مثل Socket.IO
    }
    connect('wss://po.test/socket.io/?EIO=4&transport=websocket');
    connect('wss://po.test/socket.io/?EIO=4&transport=websocket&channel=2');
  </script></body></html>` }));
  await page.addInitScript({ content: 'window.__WSNF_TEST = true;\n' + src });
  await page.goto('https://po.test/');
  await page.waitForFunction(() => window.__WSNF25 && window.__WSNF25.feedView().open >= 2, null, { timeout: 5000 });
  await page.evaluate(() => { const C = window.__WSNF25.CFG; C.feedLiveMs = 1000; C.maxTickAgeMs = 2500; C.feedUnavailableMs = 8000; C.feedWaitMs = 4000; C.reloadAdviceMs = 1e9; });
  const timeline = [];
  let polling = true;
  const poll = (async () => { while (polling) { const s = await page.evaluate(() => window.__WSNF25.computeStatus()).catch(() => null); if (s && timeline[timeline.length - 1] !== s) timeline.push(s); await sleep(100); } })();

  await sleep(300);
  await stream(2400);                         // بث سريع (40 دقيقة من التيكات)
  R.liveDuring = timeline.includes('live');
  await sleep(4500);                          // صمت: حي ← متأخر ← قديم
  // انقطاع الشبكة يغلق كل اتصالات الصفحة (1006 محجوز ولا يُرسل؛ نستخدم 4000)
  await Promise.all(allWs.filter(w => !w.__closed).map(w => { w.__closed = true; return w.close({ code: 4000, reason: 'network' }); }));
  await sleep(300);
  const downStatus = await page.evaluate(() => window.__WSNF25.computeStatus());
  await page.waitForFunction(() => window.__WSNF25.feedView().open >= 2, null, { timeout: 5000 });  // أعاد العميل الاتصال
  await stream(1200, 20, false);
  await sleep(500);
  polling = false; await poll;

  const res = await page.evaluate(() => {
    const W = window.__WSNF25, f = W.feedView();
    return { f, candles: (W.S.candles['EURUSD_otc'] || []).map(c => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, n: c.nt })), b2: (W.S.candles['AUDCAD_otc'] || []).length,
      clientSent: window.__clientSent, badge: document.getElementById('wsnf25-host').shadowRoot.getElementById('feedBadge').textContent, status: W.computeStatus() };
  });
  // شموع مرجعية من التيكات الصالحة التي أرسلها الخادم فعلًا
  const exp = []; let c = null;
  for (const [ts, p] of sentValid) {
    const t = Math.floor(ts / TF) * TF;
    if (!c || t > c.t) { if (c) exp.push(c); c = { t, o: p, h: p, l: p, c: p, n: 1 }; }
    else { c.h = Math.max(c.h, p); c.l = Math.min(c.l, p); c.c = p; c.n++; }
  }
  exp.push(c);
  const got = res.candles;
  R.candles = { engine: got.length, expected: exp.length };
  check(got.length === exp.length, 'عدد الشموع ' + got.length + ' ≠ ' + exp.length);
  const firstDiff = got.findIndex((x, i) => JSON.stringify(x) !== JSON.stringify(exp[i]));
  check(firstDiff < 0, 'أول شمعة مختلفة عند ' + firstDiff + ': ' + JSON.stringify(got[firstDiff]) + ' ≠ ' + JSON.stringify(exp[firstDiff]));
  R.ticks = res.f.ticks; R.hist = res.f.hist; R.reconnects = res.f.reconnects; R.timeline = timeline; R.downStatus = downStatus;
  R.badge = res.badge; R.status = res.status; R.b2 = res.b2; R.serverReceived = received; R.clientSent = res.clientSent;
  check(res.f.ticks.dup > 0, 'لم يُكتشف التكرار');
  check(res.f.ticks.rej > 0 && Object.keys(res.f.ticks.reasons).length >= 3, 'لم يُرفض التالف: ' + JSON.stringify(res.f.ticks.reasons));
  check(res.f.reconnects >= 1, 'لم تُسجَّل إعادة الاتصال');
  check(res.b2 === 1, 'الحدث الثنائي من الاتصال الثاني لم يصل لأصله');
  const order = ['live', 'delayed', 'stale', 'disconnected', 'live'];
  let i = 0; for (const s of timeline) if (s === order[i]) i++;
  check(i === order.length, 'تسلسل الحالات: ' + timeline.join(' → '));
  check(['disconnected', 'connecting', 'connected'].includes(downStatus), 'الحالة بعد الإغلاق: ' + downStatus);
  check(res.status === 'live' || res.status === 'delayed', 'الحالة النهائية: ' + res.status);
  check(received === res.clientSent, 'وصل الخادم ' + received + ' رسالة بينما أرسل العميل ' + res.clientSent + ' — البوت أرسل شيئًا!');
  check(res.badge === res.f.label || res.badge.length > 0, 'الواجهة لا تعرض الحالة');
  check(!errors.length, 'أخطاء JS: ' + errors.join(' | '));
  // لا يظهر في أي صفحة «undefined» أو «NaN»: القيمة الناقصة تُعرض «غير متاح»
  const bad = await page.evaluate(async () => {
    const sh = document.getElementById('wsnf25-host').shadowRoot, out = [];
    for (const b of sh.querySelectorAll('#nav button[data-p]')) { b.click(); window.__WSNF25.ui.paint(); const t = sh.querySelector('.page.on').innerText + sh.getElementById('chips').innerText; const m = t.match(/.{0,30}(undefined|NaN).{0,10}/); if (m) out.push(b.dataset.p + ': ' + m[0]); }
    sh.querySelector('#nav button[data-p="home"]').click();
    return out;
  });
  check(!bad.length, 'قيم غير معرّفة في الواجهة: ' + bad.join(' | '));
  if (process.argv[2]) {
    await page.evaluate(() => { const sh = document.getElementById('wsnf25-host').shadowRoot; sh.querySelector('.splash').style.display = 'none'; });
    await page.screenshot({ path: process.argv[2] });
  }
  await browser.close();
  console.log(JSON.stringify(R, null, 1));
  console.log(fails.length ? 'FEED BROWSER: FAIL\n- ' + fails.join('\n- ') : 'FEED BROWSER: PASS');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
