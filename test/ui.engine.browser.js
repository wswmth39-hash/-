'use strict';
// المرحلة C — الواجهة لا تؤثر على التحليل، وتعرض نفس النتائج. في Chromium حقيقي (Playwright) بوقت ثابت.
//  U1: نفس السيناريو بلا واجهة ومع واجهة تُرسم بكثافة وتتنقل بين كل الصفحات أثناء البث ← بصمة المحرك متطابقة.
//  U2: الرسم المتكرر لكل الصفحات بعد تغيير الإطار لا يغيّر حالة المحرك (v3.6). ويُقاس نفس الشيء على v3.5 للمقارنة.
//  U3: نص كل صفحة في v3.5 وv3.6 متطابق لنفس البيانات (بعد توحيد الأوقات ورقم الإصدار).
// الاستخدام: node test/ui.engine.browser.js
const { chromium } = require('playwright');
const fs = require('fs');
const H = require('./harness');

const T0 = Date.UTC(2026, 10, 11, 9, 0, 0);
const PAGES = ['home', 'strat', 'lab', 'log', 'mem', 'rec', 'err', 'chart'];

async function session(browser, file, { ui, paintEvery = 0 }) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'UTC', locale: 'ar' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.clock.setFixedTime(T0);
  await page.route('https://wsnf.test/**', r => r.fulfill({ contentType: 'text/html', body: '<html><body><div class="current-symbol">EURUSD_otc</div></body></html>' }));
  await page.goto('https://wsnf.test/');
  await page.evaluate(noui => {
    class FakeWS extends EventTarget { constructor(u) { super(); this.url = u; window.__ws = this; } send() {} }
    window.WebSocket = FakeWS; window.__WSNF_TEST = true; window.__WSNF25_NOUI = noui;
  }, !ui);
  await page.addScriptTag({ content: fs.readFileSync(file, 'utf8') });
  await page.evaluate(() => window.__WSNF25.REC.openP);
  const ticks = H.randomWalkTicks(301, 14 * 3600, { t0: T0 / 1000 - 14 * 3600, drift: 4e-6, vol: 6e-5, jitter: .5 });
  await page.evaluate(async ([ticks, paintEvery]) => {
    const W = window.__WSNF25, ws = new window.WebSocket('wss://fake');
    ws.dispatchEvent(new Event('open'));
    const signals = window.__signals = [];
    // v3.6: ناقل الأحداث. v3.5: خانة واحدة تشغلها الواجهة أصلًا، فنسلسل معها بدل استبدالها
    const sub = (t, f) => { if (W.on) return W.on(t, f); const k = t === 'signal' ? 'onFlash' : 'onResult', prev = W.S[k]; W.S[k] = e => { if (prev) prev(e); f(e); }; };
    sub('signal', e => signals.push([e.ct, e.dir, e.conf, e.try ? 1 : 0].join()));
    ws.dispatchEvent(new MessageEvent('message', { data: '42["updateHistoryNewFast",' + JSON.stringify({ asset: 'EURUSD_otc', history: ticks.slice(0, 4 * 3600) }) + ']' }));
    W.CFG.auto = true; W.CFG.gate = false; W.CFG.minConf = 55; W.CFG.maxPerHour = 30;
    const sh = document.getElementById('wsnf25-host') && document.getElementById('wsnf25-host').shadowRoot;
    const pages = ['home', 'strat', 'lab', 'log', 'mem', 'rec', 'err', 'chart'];
    let i = 0;
    for (const [ts, p] of ticks.slice(4 * 3600)) {
      ws.dispatchEvent(new MessageEvent('message', { data: '42["updateStream",[["EURUSD_otc",' + ts + ',' + p + ']]]' }));
      if (paintEvery && ++i % paintEvery === 0 && W.ui) {
        sh.querySelector('#nav button[data-p="' + pages[(i / paintEvery) % pages.length] + '"]').click();
        W.ui.paint();
      }
    }
    await W.recFlush();
  }, [ticks, paintEvery]);
  const fingerprint = () => page.evaluate(() => {
    const W = window.__WSNF25, S = W.S;
    return JSON.stringify({ signals: window.__signals, log: S.log, snap: W.snapshot(), journal: S.journal, audit: S.audit, net: S.net, sigBy: Object.keys(S.sigBy), A: Object.keys(S.A).sort(), corr: S.corr, rec: W.REC.sess, series: W.REC.series });
  });
  return { page, ctx, errors, fingerprint };
}
const norm = t => t.replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, 'T').replace(/v\d\.\d( \(تطوير\))?/g, 'vX').replace(/\s+/g, ' ').trim();
async function pageTexts(s, wait) {
  const out = {};
  for (const p of PAGES) {
    await s.page.evaluate(p => { const sh = document.getElementById('wsnf25-host').shadowRoot; sh.querySelector('.splash').style.display = 'none'; sh.querySelector('#nav button[data-p="' + p + '"]').click(); }, p);
    await s.page.waitForTimeout(wait);
    out[p] = norm(await s.page.evaluate(p => { const sh = document.getElementById('wsnf25-host').shadowRoot; const pg = sh.querySelector('.page.on'), cl = pg.cloneNode(true); cl.querySelectorAll('[data-v4]').forEach(x => x.remove()); // البطاقات الجديدة في v4 تُستبعد: نقارن المحتوى القديم فقط
    document.body.appendChild(cl); cl.style.cssText = 'position:absolute;left:-99999px;width:1200px'; const txt = cl.innerText; cl.remove();
    return sh.getElementById('chips').innerText + ' || ' + txt; }, p));
  }
  return out;
}
async function stateHash(s) {
  return s.page.evaluate(() => { const W = window.__WSNF25; return JSON.stringify({ A: W.S.A, sigBy: W.S.sigBy, log: W.S.log, cfg: W.CFG, corr: W.S.corr, dq: W.S.dq }); });
}

(async () => {
  const browser = await chromium.launch();
  const fails = [], report = {};
  const check = (ok, what) => { if (!ok) fails.push(what); };
  const NEW = H.FILES.current, OLD = H.FILES.v35;

  // U1
  const a = await session(browser, NEW, { ui: false });
  const b = await session(browser, NEW, { ui: true, paintEvery: 400 });
  const fa = await a.fingerprint(), fb = await b.fingerprint();
  report.U1 = { signals: JSON.parse(fa).signals.length, identical: fa === fb };
  check(JSON.parse(fa).signals.length > 20, 'U1: سيناريو فقير');
  check(fa === fb, 'U1: نتائج المحرك تغيّرت بوجود الواجهة');
  check(!a.errors.length && !b.errors.length, 'U1: أخطاء JS ' + a.errors.concat(b.errors).join(' | '));
  await a.ctx.close();

  // U3 (قبل تغيير أي حالة في b): نص الصفحات v3.5 مقابل v3.6
  const o = await session(browser, OLD, { ui: true });
  check(await o.fingerprint() === fb, 'U3: v3.5 وv3.6 أنتجا نتائج مختلفة لنفس البيانات');
  const tNew = await pageTexts(b, 1200), tOld = await pageTexts(o, 1200);
  report.U3 = {};
  for (const p of PAGES) { report.U3[p] = tNew[p] === tOld[p] ? 'متطابق' : 'مختلف'; if (tNew[p] !== tOld[p]) { let i = 0; while (i < tNew[p].length && tNew[p][i] === tOld[p][i]) i++; fails.push('U3 ' + p + ' @' + i + ': [' + tOld[p].slice(Math.max(0, i - 60), i + 60) + '] ≠ [' + tNew[p].slice(Math.max(0, i - 60), i + 60) + ']'); } }

  // U2: تغيير الإطار (لا سجل إحصاء بعد للإطار الجديد) ثم رسم كل الصفحات عدة مرات
  report.U2 = {};
  for (const [name, s] of [['v3.6', b], ['v3.5', o]]) {
    await s.page.evaluate(() => window.__WSNF25.setTf(30));
    const h0 = await stateHash(s);
    await pageTexts(s, 1100);
    await pageTexts(s, 1100);
    const h1 = await stateHash(s);
    const keys = await s.page.evaluate(() => Object.keys(window.__WSNF25.S.A));
    report.U2[name] = { unchanged: h0 === h1, statsKeys: keys };
  }
  check(report.U2['v3.6'].unchanged, 'U2: الرسم غيّر حالة المحرك في v3.6');
  if (!report.U2['v3.5'].unchanged) report.U2.note = 'v3.5: مجرد عرض الصفحات أنشأ سجل إحصاء فارغًا (EURUSD_otc@30) — الخطأ الذي أصلحه فصل نموذج العرض';
  await browser.close();
  console.log(JSON.stringify(report, null, 1));
  console.log(fails.length ? 'UI/ENGINE BROWSER: FAIL\n- ' + fails.join('\n- ') : 'UI/ENGINE BROWSER: PASS');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
