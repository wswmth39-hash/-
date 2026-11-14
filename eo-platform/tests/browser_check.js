// Real-browser checks (Chromium via Playwright):
//  1. Dashboard: login, instant analysis, all views render, no console/CSP errors; desktop + mobile screenshots.
//  2. Bridge userscript on a MOCK ExpertOption page with a mocked WebSocket: ticks reach the server,
//     account-like messages are dropped, the script never sends on the platform socket.
// Usage: node tests/browser_check.js <server_url> <password> <bridge_token> <out_dir> <ws_port> <ws_log>
// (start tests/tools/mock_platform_ws.py <ws_port> <ws_log> first)
const {chromium, devices} = require('playwright');
const fs = require('fs');
const path = require('path');
const [, , SERVER, PASSWORD, TOKEN, OUT, WS_PORT, WS_LOG] = process.argv;
const MARKET = process.env.MARKET || 'BTCUSD';
const KIND = MARKET.endsWith('_OTC') ? 'otc' : 'regular';

(async () => {
  // LNA checks block a routed page from reaching the local mock WS; the real bridge never needs this
  // (it posts through Tampermonkey's GM_xmlhttpRequest from the extension context).
  const browser = await chromium.launch({args: ['--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks']});
  const errors = [];
  // ---------------- dashboard
  for (const [label, ctxOpt] of [['desktop', {viewport: {width: 1440, height: 1000}, deviceScaleFactor: 2}],
                                 ['mobile', {...devices['iPhone 13']}]]) {
    const ctx = await browser.newContext(ctxOpt);
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${label}: ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
    await page.goto(SERVER + '/login');
    await page.fill('#p', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL(SERVER + '/');
    await page.click(`#kind-seg button[data-kind=${KIND}]`);
    await page.selectOption('#market', MARKET);
    await page.click('#dur-seg button[data-d="60"]');
    await page.click('#analyze');
    await page.waitForSelector('#r-body dl');
    await page.waitForTimeout(4000);
    const decision = await page.textContent('#r-decision');
    await page.screenshot({path: path.join(OUT, `dashboard_${label}.png`), fullPage: label === 'desktop'});
    for (const v of ['auto', 'exec', 'signals', 'agents', 'perf', 'monitor', 'status', 'settings']) {
      await page.click(`#nav button[data-view=${v}]`);
      await page.waitForTimeout(1500);
      const txt = await page.textContent(`#v-${v}`);
      if (/undefined|NaN|\[object Object\]/.test(txt)) errors.push(`${label}/${v}: bad text rendered`);
      if (['auto', 'exec', 'agents', 'perf', 'status'].includes(v)) await page.screenshot({path: path.join(OUT, `view_${v}_${label}.png`), fullPage: label === 'desktop'});
    }
    // compare with the device viewport: a widened layout viewport also widens innerWidth
    const overflow = await page.evaluate((w) => document.documentElement.scrollWidth > w + 1 || window.innerWidth > w + 1, ctxOpt.viewport.width);
    if (overflow) errors.push(`${label}: horizontal page overflow`);
    console.log(`${label}: decision shown = ${decision.trim()}`);
    await ctx.close();
  }

  // ---------------- bridge userscript on a mock platform page (only when a mock WS port is given)
  if (!WS_PORT) { await browser.close(); console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'ALL BROWSER CHECKS PASSED (dashboard)'); process.exit(errors.length ? 1 : 0); }
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const posted = [];
  await page.exposeFunction('__gmPost', async (url, headers, data) => {
    const r = await fetch(url, {method: 'POST', headers, body: data});
    posted.push(JSON.parse(data));
    return r.status;
  });
  const shim = `
    window.GM_getValue = (k, d) => ({server: ${JSON.stringify(SERVER)}, token: ${JSON.stringify(TOKEN)}})[k] ?? d;
    window.GM_setValue = () => {}; window.GM_registerMenuCommand = () => {};
    window.unsafeWindow = window;
    window.GM_xmlhttpRequest = (o) => window.__gmPost(o.url, o.headers, o.data).then((s) => o.onload && o.onload({status: s}));
  `;
  const userscript = fs.readFileSync(path.join(__dirname, '..', 'bridge', 'expertoption-bridge.user.js'), 'utf8');
  await page.addInitScript(shim + '\n' + userscript);
  await page.route('http://localhost:8898/', (r) => r.fulfill({contentType: 'text/html', body:
    `<html><body>mock platform<script>const s=new WebSocket("ws://127.0.0.1:${WS_PORT}/");s.onopen=()=>s.send("client-hello")</script></body></html>`}));
  await page.goto('http://localhost:8898/');
  await page.waitForTimeout(5000);
  const badge = await page.textContent('#eo-bridge-badge');
  const sentToPlatform = fs.existsSync(WS_LOG) ? fs.readFileSync(WS_LOG, 'utf8').trim().split('\n') : [];
  const ticks = posted.flatMap((p) => p.assets.flatMap((a) => a.ticks));
  const leaked = JSON.stringify(posted).includes('999') || JSON.stringify(posted).includes('balance');
  console.log(`bridge: posts=${posted.length} ticks=${ticks.length} asset=${posted[0]?.assets[0]?.asset} otc=${posted[0]?.assets[0]?.otc}`);
  console.log(`bridge: messages sent to platform socket = ${JSON.stringify(sentToPlatform)} (only the page's own hello expected)`);
  console.log(`bridge: account message leaked = ${leaked}; badge = "${badge}"`);
  if (!ticks.length || leaked || sentToPlatform.length !== 1) errors.push('bridge check failed');
  await browser.close();
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'ALL BROWSER CHECKS PASSED');
  process.exit(errors.length ? 1 : 0);
})();
