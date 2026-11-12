'use strict';
// الواجهة الجديدة (POCKET OPTION SMART BOT V1.0) — عرض فقط.
// - لا تحسب أي مؤشر أو إحصاء: تقرأ app.vm.dash() و app.vm.chart() (نسخ جاهزة) وتنفّذ أوامر app.cmd الصريحة فقط.
// - لا يوجد فيها أي زر أو كود تنفيذ على المنصة، ولا أي عنصر شكلي: كل عنصر تحكم مربوط بأمر حقيقي أو بتفضيل عرض محفوظ.
// - ما لم يُبنَ بعد (الاختيار التلقائي للأصل، أوزان التقييم، الأطر M5–H1) يُذكر نصًا مع مرحلته، بلا أزرار.
// - صفحات الإصدار السابق تبقى كما هي تحت «متقدم» (ui/ui.js بوضع embedded).
const { t: tr, LANGS } = require('./i18n');
const PREF_KEY = 'posb_ui';
const NAME = 'POCKET OPTION SMART BOT';
const ESC = s => String(s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const PAGES = ['dash', 'market', 'signals', 'history', 'alerts', 'settings', 'adv'];
const TYPES = ['signal', 'conn', 'asset', 'quality', 'timing', 'trend', 'conflict'];
const RG_KEY = { 'اتجاهي': 'rg_trend', 'عرضي': 'rg_range', 'مختلط': 'rg_mixed', 'متقلب': 'rg_volatile' };
const IND_EN = { trend: 'EMA trend', rsi: 'RSI', boll: 'Bollinger', macd: 'MACD', stoch: 'Stochastic', candles: 'Candle patterns', sr: 'Support/Resistance', break: 'Breakout',
  ha: 'Heikin-Ashi', cci: 'CCI', willr: 'Williams %R', mom: 'Momentum', lin: 'Linear regression', streak: 'Streak exhaustion', pin: 'Rejection candle', squeeze: 'Squeeze breakout', kelt: 'Keltner' };
const FEED_LVL = { live: 'ok', delayed: 'warn', connected: 'warn', connecting: 'warn', stale: 'bad', unavailable: 'bad', disconnected: 'bad', error: 'bad' };
const TM_LVL = { wait: 'warn', analyzing: 'info', favorable: 'ok', no_trade: 'mute' };
const ICON = {
  dash: 'M3 3h8v10H3zM13 3h8v6h-8zM13 11h8v10h-8zM3 15h8v6H3z', market: 'M3 20h18M6 16V9M6 7V4M11 18v-6M11 10V6M16 14V8M16 6V3M20 17v-5',
  signals: 'M12 3v4M12 17v4M3 12h4M17 12h4M12 9a3 3 0 100 6 3 3 0 000-6z', history: 'M4 5h16M4 10h16M4 15h10M4 20h7',
  alerts: 'M6 16V11a6 6 0 1112 0v5l2 2H4zM10 21h4', settings: 'M4 7h10M18 7h2M4 17h2M10 17h10M16 4v6M8 14v6', adv: 'M5 12h.01M12 12h.01M19 12h.01'
};
const svg = k => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICON[k]}"/></svg>`;

const CSS = `
:host{all:initial}
*{box-sizing:border-box;margin:0;padding:0}
.app,.toasts{--bg:#0a0a0f;--p1:#13131b;--p2:#1b1b26;--line:#2a2a3a;--tx:#ececf4;--mu:#8e8ea6;--pu:#8b5cf6;--cy:#22d3ee;--ok:#34d399;--bad:#f87171;--warn:#fbbf24;--gap:14px;--fs:13px}
.app{position:fixed;inset:0;z-index:2147483646;display:grid;grid-template-columns:216px 1fr;background:var(--bg);color:var(--tx);font:var(--fs)/1.55 "Segoe UI",Tahoma,system-ui,sans-serif}
.app.compact{--gap:9px;--fs:12px}
.app.hide{display:none}
.app.motion .page{animation:in .22s ease both}
.app.motion button,.app.motion .nav a,.app.motion .sw i,.app.motion .bar i{transition:background .15s,color .15s,border-color .15s,transform .15s,width .3s}
@keyframes in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@media(prefers-reduced-motion:reduce){.app .page{animation:none!important}.app *{transition:none!important}}
button{font:inherit;color:inherit;cursor:pointer;background:var(--p2);border:1px solid var(--line);border-radius:8px;padding:6px 12px}
button:hover{border-color:var(--pu)}
button:focus-visible,a:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid var(--cy);outline-offset:2px}
select,input[type=number]{font:inherit;color:var(--tx);background:var(--p2);border:1px solid var(--line);border-radius:8px;padding:6px 10px}
input[type=range]{accent-color:var(--pu);width:100%}
.side{background:var(--p1);border-inline-end:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
.brand{padding:18px 16px 14px;border-bottom:1px solid var(--line)}
.brand b{display:block;font-size:13px;letter-spacing:.6px;line-height:1.3;background:linear-gradient(90deg,var(--pu),var(--cy));-webkit-background-clip:text;background-clip:text;color:transparent;direction:ltr;text-align:start}
.brand small{display:block;color:var(--mu);font-size:11px;margin-top:4px}
.nav{display:flex;flex-direction:column;gap:2px;padding:10px 8px;flex:1;overflow:auto}
.nav a{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:8px;color:var(--mu);cursor:pointer;text-decoration:none;border:1px solid transparent;position:relative}
.nav a:hover{color:var(--tx);background:var(--p2)}
.nav a.on{color:var(--tx);background:linear-gradient(90deg,#8b5cf622,#22d3ee11);border-color:#8b5cf655}
.nav .cnt{margin-inline-start:auto;background:var(--pu);color:#fff;border-radius:99px;font-size:10px;padding:0 6px;min-width:18px;text-align:center}
.nav .cnt:empty{display:none}
.foot{padding:10px 14px;border-top:1px solid var(--line);color:var(--mu);font-size:10.5px;line-height:1.5}
.main{display:flex;flex-direction:column;min-width:0;min-height:0}
.top{display:flex;align-items:center;gap:10px;padding:12px 18px;border-bottom:1px solid var(--line);background:var(--p1)}
.top h1{font-size:16px;font-weight:600;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:99px;padding:3px 10px;font-size:11.5px;white-space:nowrap;background:var(--p2)}
.chip::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--mu)}
.chip.ok::before{background:var(--ok)}.chip.warn::before{background:var(--warn)}.chip.bad::before{background:var(--bad)}.chip.info::before{background:var(--cy)}
.chip.ok{border-color:#34d39955}.chip.bad{border-color:#f8717155}.chip.warn{border-color:#fbbf2455}.chip.info{border-color:#22d3ee55}
.body{flex:1;overflow:auto;padding:var(--gap) 18px 28px}
.page{display:none}.page.on{display:block}
.grid{display:grid;gap:var(--gap);grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
.cols{display:grid;gap:var(--gap);grid-template-columns:minmax(0,3fr) minmax(0,2fr);margin-top:var(--gap)}
.card{background:var(--p1);border:1px solid var(--line);border-radius:12px;padding:calc(var(--gap) + 1px);min-width:0}
.card h3{font-size:12px;font-weight:600;color:var(--mu);margin-bottom:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.kv b{display:block;font-size:19px;font-weight:600;line-height:1.3;overflow-wrap:anywhere}
.kv small,.note{color:var(--mu);font-size:11.5px;display:block;margin-top:3px}
.ok-t{color:var(--ok)}.bad-t{color:var(--bad)}.warn-t{color:var(--warn)}.cy-t{color:var(--cy)}.pu-t{color:var(--pu)}.mu-t{color:var(--mu)}
.bar{height:6px;border-radius:99px;background:var(--p2);overflow:hidden;margin-top:8px}
.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--pu),var(--cy));border-radius:99px}
.scroll{overflow:auto;max-height:440px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{color:var(--mu);font-weight:500;text-align:start;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap;position:sticky;top:0;background:var(--p1)}
td{padding:6px 8px;border-bottom:1px solid #2a2a3a66;vertical-align:top}
td.num,th.num{font-variant-numeric:tabular-nums;white-space:nowrap}
.tags{display:flex;flex-wrap:wrap;gap:6px}
.tag{border-radius:6px;padding:2px 8px;font-size:11.5px;border:1px solid var(--line);background:var(--p2)}
.tag.pro{border-color:#34d39955;color:var(--ok)}.tag.con{border-color:#f8717155;color:var(--bad)}
.sig{border-inline-start:3px solid var(--line)}.sig.call{border-inline-start-color:var(--ok)}.sig.put{border-inline-start-color:var(--bad)}
.sig .big{font-size:26px;font-weight:700;letter-spacing:.5px}
.dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin-top:10px}
.dl dt{color:var(--mu);white-space:nowrap}.dl dd{min-width:0;overflow-wrap:anywhere}
canvas{width:100%;height:340px;display:block;border-radius:8px;background:var(--bg)}
.row{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid #2a2a3a66;flex-wrap:wrap}
.row:last-child{border-bottom:0}
.row .lbl{flex:1;min-width:180px}.row .lbl b{font-weight:600;display:block}
.row .ctl{display:flex;align-items:center;gap:8px;min-width:150px}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.seg button{border:0;border-radius:0;background:transparent;color:var(--mu)}
.seg button.on{background:var(--pu);color:#fff}
.sw{width:40px;height:22px;border-radius:99px;background:var(--p2);border:1px solid var(--line);position:relative;padding:0;flex:none}
.sw i{position:absolute;top:2px;inset-inline-start:2px;width:16px;height:16px;border-radius:50%;background:var(--mu)}
.sw.on{background:#8b5cf644;border-color:var(--pu)}.sw.on i{background:var(--pu);inset-inline-start:20px}
.toasts{position:fixed;bottom:16px;inset-inline-end:16px;z-index:2147483647;display:flex;flex-direction:column;gap:8px;width:min(340px,calc(100vw - 28px));pointer-events:none}
.toast{background:var(--p2);border:1px solid var(--line);border-inline-start:3px solid var(--cy);border-radius:10px;padding:10px 12px;box-shadow:0 8px 24px #0008;font-size:12.5px;color:var(--tx);font-family:"Segoe UI",Tahoma,system-ui,sans-serif}
.toast.ok{border-inline-start-color:var(--ok)}.toast.bad{border-inline-start-color:var(--bad)}.toast.warn{border-inline-start-color:var(--warn)}
.al{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid #2a2a3a66}
.al time{color:var(--mu);font-size:11px;white-space:nowrap;font-variant-numeric:tabular-nums}
.pill{position:fixed;z-index:2147483647;display:none;align-items:center;gap:8px;background:#13131bee;border:1px solid #8b5cf688;border-radius:99px;padding:7px 14px;color:#ececf4;font:12px "Segoe UI",Tahoma,sans-serif;cursor:grab;user-select:none;touch-action:none;box-shadow:0 6px 20px #0009}
.pill.show{display:flex}
.pill i{width:8px;height:8px;border-radius:50%;background:#8e8ea6}.pill.ok i{background:#34d399}.pill.warn i{background:#fbbf24}.pill.bad i{background:#f87171}
.empty{color:var(--mu);padding:18px 0;text-align:center}
@media(max-width:820px){
  .app{grid-template-columns:1fr;grid-template-rows:1fr auto}
  .side{order:2;border-inline-end:0;border-top:1px solid var(--line)}
  .brand,.foot{display:none}
  .nav{flex-direction:row;padding:4px;gap:0;overflow-x:auto}
  .nav a{flex:1;flex-direction:column;gap:2px;font-size:10px;padding:6px 2px;min-width:48px;text-align:center}
  .nav .cnt{position:absolute;top:2px;inset-inline-end:8px;margin:0}
  .top{padding:10px 12px;flex-wrap:wrap}.top h1{font-size:14px;flex-basis:100%}
  .body{padding:10px 10px 20px}
  .cols{grid-template-columns:1fr}
  .grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}
  canvas{height:240px}
  .toasts{bottom:72px;inset-inline-end:10px}
  .kv b{font-size:16px}
}`;

// app: نفس العقد الذي تراه الواجهة القديمة + app.vm.dash. opts: { openLegacy(), closeLegacy() }
function buildShell(app, opts) {
  const doc = app.doc, win = app.win;
  if (doc.getElementById('posb-host')) return null;
  const host = doc.createElement('div');
  host.id = 'posb-host';
  doc.documentElement.appendChild(host);
  const sh = host.attachShadow({ mode: 'open' });
  const saved = app.prefs.get(PREF_KEY, null) || {};
  const P = { lang: 'ar', min: false, x: 14, y: 90, sound: false, toasts: true, compact: false, motion: true, page: 'dash', ...saved, types: { ...Object.fromEntries(TYPES.map(k => [k, true])), ...(saved.types || {}) } };
  if (!LANGS.includes(P.lang)) P.lang = 'ar';
  if (!PAGES.includes(P.page) || P.page === 'adv') P.page = 'dash';
  const save = () => app.prefs.set(PREF_KEY, P);
  const T = (k, v) => tr(P.lang, k, v);
  const $ = id => sh.getElementById(id);
  const cmd = app.cmd;

  sh.innerHTML = '<style>' + CSS + '</style>' +
    '<div class="app" id="app"><aside class="side"><div class="brand"><b>' + NAME + '</b><small id="bsub"></small></div><nav class="nav" id="nav"></nav><div class="foot" id="foot"></div></aside>' +
    '<div class="main"><div class="top"><h1 id="title"></h1><span class="chip" id="cFeed"></span><span class="chip" id="cTm"></span><button id="lang"></button><button id="min"></button></div>' +
    '<div class="body" id="body">' + PAGES.map(p => '<section class="page" data-page="' + p + '" id="pg-' + p + '"></section>').join('') + '</div></div></div>' +
    '<div class="toasts" id="toasts" aria-live="polite"></div><div class="pill" id="pill"><i></i><span id="pillT"></span></div>';
  const root = $('app'), pill = $('pill');

  // ---------- تنسيق ----------
  const tm = ms => ms ? new Date(ms).toLocaleTimeString('en-GB', { hour12: false }) : T('na');
  const ago = ms => ms === null || ms === undefined ? T('na') : ms < 1500 ? T('now') : ms < 9e4 ? T('ago_s', { n: Math.round(ms / 1000) }) : T('ago_m', { n: Math.round(ms / 6e4) });
  const tfL = s => s % 3600 === 0 ? 'H' + s / 3600 : s % 60 === 0 ? 'M' + s / 60 : 'S' + s;
  const pct = x => x === null || x === undefined ? T('na') : (x * 100).toFixed(1) + '%';
  const px = v => v === null || v === undefined ? T('na') : String(v);
  const rgL = r => RG_KEY[r] ? T(RG_KEY[r]) : (r && r !== '-' ? ESC(r) : T('flat'));
  const indL = x => ESC(P.lang === 'en' && IND_EN[x.k] ? IND_EN[x.k] : x.name);
  const dirL = d => d === 'call' ? '▲ CALL' : d === 'put' ? '▼ PUT' : '—';
  const dirC = d => d === 'call' ? 'ok-t' : d === 'put' ? 'bad-t' : 'mu-t';
  const tmWhy = x => x.code === 'engine' ? (x.text ? ESC(x.text) : T('tc_engine')) : T('tc_' + x.code, x);
  const resL = e => e.win === true ? ['r_win', 'ok-t'] : e.win === false ? ['r_loss', 'bad-t'] : e.tie ? ['r_tie', 'mu-t'] : e.voided || e.failed ? ['r_void', 'mu-t'] : e.stale ? ['r_unknown', 'warn-t'] : ['r_pending', 'cy-t'];
  const kv = (title, val, sub, cls) => `<div class="card kv"><h3>${title}</h3><b class="${cls || ''}">${val}</b>${sub ? '<small>' + sub + '</small>' : ''}</div>`;
  const put = (id, html) => { const el = typeof id === 'string' ? $(id) : id; if (el && el.__h !== html) { el.__h = html; el.innerHTML = html; } };

  // ---------- التنبيهات ----------
  const alerts = [];
  let unread = 0, actx = null;
  function beep(level) {
    if (!P.sound) return;
    try {
      const AC = win.AudioContext || win.webkitAudioContext;
      if (!AC) return;
      actx = actx || new AC();
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = level === 'bad' ? 330 : level === 'ok' ? 880 : 660;
      g.gain.setValueAtTime(.06, actx.currentTime); g.gain.exponentialRampToValueAtTime(.0001, actx.currentTime + .25);
      o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + .26);
    } catch (e) {}
  }
  // key/vars تُحفظ بدل النص: التنبيه يُعاد ترجمته عند تغيير اللغة
  function notify(type, level, key, vars) {
    if (!P.types[type]) return;
    alerts.unshift({ at: Date.now(), type, level, key, vars: vars || {} });
    if (alerts.length > 100) alerts.pop();
    if (P.page !== 'alerts' || P.min) unread++;
    if (P.toasts) {
      const el = doc.createElement('div');
      el.className = 'toast ' + level;
      el.textContent = alertText(alerts[0]);
      el.dir = P.lang === 'ar' ? 'rtl' : 'ltr';
      $('toasts').prepend(el);
      while ($('toasts').children.length > 4) $('toasts').lastElementChild.remove();
      win.setTimeout(() => el.remove(), 5000);
    }
    beep(level);
    paintNav();
  }
  const alertText = a => { const v = { ...a.vars }; if (v.sKey) v.s = T(v.sKey); if (v.fromRg) v.from = rgL(v.fromRg); if (v.toRg) v.to = rgL(v.toRg); return T(a.key, v); };
  app.on('signal', e => notify('signal', e.dir === 'call' ? 'ok' : 'bad', 'n_signal', { a: e.asset, d: e.dir === 'call' ? 'CALL' : 'PUT', c: e.conf }));
  app.on('result', w => notify('signal', w ? 'ok' : 'bad', w ? 'n_result_w' : 'n_result_l'));
  app.on('asset', x => notify('asset', 'info', 'n_asset', { from: x.from, to: x.to }));
  app.on('feed', x => notify('conn', FEED_LVL[x.to] || 'info', 'n_feed', { sKey: 'fs_' + x.to }));
  app.on('reloadAdvice', () => notify('conn', 'bad', 'n_reload'));
  let prev = null;
  function derive(D) {
    const cur = { tm: D.timing.state, rg: D.signal && D.signal.regime !== '-' ? D.signal.regime : null, lowQ: !!(D.dq && D.dq.q < D.cfg.minQ), q: D.dq ? D.dq.q : null,
      conflict: !!(D.signal && D.signal.oppPct !== null && D.signal.oppPct >= 30), opp: D.signal ? D.signal.oppPct : null, asset: D.asset };
    if (prev && prev.asset === cur.asset) {
      if (cur.tm !== prev.tm) notify('timing', TM_LVL[cur.tm] === 'mute' ? 'info' : TM_LVL[cur.tm], 'n_timing', { sKey: 'tm_' + cur.tm });
      if (cur.rg && prev.rg && cur.rg !== prev.rg) notify('trend', 'info', 'n_trend', { fromRg: prev.rg, toRg: cur.rg });
      if (cur.lowQ && !prev.lowQ) notify('quality', 'warn', 'n_quality', { q: cur.q });
      if (cur.conflict && !prev.conflict) notify('conflict', 'warn', 'n_conflict', { n: cur.opp });
    }
    prev = cur;
  }

  // ---------- الهيكل ----------
  function paintNav() {
    put('nav', PAGES.map(p => `<a data-p="${p}" class="${P.page === p ? 'on' : ''}" role="button" tabindex="0">${svg(p)}<span>${T('nav_' + p)}</span>${p === 'alerts' ? '<span class="cnt">' + (unread || '') + '</span>' : ''}</a>`).join(''));
  }
  function chrome() {
    root.dir = P.lang === 'ar' ? 'rtl' : 'ltr';
    root.lang = P.lang;
    root.classList.toggle('compact', !!P.compact);
    root.classList.toggle('motion', !!P.motion);
    $('bsub').textContent = T('brand_sub') + ' · ' + T('dev');
    $('foot').textContent = T('disclaimer');
    $('lang').textContent = T('lang_switch');
    $('min').textContent = T('minimize') + ' ▾';
    $('title').textContent = T('nav_' + P.page);
    paintNav();
  }
  function go(p) {
    if (!PAGES.includes(p)) return;
    P.page = p; if (p !== 'adv') save();
    if (p === 'alerts') unread = 0;
    sh.querySelectorAll('.page').forEach(x => x.classList.toggle('on', x.dataset.page === p));
    chrome();
    if (p === 'settings') buildSettings();
    paint();
  }
  const navAct = e => { const a = e.target.closest('a[data-p]'); if (a) go(a.dataset.p); };
  $('nav').onclick = navAct;
  $('nav').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navAct(e); } };
  $('lang').onclick = () => { P.lang = P.lang === 'ar' ? 'en' : 'ar'; save(); sh.querySelectorAll('.page').forEach(x => { x.__h = null; }); go(P.page); };
  function setMin(m) {
    P.min = m; save();
    root.classList.toggle('hide', m);
    pill.classList.toggle('show', m);
    if (!m) paint();
  }
  $('min').onclick = () => setMin(true);
  pill.style.left = P.x + 'px'; pill.style.top = P.y + 'px';
  let drag = null;
  pill.onpointerdown = e => { drag = { sx: e.clientX, sy: e.clientY, x: pill.offsetLeft, y: pill.offsetTop, mv: false }; try { pill.setPointerCapture(e.pointerId); } catch (_) {} };
  pill.onpointermove = e => {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 5) drag.mv = true;
    if (drag.mv) { pill.style.left = Math.max(0, drag.x + dx) + 'px'; pill.style.top = Math.max(0, drag.y + dy) + 'px'; }
  };
  pill.onpointerup = () => {
    if (drag && !drag.mv) setMin(false);
    else if (drag) { P.x = pill.offsetLeft; P.y = pill.offsetTop; save(); }
    drag = null;
  };

  // ---------- الصفحات ----------
  function pDash(D) {
    const f = D.feed, s = D.signal, live = f.status === 'live' || f.status === 'delayed', has = s && s.d !== 'none';
    const trend = s && s.sd ? (s.sd > 0 ? '▲ ' + T('up') : '▼ ' + T('down')) : T('flat');
    const cards =
      kv(T('d_bot'), live ? T('d_bot_on') : T('d_bot_wait'), T('d_bot_sub'), live ? 'ok-t' : 'warn-t') +
      kv(T('d_conn'), T('fs_' + f.status), T('d_src') + (f.why ? '<br>' + ESC(f.why) : ''), FEED_LVL[f.status] + '-t') +
      kv(T('d_asset'), D.asset ? ESC(D.asset) : T('na'), D.asset ? (D.lock ? T('d_locked') : T('d_follow')) + ' · ' + T('d_candles', { n: D.candles }) : T('d_asset_none')) +
      kv(T('d_tf'), tfL(D.tf), D.candleLeftS !== null && live ? T('d_next', { n: D.candleLeftS }) : T('sec', { n: D.tf })) +
      kv(T('d_trend'), trend, s ? rgL(s.regime) + (s.ctx ? ' · ' + ESC(s.ctx.label) + ' · ' + T('s_clarity', { n: s.ctx.clarity }) : '') : '', s && s.sd ? (s.sd > 0 ? 'ok-t' : 'bad-t') : 'mu-t') +
      `<div class="card kv"><h3>${T('d_strength')}</h3><b class="${has ? dirC(s.d) : 'mu-t'}">${has ? s.conf + ' / 100 · ' + dirL(s.d) : '—'}</b><div class="bar"><i style="width:${has ? s.conf : 0}%"></i></div><small>${T('d_strength_sub')}</small></div>` +
      kv(T('d_last'), f.lastPrice !== null ? px(f.lastPrice) : T('na'), ago(f.ageMs) + (f.lastAt ? ' · ' + tm(f.lastAt) : ''), f.ageMs !== null && f.ageMs <= D.cfg.maxTickAgeMs ? '' : 'warn-t') +
      kv(T('d_scanned'), D.assetsScanned, T('d_scanned_sub')) +
      kv(T('d_signals'), D.signalsLogged, T('d_signals_sub', { n: D.stats.total.n })) +
      kv(T('d_engine'), T('an_' + D.analysis), D.dq ? T('s_quality') + ': ' + D.dq.q + '%' : '', D.analysis === 'active' ? 'ok-t' : D.analysis === 'idle' || D.analysis === 'paused' ? 'warn-t' : 'cy-t') +
      kv(T('d_timing'), T('tm_' + D.timing.state), tmWhy(D.timing) + '<br>' + T('tm_prelim'), (TM_LVL[D.timing.state] === 'mute' ? 'mu' : TM_LVL[D.timing.state] === 'info' ? 'cy' : TM_LVL[D.timing.state]) + '-t');
    const rec = D.log.slice(0, 8).map(e => { const [rk, rc] = resL(e); return `<tr><td class="num">${tm(e.t)}</td><td>${ESC(e.asset)}</td><td class="num ${dirC(e.dir)}">${dirL(e.dir)}</td><td class="num">${e.conf}</td><td class="num ${rc}">${T(rk)}</td></tr>`; }).join('');
    return `<div class="grid">${cards}</div><div class="card" style="margin-top:var(--gap)"><h3>${T('d_recent')}</h3>` +
      (rec ? `<div class="scroll"><table><thead><tr><th>${T('h_time')}</th><th>${T('h_asset')}</th><th>${T('h_dir')}</th><th>${T('h_score')}</th><th>${T('h_res')}</th></tr></thead><tbody>${rec}</tbody></table></div>` : `<div class="empty">${T('d_no_recent')}</div>`) + '</div>';
  }
  function pMarketTable(D) {
    const rows = D.assets.map(a => `<tr><td>${ESC(a.a)}${a.cur ? ' <span class="tag">' + T('m_current') + '</span>' : ''}</td><td class="num">${px(a.price)}</td><td class="num">${ago(a.ageMs)}</td><td class="num">${a.candles}</td>` +
      `<td class="${dirC(a.d)}">${a.d && a.d !== 'none' ? dirL(a.d) + ' ' + a.conf : '—'}</td><td>${a.locked ? `<button data-unlock="1">${T('m_unlock')}</button>` : a.candles ? `<button data-lock="${ESC(a.a)}">${T('m_lock')}</button>` : ''}</td></tr>`).join('');
    return `<h3>${T('m_assets')}</h3>` + (rows ? `<div class="scroll"><table><thead><tr><th>${T('m_col_asset')}</th><th>${T('m_col_price')}</th><th>${T('m_col_age')}</th><th>${T('m_col_candles')}</th><th>${T('m_col_sig')}</th><th>${T('m_col_act')}</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty">${T('m_no_assets')}</div>`) +
      `<div class="note">${T('m_assets_note', { n: D.cfg.maxAssets })}</div>`;
  }
  function sigCard(D) {
    const s = D.signal, has = s && s.d !== 'none', last = has ? D.log.find(e => e.asset === D.asset && e.dir === s.d) : null;
    const tags = (xs, cls) => xs.length ? '<div class="tags">' + xs.map(x => `<span class="tag ${cls}">${indL(x)}</span>`).join('') + '</div>' : `<span class="mu-t">${T('none')}</span>`;
    const reason = s ? (has ? s.notes : s.abst.concat(s.notes)).map(ESC).join(' · ') : '';
    const lvl = TM_LVL[D.timing.state];
    return `<div class="card sig ${has ? s.d : ''}"><h3>${T('s_current')}</h3><div class="big ${has ? dirC(s.d) : 'mu-t'}">${has ? T(s.d === 'call' ? 's_call' : 's_put') : T('s_none')}</div>` +
      '<dl class="dl">' +
      `<dt>${T('s_asset')}</dt><dd>${D.asset ? ESC(D.asset) : T('na')}</dd>` +
      `<dt>${T('s_time')}</dt><dd>${last ? tm(last.t) : '—'}</dd>` +
      `<dt>${T('s_tf')}</dt><dd>${tfL(D.tf)}</dd>` +
      `<dt>${T('s_eval')}</dt><dd>${T('s_eval_v', { n: D.tf })}${s && s.bestHz ? '<br><span class="mu-t">' + T('s_besthz', { s: s.bestHz.s, p: s.bestHz.accPct }) + '</span>' : ''}</dd>` +
      `<dt>${T('s_price')}</dt><dd>${last ? px(last.entry) : '—'}</dd>` +
      `<dt>${T('s_strength')}</dt><dd>${has ? s.conf + ' / 100' : '—'}<div class="bar"><i style="width:${has ? s.conf : 0}%"></i></div></dd>` +
      `<dt>${T('s_pro')}</dt><dd>${s ? tags(s.pro, 'pro') : '—'}</dd>` +
      `<dt>${T('s_con')}</dt><dd>${s ? tags(s.con, 'con') : '—'}${s && s.oppPct !== null ? '<span class="note">' + T('s_opp', { n: s.oppPct }) + (s.agree !== null ? ' · ' + T('s_agree', { n: s.agree }) : '') + '</span>' : ''}</dd>` +
      `<dt>${T('s_ctx')}</dt><dd>${s ? rgL(s.regime) + (s.ctx ? ' · ' + ESC(s.ctx.label) + ' · ' + T('s_clarity', { n: s.ctx.clarity }) : '') : '—'}</dd>` +
      `<dt>${T('s_reason')}</dt><dd>${reason || '—'}</dd>` +
      `<dt>${T('s_timing')}</dt><dd><span class="chip ${lvl === 'mute' ? '' : lvl}">${T('tm_' + D.timing.state)}</span> <span class="mu-t">${tmWhy(D.timing)}</span></dd>` +
      `<dt>${T('s_quality')}</dt><dd>${D.dq ? D.dq.q + '%' + (D.dq.issues && D.dq.issues.length ? ' <span class="mu-t">(' + D.dq.issues.map(ESC).join(P.lang === 'ar' ? '، ' : ', ') + ')</span>' : '') : T('na')} · ${T('fs_' + D.feed.status)}</dd>` +
      '</dl>' + `<div class="note">${T('s_no_prob')}</div>` + (T('s_engine_ar') ? `<div class="note">${T('s_engine_ar')}</div>` : '') + '</div>';
  }
  const logRows = (D, n) => D.log.slice(0, n).map(e => {
    const [rk, rc] = resL(e);
    return `<tr><td class="num">${Math.floor(e.t / 1000).toString(36).toUpperCase()}</td><td>${ESC(e.asset)}</td><td class="num ${dirC(e.dir)}">${dirL(e.dir)}</td><td class="num">${new Date(e.t).toLocaleDateString('en-GB')} ${tm(e.t)}</td><td class="num">${px(e.entry)}</td><td class="num">${e.exit === null ? '—' : px(e.exit)}</td><td class="num ${rc}">${T(rk)}</td><td class="num">${e.conf}</td><td>${e.why.map(ESC).join(' · ')}</td></tr>`;
  }).join('');
  const logTable = (D, n) => { const r = logRows(D, n); return r ? `<div class="scroll"><table><thead><tr><th>${T('h_id')}</th><th>${T('h_asset')}</th><th>${T('h_dir')}</th><th>${T('h_time')}</th><th>${T('h_entry')}</th><th>${T('h_exit')}</th><th>${T('h_res')}</th><th>${T('h_score')}</th><th>${T('h_why')}</th></tr></thead><tbody>${r}</tbody></table></div>` : `<div class="empty">${T('d_no_recent')}</div>`; };
  function pSignals(D) { return sigCard(D) + `<div class="card" style="margin-top:var(--gap)"><h3>${T('s_recent')}</h3>${logTable(D, 15)}</div>`; }
  function pHistory(D) {
    const S = D.stats, tt = S.total, ci = x => x.n ? Math.round(x.lo * 100) + '–' + Math.round(x.hi * 100) + '%' : '—';
    const tbl = (title, rows, lab) => `<div class="card"><h3>${title}</h3>` + (rows.length ? `<div class="scroll" style="max-height:260px"><table><thead><tr><th>${T('h_col_k')}</th><th>${T('h_col_n')}</th><th>${T('h_col_w')}</th><th>${T('h_col_acc')}</th><th>${T('h_col_ci')}</th></tr></thead><tbody>` +
      rows.map(r => `<tr><td>${lab(r)}</td><td class="num">${r.n}</td><td class="num">${r.w}</td><td class="num">${pct(r.acc)}</td><td class="num">${ci(r)}</td></tr>`).join('') + '</tbody></table></div>' : `<div class="empty">${T('h_empty')}</div>`) + '</div>';
    return '<div class="grid">' + kv(T('h_total'), tt.n) + kv(T('h_right'), tt.w, '', 'ok-t') + kv(T('h_wrong'), tt.n - tt.w, '', 'bad-t') +
      kv(T('h_acc'), tt.n ? pct(tt.acc) : '—', tt.n ? T('h_ci', { lo: Math.round(tt.lo * 100), hi: Math.round(tt.hi * 100) }) + (tt.n < 100 ? '<br>' + T('h_small') : '') : T('h_empty')) + '</div>' +
      `<div class="note" style="margin:8px 2px">${T('h_disclaimer')}</div>` +
      '<div class="cols" style="grid-template-columns:repeat(auto-fit,minmax(280px,1fr))">' + tbl(T('h_by_asset'), S.byAsset, r => ESC(r.k)) + tbl(T('h_by_tf'), S.byTf, r => tfL(+r.k)) + tbl(T('h_by_strat'), S.byStrat, r => indL(r)) + '</div>' +
      `<div class="card" style="margin-top:var(--gap)"><h3>${T('h_log')}</h3>${logTable(D, 200)}<div class="note">${T('h_note')}</div></div>`;
  }
  function pAlerts() {
    return `<div class="card"><h3>${T('a_title')} <button id="aClr" style="margin-inline-start:auto">${T('a_clear')}</button></h3>` +
      (alerts.length ? alerts.map(a => `<div class="al"><time>${tm(a.at)}</time><span class="${a.level === 'info' ? 'cy' : a.level}-t">●</span><span>${ESC(alertText(a))}</span></div>`).join('') : `<div class="empty">${T('a_empty')}</div>`) + '</div>';
  }
  function pAdv(D) {
    return `<div class="card"><h3>${T('adv_title')}</h3><p>${T('adv_d')}</p><div class="row"><button id="advOpen">${T('adv_open')}</button><span class="chip ${D.errors ? 'warn' : 'ok'}">${T('adv_errors', { n: D.errors })}</span>${D.storeErr ? '<span class="chip bad">' + T('adv_store') + '</span>' : ''}</div></div>`;
  }
  // الإعدادات تُبنى عند الدخول فقط (لا تُعاد كل ثانية حتى لا تُقاطع المستخدم)، وكل عنصر فيها مربوط بأمر أو تفضيل فعلي
  function buildSettings() {
    const D = app.vm.dash(), c = D.cfg;
    const row = (k, ctl, d) => `<div class="row"><div class="lbl"><b>${T(k)}</b>${d ? '<span class="note">' + T(d) + '</span>' : ''}</div><div class="ctl">${ctl}</div></div>`;
    const sw = (id, on) => `<button class="sw ${on ? 'on' : ''}" id="${id}" role="switch" aria-checked="${!!on}"><i></i></button>`;
    const seg = (id, items, cur) => `<div class="seg" id="${id}">${items.map(([v, l]) => `<button data-v="${v}" class="${String(cur) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    const el = $('pg-settings');
    el.__h = null;
    el.innerHTML =
      '<div class="card">' +
      row('st_mode', seg('sMode', [['manual', T('st_manual')], ['follow', T('st_follow')]], D.lock ? 'manual' : 'follow') + '<span class="note" id="sModeN"></span>', 'st_mode_d') +
      row('st_tf', `<select id="sTf">${[15, 30, 60].map(v => `<option value="${v}" ${v === c.tf ? 'selected' : ''}>${tfL(v)} (${T('sec', { n: v })})</option>`).join('')}</select>`, 'st_tf_d') +
      row('st_min', `<input type="range" id="sMin" min="50" max="90" value="${c.minConf}"><b id="sMinV">${c.minConf}</b>`, 'st_min_d') +
      row('st_lang', seg('sLang', [['ar', 'العربية'], ['en', 'English']], P.lang), 'st_lang_d') + '</div>' +
      `<div class="card" style="margin-top:var(--gap)"><h3>${T('st_alerts')}</h3>` + row('st_toasts', sw('sToasts', P.toasts), 'st_toasts_d') + row('st_sound', sw('sSound', P.sound), 'st_sound_d') +
      `<h3 style="margin-top:12px">${T('st_types')}</h3>` + TYPES.map(k => row('ty_' + k, sw('sTy-' + k, P.types[k]))).join('') + '</div>' +
      `<div class="card" style="margin-top:var(--gap)"><h3>${T('st_ui')}</h3>` + row('st_compact', sw('sCompact', P.compact), 'st_compact_d') + row('st_motion', sw('sMotion', P.motion), 'st_motion_d') + '</div>' +
      `<div class="card" style="margin-top:var(--gap)"><h3>${T('st_conn')}</h3><p class="note">${T('st_conn_d')}</p><dl class="dl"><dt>${T('st_conn_live')}</dt><dd>${T('sec', { n: c.feedLiveMs / 1000 })}</dd><dt>${T('st_conn_delay')}</dt><dd>${T('sec', { n: c.maxTickAgeMs / 1000 })}</dd><dt>${T('st_conn_unav')}</dt><dd>${T('sec', { n: c.feedUnavailableMs / 1000 })}</dd></dl><div class="note">${T('st_conn_ro')}</div></div>` +
      `<div class="card" style="margin-top:var(--gap)"><h3>${T('st_pending')}</h3><ul class="note" style="padding-inline-start:18px"><li>${T('st_p1')}</li><li>${T('st_p2')}</li><li>${T('st_p3')}</li></ul></div>`;
    const tog = (id, get, set) => { $(id).onclick = () => { set(!get()); save(); $(id).classList.toggle('on', get()); $(id).setAttribute('aria-checked', String(!!get())); chrome(); }; };
    tog('sToasts', () => P.toasts, v => { P.toasts = v; });
    tog('sSound', () => P.sound, v => { P.sound = v; if (v) beep('ok'); });
    tog('sCompact', () => P.compact, v => { P.compact = v; });
    tog('sMotion', () => P.motion, v => { P.motion = v; });
    TYPES.forEach(k => tog('sTy-' + k, () => P.types[k], v => { P.types[k] = v; }));
    $('sLang').onclick = e => { const b = e.target.closest('button[data-v]'); if (b && b.dataset.v !== P.lang) { P.lang = b.dataset.v; save(); sh.querySelectorAll('.page').forEach(x => { x.__h = null; }); go('settings'); } };
    $('sMode').onclick = e => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      const cur = app.vm.dash().asset;
      if (b.dataset.v === 'manual' && !cur) { $('sModeN').textContent = T('st_manual_need'); return; }
      const lock = cmd.lockAsset(b.dataset.v === 'manual' ? cur : null);
      $('sModeN').textContent = lock ? lock : '';
      $('sMode').querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.v === (lock ? 'manual' : 'follow')));
    };
    $('sTf').onchange = e => { if (!cmd.setTf(+e.target.value)) e.target.value = String(app.vm.dash().tf); };
    $('sMin').oninput = e => { $('sMinV').textContent = cmd.setMinConf(+e.target.value); };
  }

  // ---------- الشارت ----------
  let hover = -1, lastChart = null;
  function drawChart() {
    const cv = $('cv');
    if (!cv) return;
    const C = app.vm.chart(), arr = C.arr, ctx = cv.getContext('2d'), dpr = win.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    lastChart = C;
    if (!W) return;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (arr.length < 3) { ctx.fillStyle = '#8e8ea6'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(T('m_wait'), W / 2, H / 2); put('ohlc', ''); return; }
    let hi = -Infinity, lo = Infinity;
    arr.forEach(c => { hi = Math.max(hi, c.h); lo = Math.min(lo, c.l); });
    const pad = (hi - lo) * .08 || 1e-6; hi += pad; lo -= pad;
    const R = 64, w = W - R, y = v => H - (v - lo) / (hi - lo) * H, cw = w / arr.length;
    ctx.strokeStyle = '#2a2a3a'; ctx.lineWidth = 1; ctx.fillStyle = '#8e8ea6'; ctx.font = '10.5px sans-serif'; ctx.textAlign = 'left';
    for (let i = 1; i < 5; i++) { const yy = H * i / 5; ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(w, yy); ctx.stroke(); ctx.fillText(String(+(hi - (hi - lo) * i / 5).toPrecision(7)), w + 6, yy + 3); }
    arr.forEach((c, i) => {
      const x = i * cw + cw / 2, up = c.c >= c.o;
      ctx.strokeStyle = ctx.fillStyle = up ? '#34d399' : '#f87171';
      ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.moveTo(x, y(c.h)); ctx.lineTo(x, y(c.l)); ctx.stroke();
      ctx.fillRect(x - cw * .32, Math.min(y(c.o), y(c.c)), cw * .64, Math.max(1.5, Math.abs(y(c.o) - y(c.c))));
    });
    const cols = ['#8b5cf6', '#22d3ee'];
    C.lines.forEach((ln, li) => {
      ctx.strokeStyle = cols[li % 2]; ctx.lineWidth = 1.5; ctx.beginPath();
      ln.v.forEach((val, i) => { const x = i * cw + cw / 2; if (i) ctx.lineTo(x, y(val)); else ctx.moveTo(x, y(val)); });
      ctx.stroke();
    });
    C.marks.forEach(m => {
      const x = m.i * cw + cw / 2, yy = y(m.entry);
      ctx.fillStyle = m.win === null ? '#fbbf24' : m.win ? '#34d399' : '#f87171';
      ctx.beginPath();
      if (m.dir === 'call') { ctx.moveTo(x, yy - 9); ctx.lineTo(x - 6, yy + 2); ctx.lineTo(x + 6, yy + 2); } else { ctx.moveTo(x, yy + 9); ctx.lineTo(x - 6, yy - 2); ctx.lineTo(x + 6, yy - 2); }
      ctx.fill();
    });
    const hi2 = hover >= 0 && hover < arr.length ? hover : arr.length - 1, c = arr[hi2];
    if (hover >= 0 && hover < arr.length) { const x = hover * cw + cw / 2; ctx.strokeStyle = '#ececf455'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); ctx.setLineDash([]); }
    put('ohlc', new Date(c.t * 1000).toLocaleTimeString('en-GB', { hour12: false }) + ' · ' + T('m_ohlc', { o: c.o, h: c.h, l: c.l, c: c.c }));
  }
  function ensureMarket(D) {
    const el = $('pg-market');
    if (!$('cv') || el.__lang !== P.lang) {
      el.__lang = P.lang;
      el.innerHTML = `<div class="card"><h3 id="mTitle"></h3><div class="note" style="margin:0 0 8px">${T('m_chart_sub')} <span class="pu-t">━ EMA 9</span> <span class="cy-t">━ EMA 21</span></div><canvas id="cv"></canvas><div class="note" id="ohlc" style="direction:ltr;text-align:start"></div></div><div class="card" style="margin-top:var(--gap)" id="mTbl"></div>`;
      const cv = $('cv');
      cv.onpointermove = e => { const n = lastChart ? lastChart.arr.length : 0, r = cv.getBoundingClientRect(); hover = n ? Math.min(n - 1, Math.max(0, Math.floor((e.clientX - r.left) / ((r.width - 64) / n)))) : -1; drawChart(); };
      cv.onpointerleave = () => { hover = -1; drawChart(); };
      $('mTbl').onclick = e => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.lock) cmd.lockAsset(b.dataset.lock); else if (b.dataset.unlock) cmd.lockAsset(null);
        paint();
      };
    }
    $('mTitle').textContent = T('m_chart', { a: D.asset || '—' }) + ' · ' + tfL(D.tf);
    put('mTbl', pMarketTable(D));
    drawChart();
  }

  // ---------- الرسم ----------
  function paint() {
    const D = app.vm.dash();
    derive(D);
    const fl = FEED_LVL[D.feed.status] || '', tl = TM_LVL[D.timing.state];
    pill.className = 'pill ' + fl + (P.min ? ' show' : '');
    $('pillT').textContent = (D.asset || NAME) + ' · ' + (D.signal && D.signal.d !== 'none' ? dirL(D.signal.d) + ' ' + D.signal.conf : T('tm_' + D.timing.state));
    if (P.min) return D;
    $('cFeed').className = 'chip ' + fl; $('cFeed').textContent = T('fs_' + D.feed.status);
    $('cTm').className = 'chip ' + (tl === 'mute' ? '' : tl); $('cTm').textContent = T('tm_' + D.timing.state);
    if (P.page === 'dash') put('pg-dash', pDash(D));
    else if (P.page === 'market') ensureMarket(D);
    else if (P.page === 'signals') put('pg-signals', pSignals(D));
    else if (P.page === 'history') put('pg-history', pHistory(D));
    else if (P.page === 'alerts') { put('pg-alerts', pAlerts()); const b = $('aClr'); if (b) b.onclick = () => { alerts.length = 0; unread = 0; paint(); paintNav(); }; }
    else if (P.page === 'adv') { put('pg-adv', pAdv(D)); const b = $('advOpen'); if (b) b.onclick = () => { if (opts && opts.openLegacy) opts.openLegacy(); }; }
    return D;
  }
  const safe = () => { try { paint(); } catch (e) { try { win.console.warn('posb paint', e); } catch (_) {} } };
  const t1 = win.setInterval(safe, 1000);
  const t2 = win.setInterval(() => { if (!P.min && P.page === 'market') { try { drawChart(); } catch (e) {} } }, 500);
  go(P.page);
  setMin(!!P.min);
  return { paint, host, go, setMin, notify, prefs: () => JSON.parse(JSON.stringify(P)), alerts: () => alerts.map(a => ({ ...a, text: alertText(a) })), backLabel: () => T('adv_back'), stop() { win.clearInterval(t1); win.clearInterval(t2); } };
}
module.exports = { buildShell, CSS, NAME, PREF_KEY, PAGES };
