'use strict';
// اختبار الواجهة الجديدة (V1.0) في Chromium حقيقي: كمبيوتر وجوال، العربية والإنجليزية، كل الصفحات وكل عناصر التحكم.
// البيانات هنا حركة عشوائية مولّدة للاختبار فقط (ليست بيانات سوق) تُحقن عبر WebSocket وهمي في صفحة اختبار.
// الاستخدام: node test/shell.browser.js [desktop.png] [mobile.png]
const { chromium } = require('playwright');
const fs = require('fs');
const H = require('./harness');
(async () => {
  const src = fs.readFileSync(H.target(), 'utf8');
  const ticks = H.randomWalkTicks(7, 5 * 3600, { drift: 3e-6, t0: Math.floor(Date.now() / 1000) - 5 * 3600 });
  const browser = await chromium.launch();
  const fails = [], R = {};
  const check = (ok, msg) => { if (!ok) fails.push(msg); };

  async function open(viewport) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.route('http://wsnf.test/**', r => r.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }));
    await page.goto('http://wsnf.test/');
    await page.setContent('<html><body><div class="current-symbol">EURUSD_otc</div><a class="btn-call" id="pc">CALL</a><a class="btn-put" id="pp">PUT</a></body></html>');
    await page.evaluate(() => {
      window.__clicks = 0; window.__sent = 0;
      document.getElementById('pc').addEventListener('click', () => window.__clicks++);
      document.getElementById('pp').addEventListener('click', () => window.__clicks++);
      class FakeWS extends EventTarget { constructor(u) { super(); this.url = u; } send() { window.__sent++; } }
      window.WebSocket = FakeWS;
      window.__WSNF_TEST = true;
    });
    await page.addScriptTag({ content: src });
    return { page, errors };
  }
  const feed = (page, from, to, asset) => page.evaluate(([tk, asset]) => {
    const W = window.__WSNF25;
    if (!window.__ws) { window.__ws = new window.WebSocket('wss://fake'); window.__ws.dispatchEvent(new Event('open')); }
    for (const [ts, px] of tk) window.__ws.dispatchEvent(new MessageEvent('message', { data: '42["updateStream",[["' + asset + '",' + ts + ',' + px + ']]]' }));
    W.feedCheck(); W.shell.paint();
  }, [ticks.slice(from, to), asset]);
  const sh = page => page.evaluateHandle(() => document.getElementById('posb-host').shadowRoot);
  const pageText = (page, p) => page.evaluate(p => { const W = window.__WSNF25; W.shell.go(p); W.shell.paint(); const s = document.getElementById('posb-host').shadowRoot; return s.querySelector('.page.on').innerText + ' || ' + s.querySelector('.top').innerText + ' || ' + s.getElementById('nav').innerText; }, p);

  // ===== كمبيوتر =====
  const d = await open({ width: 1366, height: 860 });
  // 1) قبل وصول أي بيانات: لا أرقام مختلقة
  R.empty = await pageText(d.page, 'dash');
  check(/غير متصل|جارٍ الاتصال|بانتظار البيانات/.test(R.empty), 'بلا بيانات: حالة الاتصال لا تقول غير متصل/بانتظار');
  check(/WAIT/.test(R.empty), 'بلا بيانات: التوقيت ليس WAIT');
  check(!/CALL \d|PUT \d/.test(R.empty), 'بلا بيانات: ظهرت إشارة');
  R.emptyHist = await pageText(d.page, 'history');
  check(/لا نتائج مسجّلة بعد/.test(R.emptyHist), 'بلا بيانات: السجل لا يقول لا نتائج');

  // 2) بيانات: تاريخ + بث
  await d.page.evaluate(tk => { const W = window.__WSNF25; window.__ws = new window.WebSocket('wss://fake'); window.__ws.dispatchEvent(new Event('open')); W.handle('hist', { asset: 'EURUSD_otc', history: tk }); }, ticks.slice(0, 12000));
  await feed(d.page, 12000, 17990, 'EURUSD_otc');
  const st = await d.page.evaluate(() => { const W = window.__WSNF25, D = W.app.vm.dash(); return { D, log: W.S.log.length, lifeN: Object.values(W.S.A).reduce((a, x) => a + x.e.ln, 0), lifeW: Object.values(W.S.A).reduce((a, x) => a + x.e.lw, 0) }; });
  R.dash = { feed: st.D.feed.status, timing: st.D.timing, analysis: st.D.analysis, candles: st.D.candles, log: st.log, total: st.D.stats.total, assets: st.D.assets.length };
  check(st.D.candles >= 60, 'شموع غير كافية: ' + st.D.candles);
  check(st.log > 0, 'لا إشارات مسجّلة من المحرك');
  // الإحصاءات المعروضة = دفاتر المحرك بالضبط
  check(st.D.stats.total.n === st.lifeN && st.D.stats.total.w === st.lifeW, 'إجمالي الإحصاءات لا يطابق دفاتر المحرك');
  check(st.D.stats.byAsset.reduce((a, x) => a + x.n, 0) === st.lifeN, 'مجموع «لكل أصل» لا يطابق الإجمالي');
  check(st.D.stats.byTf.reduce((a, x) => a + x.n, 0) === st.lifeN, 'مجموع «لكل إطار» لا يطابق الإجمالي');
  check(st.D.signal && Array.isArray(st.D.signal.pro) && Array.isArray(st.D.signal.con), 'لا قوائم مؤيد/معارض');

  // 3) كل الصفحات باللغتين: لا undefined/NaN/[object ولا مفتاح ترجمة خام
  const bad = /undefined|NaN|\[object|\b(nav|fs|tm|tc|an|st|ty|adv)_[a-z0-9_]+\b|\b[dmsharn]_[a-z0-9_]+\b/;
  R.pages = {};
  for (const lang of ['ar', 'en']) {
    await d.page.evaluate(lang => { const s = document.getElementById('posb-host').shadowRoot, W = window.__WSNF25; if (W.shell.prefs().lang !== lang) s.getElementById('lang').click(); }, lang);
    for (const p of ['dash', 'market', 'signals', 'history', 'alerts', 'settings', 'adv']) {
      const txt = await pageText(d.page, p), m = bad.exec(txt);
      R.pages[lang + ':' + p] = txt.length;
      check(!m, lang + '/' + p + ': نص معيب «' + (m && txt.slice(Math.max(0, m.index - 30), m.index + 30)) + '»');
      check(txt.length > 60, lang + '/' + p + ': صفحة شبه فارغة');
    }
    const dir = await d.page.evaluate(() => document.getElementById('posb-host').shadowRoot.getElementById('app').dir);
    check(dir === (lang === 'ar' ? 'rtl' : 'ltr'), lang + ': الاتجاه ' + dir);
  }
  const enDash = await pageText(d.page, 'dash');
  check(/Dashboard/.test(enDash) && /Data source connection/.test(enDash) && !/لوحة التحكم/.test(enDash), 'الإنجليزية: نص اللوحة لم يُترجم');
  if (process.argv[2]) { await d.page.evaluate(() => window.__WSNF25.shell.go('signals')); await d.page.waitForTimeout(5600); await d.page.screenshot({ path: process.argv[2].replace(/\.png$/, '_en_signals.png') }); }
  await d.page.evaluate(() => document.getElementById('posb-host').shadowRoot.getElementById('lang').click()); // رجوع للعربية
  const sig = await pageText(d.page, 'signals');
  check(/المؤشرات المؤيدة/.test(sig) && /المؤشرات المعارضة/.test(sig) && /سبب القرار/.test(sig) && /جودة البيانات/.test(sig) && /حالة التوقيت/.test(sig), 'بطاقة الإشارة ناقصة الحقول');
  check(/لا تُعرض نسبة نجاح/.test(sig), 'بطاقة الإشارة لا تميّز القوة عن الاحتمال');
  check(!/ربح مضمون|نسبة نجاح \d/.test(sig + enDash), 'ادعاء نسبة نجاح');

  // 6) السوق: تثبيت أصل من الجدول، والشارت مرسوم
  await d.page.evaluate(() => window.__WSNF25.shell.go('market'));
  await d.page.waitForTimeout(700);
  R.market = await d.page.evaluate(() => {
    const W = window.__WSNF25, s = document.getElementById('posb-host').shadowRoot, cv = s.getElementById('cv'), o = {};
    const px = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 3; i < px.length; i += 4) if (px[i]) n++;
    o.drawn = n; o.rows = s.querySelectorAll('#mTbl tbody tr').length;
    const b = s.querySelector('#mTbl button[data-lock="EURUSD_otc"]'); if (b) b.click(); o.locked = W.S.lock;
    const u = s.querySelector('#mTbl button[data-unlock]'); if (u) u.click(); o.unlocked = W.S.lock;
    cv.dispatchEvent(new PointerEvent('pointermove', { clientX: cv.getBoundingClientRect().left + 50, clientY: 50, bubbles: true })); o.ohlc = s.getElementById('ohlc').textContent;
    return o;
  });
  check(R.market.drawn > 2000, 'الشارت غير مرسوم');
  check(R.market.rows >= 1, 'جدول الأصول: ' + R.market.rows);
  check(R.market.locked === 'EURUSD_otc' && R.market.unlocked === null, 'تثبيت الأصل من جدول السوق لا يعمل');
  check(/O |فتح /.test(R.market.ohlc), 'قراءة الشمعة عند المؤشر لا تظهر');

  // 4) عناصر الإعدادات تنفّذ أوامر حقيقية
  await d.page.evaluate(() => window.__WSNF25.shell.go('settings'));
  R.settings = await d.page.evaluate(async () => {
    const W = window.__WSNF25, s = document.getElementById('posb-host').shadowRoot, $ = id => s.getElementById(id), o = {};
    const r = $('sMin'); r.value = '72'; r.dispatchEvent(new Event('input')); o.minConf = W.CFG.minConf;
    $('sMode').querySelector('[data-v="manual"]').click(); o.lockManual = W.S.lock;
    $('sMode').querySelector('[data-v="follow"]').click(); o.lockFollow = W.S.lock;
    $('sCompact').click(); o.compact = $('app').classList.contains('compact') && W.shell.prefs().compact;
    $('sSound').click(); o.sound = W.shell.prefs().sound; $('sSound').click();
    $('sTy-asset').click(); o.typeOff = W.shell.prefs().types.asset === false;
    const tf = $('sTf'); tf.value = '30'; tf.dispatchEvent(new Event('change')); o.tf = W.CFG.tf;
    tf.value = '60'; tf.dispatchEvent(new Event('change')); o.tfBack = W.CFG.tf;
    o.saved = JSON.parse(localStorage.getItem('posb_ui'));
    return o;
  });
  check(R.settings.minConf === 72, 'الحد الأدنى للقوة لم يصل للمحرك');
  check(R.settings.lockManual === 'EURUSD_otc' && R.settings.lockFollow === null, 'وضع يدوي/متابعة لا يغيّر التثبيت');
  check(R.settings.compact === true && R.settings.typeOff === true && R.settings.sound === true, 'تفضيلات الواجهة/التنبيهات لا تعمل');
  check(R.settings.tf === 30 && R.settings.tfBack === 60, 'تغيير مدة الشمعة لم يصل للمحرك');
  check(R.settings.saved && R.settings.saved.compact === true && !('password' in R.settings.saved), 'التفضيلات لم تُحفظ');

  // 5) التنبيهات: تغيّر الأصل معطّل الآن (عطّلناه أعلاه)، وإشارة جديدة وحالة البيانات تظهران
  await d.page.evaluate(() => { const s = document.getElementById('posb-host').shadowRoot; s.getElementById('sTy-asset').click(); s.getElementById('sCompact').click(); });
  await feed(d.page, 17990, 17999, 'GBPUSD_otc');
  await feed(d.page, 17999, 18000, 'EURUSD_otc');
  await d.page.evaluate(() => window.__WSNF25.E.emit('signal', { asset: 'EURUSD_otc', dir: 'call', conf: 70 })); // حدث واجهة فقط: لا يدخل السجل ولا الإحصاءات
  R.alerts = await d.page.evaluate(() => { const W = window.__WSNF25, s = document.getElementById('posb-host').shadowRoot; return { list: W.shell.alerts().map(a => a.type + ':' + a.text), toasts: s.getElementById('toasts').children.length, badge: s.querySelector('#nav .cnt').textContent, logAfter: W.S.log.length }; });
  check(R.alerts.list.some(x => /^asset:/.test(x) && /GBPUSD_otc/.test(x)), 'لا تنبيه لتغيّر الأصل');
  check(R.alerts.list.some(x => /^signal:/.test(x)), 'لا تنبيه للإشارة');
  check(R.alerts.list.some(x => /^conn:/.test(x)), 'لا تنبيه لحالة البيانات');
  check(R.alerts.toasts > 0 && +R.alerts.badge > 0, 'لا إشعار منبثق أو لا عدّاد');
  check(R.alerts.logAfter === st.log || R.alerts.logAfter >= st.log, 'السجل تغيّر بحدث واجهة');
  const al = await pageText(d.page, 'alerts');
  check(/مركز التنبيهات/.test(al) && /GBPUSD_otc/.test(al), 'مركز التنبيهات لا يعرض القائمة');
  await d.page.evaluate(() => document.getElementById('posb-host').shadowRoot.getElementById('aClr').click());
  check((await d.page.evaluate(() => window.__WSNF25.shell.alerts().length)) === 0, 'زر مسح التنبيهات لا يعمل');

  // 7) متقدم: فتح الصفحات القديمة والرجوع؛ عناصر الصفقات الافتراضية مخفية
  await d.page.evaluate(() => { const W = window.__WSNF25; W.shell.go('adv'); document.getElementById('posb-host').shadowRoot.getElementById('advOpen').click(); });
  R.adv = await d.page.evaluate(() => {
    const L = document.getElementById('wsnf25-host'), N = document.getElementById('posb-host'), s = L.shadowRoot, vis = id => getComputedStyle(s.getElementById(id)).display !== 'none', o = {};
    o.legacyShown = L.style.display !== 'none' && N.style.display === 'none';
    o.simHidden = !vis('simCard') && !vis('auto') && !vis('kill'); o.navShown = vis('nav'); o.back = s.getElementById('min').textContent;
    s.getElementById('min').click();
    o.backWorks = L.style.display === 'none' && N.style.display !== 'none';
    return o;
  });
  check(R.adv.legacyShown && R.adv.navShown, 'الأدوات المتقدمة لم تُفتح');
  check(R.adv.simHidden, 'عناصر الصفقات الافتراضية ظاهرة');
  check(R.adv.backWorks && /رجوع/.test(R.adv.back), 'زر الرجوع لا يعمل');

  // 8) تصغير وإعادة
  R.min = await d.page.evaluate(() => { const s = document.getElementById('posb-host').shadowRoot, o = {}; s.getElementById('min').click(); o.hidden = s.getElementById('app').classList.contains('hide') && s.getElementById('pill').classList.contains('show'); o.pill = s.getElementById('pillT').textContent; window.__WSNF25.shell.setMin(false); o.back = !s.getElementById('app').classList.contains('hide'); return o; });
  check(R.min.hidden && R.min.back && /EURUSD_otc|GBPUSD_otc/.test(R.min.pill), 'التصغير/الإعادة لا يعملان');

  // 9) انقطاع البيانات يظهر في الواجهة ويوقف «مناسبة»
  await d.page.evaluate(() => { window.__ws.dispatchEvent(new Event('close')); });
  await d.page.waitForTimeout(3600);
  R.down = await d.page.evaluate(() => { const W = window.__WSNF25; W.feedCheck(); const D = W.shell.paint(); return { feed: D.feed.status, timing: D.timing.state, chip: document.getElementById('posb-host').shadowRoot.getElementById('cFeed').textContent }; });
  check(R.down.feed === 'disconnected' && R.down.timing === 'wait' && /غير متصل/.test(R.down.chip), 'الانقطاع: ' + JSON.stringify(R.down));

  // 10) السلامة
  R.safety = await d.page.evaluate(() => ({ clicks: window.__clicks, sent: window.__sent }));
  check(R.safety.clicks === 0, 'نقرات على أزرار المنصة: ' + R.safety.clicks);
  check(R.safety.sent === 0, 'البوت أرسل عبر WebSocket: ' + R.safety.sent);
  check(!d.errors.length, 'أخطاء JS (كمبيوتر): ' + d.errors.slice(0, 4).join(' | '));
  if (process.argv[2]) { await d.page.evaluate(() => window.__WSNF25.shell.go('dash')); await d.page.waitForTimeout(5600); await d.page.screenshot({ path: process.argv[2] }); await d.page.evaluate(() => window.__WSNF25.shell.go('history')); await d.page.waitForTimeout(500); await d.page.screenshot({ path: process.argv[2].replace(/\.png$/, '_history.png') }); }

  // ===== جوال =====
  const m = await open({ width: 390, height: 780 });
  await m.page.evaluate(tk => { const W = window.__WSNF25; window.__ws = new window.WebSocket('wss://fake'); window.__ws.dispatchEvent(new Event('open')); W.handle('hist', { asset: 'EURUSD_otc', history: tk }); }, ticks.slice(0, 12000));
  await feed(m.page, 12000, 18000, 'EURUSD_otc');
  R.mobile = {};
  for (const p of ['dash', 'market', 'signals', 'history', 'settings']) {
    await pageText(m.page, p);
    await m.page.waitForTimeout(p === 'market' ? 600 : 50);
    R.mobile[p] = await m.page.evaluate(() => { const s = document.getElementById('posb-host').shadowRoot, b = s.getElementById('body'), n = s.getElementById('nav').getBoundingClientRect(); return { overflowX: b.scrollWidth - b.clientWidth, navBottom: Math.round(innerHeight - n.bottom), navW: Math.round(n.width) }; });
    check(R.mobile[p].overflowX <= 1, 'جوال/' + p + ': تمرير أفقي للصفحة ' + R.mobile[p].overflowX + 'px');
    check(R.mobile[p].navBottom <= 1 && R.mobile[p].navW >= 380, 'جوال/' + p + ': شريط التنقل ليس أسفل الشاشة');
  }
  check(!m.errors.length, 'أخطاء JS (جوال): ' + m.errors.slice(0, 4).join(' | '));
  if (process.argv[3]) { await m.page.evaluate(() => window.__WSNF25.shell.go('dash')); await m.page.waitForTimeout(5600); await m.page.screenshot({ path: process.argv[3] }); }

  await browser.close();
  console.log(JSON.stringify(R, null, 1));
  console.log(fails.length ? 'SHELL BROWSER: FAIL\n- ' + fails.join('\n- ') : 'SHELL BROWSER: PASS');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
