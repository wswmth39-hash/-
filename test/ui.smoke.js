'use strict';
// اختبار دخان للواجهة في متصفح حقيقي (Chromium عبر Playwright): يحقن الـ Userscript في صفحة فارغة،
// يغذّيه بأسعار عبر WebSocket وهمي، ويتحقق من: عدم وجود أخطاء JS، ظهور وضع المحاكاة، عدم وجود أزرار تنفيذ،
// وأن أي زر CALL/PUT في الصفحة (منصة وهمية) لم يُنقر. الاستخدام: node test/ui.smoke.js [screenshot.png]
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const H = require('./harness');
(async () => {
  const file = H.target();
  const src = fs.readFileSync(file, 'utf8');
  const ticks = H.randomWalkTicks(3, 6 * 3600, { drift: 3e-6, t0: Math.floor(Date.now() / 1000) - 6 * 3600 });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  // صفحة على أصل حقيقي (http) حتى يعمل localStorage كما في المنصة
  await page.route('http://wsnf.test/**', r => r.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }));
  await page.goto('http://wsnf.test/');
  await page.setContent(`<html><body>
    <div class="current-symbol">EURUSD_otc</div>
    <a class="btn-call" id="pc">CALL</a><a class="btn-put" id="pp">PUT</a>
    <div class="block--bet-amount"><input value="1"></div></body></html>`);
  await page.evaluate(() => {
    window.__clicks = 0;
    document.getElementById('pc').addEventListener('click', () => window.__clicks++);
    document.getElementById('pp').addEventListener('click', () => window.__clicks++);
    class FakeWS extends EventTarget { constructor(u) { super(); this.url = u; window.__ws = this; } send() {} }
    window.WebSocket = FakeWS;
    window.__WSNF_TEST = true;
  });
  await page.addScriptTag({ content: src });
  await page.evaluate(async ticks => {
    const W = window.__WSNF25, ws = new window.WebSocket('wss://fake');
    ws.dispatchEvent(new Event('open'));
    W.handle('hist', { asset: 'EURUSD_otc', history: ticks.slice(0, 18000) });
    W.CFG.auto = true; W.CFG.gate = false;
    for (const [ts, px] of ticks.slice(18000)) {
      const m = new MessageEvent('message', { data: '42["updateStream",[["EURUSD_otc",' + ts + ',' + px + ']]]' });
      ws.dispatchEvent(m);
    }
  }, ticks);
  await page.waitForTimeout(1600);
  // إعادة تحميل: الإحصاءات الحية تبقى، والدخول الآلي الافتراضي يعود متوقفًا
  const persisted = await page.evaluate(() => { window.__WSNF25.saveAll(); return { n: window.__WSNF25.getA('EURUSD_otc').e.ln, keys: Object.keys(localStorage).filter(k => k.startsWith('wsnf33s_')).length }; });
  const host = await page.evaluateHandle(() => document.getElementById('wsnf25-host').shadowRoot);
  const info = await page.evaluate(sh => ({
    chips: sh.getElementById('chips').textContent,
    brand: sh.querySelector('.brand small').textContent,
    hasExec: !!(sh.getElementById('bCall') || sh.getElementById('bPut') || sh.getElementById('exAuto') || sh.getElementById('modal')),
    auto: sh.getElementById('auto').textContent,
    stats: sh.getElementById('stats').textContent,
    logRows: sh.getElementById('log').children.length,
    clicks: window.__clicks,
    signals: window.__WSNF25.S.log.length,
    paper: window.__WSNF25.S.log.filter(e => e.auto).length
  }), host);
  info.persisted = persisted;

  const out = process.argv[2];
  if (out) {
    await page.evaluate(sh => sh.querySelector('.splash') && (sh.querySelector('.splash').style.display = 'none'), host);
    await page.screenshot({ path: out, fullPage: false });
  }
  await page.reload();
  await page.evaluate(() => { window.WebSocket = class extends EventTarget {}; window.__WSNF_TEST = true; });
  await page.addScriptTag({ content: src });
  info.afterReload = await page.evaluate(() => ({ n: window.__WSNF25.getA('EURUSD_otc').e.ln, auto: window.__WSNF25.CFG.auto, storeErr: window.__WSNF25.S.storeErr }));
  await browser.close();
  console.log(JSON.stringify(info, null, 1));
  const fails = [];
  if (errors.length) fails.push('JS errors: ' + errors.slice(0, 5).join(' | '));
  if (!/محاكاة فقط/.test(info.chips + info.brand)) fails.push('لا يظهر وضع المحاكاة');
  if (info.hasExec) fails.push('عناصر تنفيذ حقيقي ما زالت في الواجهة');
  if (info.clicks) fails.push('نقرات على أزرار المنصة: ' + info.clicks);
  if (!info.signals) fails.push('لا إشارات');
  if (/تعذّر الحفظ/.test(info.chips)) fails.push('تعذّر الحفظ في المتصفح');
  if (!(info.persisted.keys > 0) || info.afterReload.n !== info.persisted.n) fails.push('الإحصاءات لم تبقَ بعد إعادة التحميل');
  if (info.afterReload.auto !== false) fails.push('الدخول الآلي عاد بعد إعادة التحميل');
  console.log(fails.length ? 'UI SMOKE: FAIL\n- ' + fails.join('\n- ') : 'UI SMOKE: PASS');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
