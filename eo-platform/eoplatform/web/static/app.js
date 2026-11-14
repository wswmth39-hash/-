'use strict';
// Arabic dashboard. All server text is inserted via esc()/textContent (no HTML injection).
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const DUR = {30: '30 ث', 60: '1 د', 120: '2 د', 300: '5 د'};
const STATE = {LIVE: ['حية', 'ok'], DELAYED: ['متأخرة', 'warn'], STALE: ['قديمة', 'bad'], OFFLINE: ['غير متاحة', 'bad']};
const DEC = {BUY: 'شراء ▲', SELL: 'بيع ▼', WAIT: 'انتظار ⏸'};
const STATUS = {win: 'ربح', loss: 'خسارة', draw: 'تعادل', void: 'ملغاة', pending: 'قيد الانتظار'};
const SRC = {expertoption: 'ExpertOption', binance: 'Binance (مرجعي)', import: 'مستورد'};
let CSRF = '', OV = null, state = {kind: 'regular', market: null, dur: 60, period: 10}, sigOffset = 0;

const fmtT = (t) => t ? new Date(t * 1000).toLocaleString('ar-EG', {hour12: false}) : '—';
const fmtTime = (t) => t ? new Date(t * 1000).toLocaleTimeString('ar-EG', {hour12: false}) : '—';
const pct = (x) => x == null ? '—' : (x * 100).toFixed(1) + '%';
const num = (x, d = 5) => x == null ? '—' : Number(x).toFixed(d);

async function api(path, opt = {}) {
  const o = {headers: {'Content-Type': 'application/json'}, ...opt};
  if (o.method && o.method !== 'GET') o.headers['X-CSRF-Token'] = CSRF;
  if (o.body && typeof o.body !== 'string') o.body = JSON.stringify(o.body);
  const r = await fetch(path, o);
  if (r.status === 401) { location.href = '/login'; throw new Error('auth'); }
  if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.detail || r.statusText); }
  return r.json();
}
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 3500); }
function badge(cls, text) { return `<span class="badge ${esc(cls)}">${esc(text)}</span>`; }
function dot(cls) { return `<span class="dot ${esc(cls)}"></span>`; }
function setPillText(id, text, cls, title) { const p = $(id); p.lastElementChild.textContent = text; setPill(id, cls, title); }
function setPill(id, cls, title) { const p = $(id); p.querySelector('.dot').className = 'dot ' + cls; p.title = title || ''; }
function table(el, head, rows) {
  $(el + ' thead').innerHTML = head ? '<tr>' + head.map((h) => `<th>${esc(h)}</th>`).join('') + '</tr>' : $(el + ' thead').innerHTML;
  $(el + ' tbody').innerHTML = rows.length ? rows.join('') : `<tr><td colspan="${head ? head.length : 8}" class="muted">لا توجد بيانات بعد</td></tr>`;
}

// ---------------------------------------------------------------- navigation
$$('#nav button').forEach((b) => b.addEventListener('click', () => {
  $$('#nav button').forEach((x) => x.classList.toggle('active', x === b));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'v-' + b.dataset.view));
  ({auto: loadAuto, exec: loadExec, signals: loadSignals, agents: loadAgents, perf: loadPerf, monitor: loadMonitor, status: loadStatus, settings: loadSettings}[b.dataset.view] || (() => {}))(true);
}));
$('#theme').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = cur === 'light' ? 'dark' : 'light';
  try { localStorage.setItem('theme', document.documentElement.dataset.theme); } catch (e) {}
  drawChart();
});
try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch (e) {}
$('#logout').addEventListener('click', async () => { await api('/api/logout', {method: 'POST'}); location.href = '/login'; });
$('#dlg-close').addEventListener('click', () => $('#dlg').close());

// ---------------------------------------------------------------- dashboard controls
function segment(sel, key, attr, cb) {
  $$(sel + ' button').forEach((b) => b.addEventListener('click', () => {
    $$(sel + ' button').forEach((x) => x.classList.toggle('on', x === b));
    state[key] = attr === 'kind' ? b.dataset.kind : Number(b.dataset[attr]);
    cb && cb();
  }));
}
segment('#kind-seg', 'kind', 'kind', () => { state.market = null; fillMarkets(); });
segment('#dur-seg', 'dur', 'd');
segment('#per-seg', 'period', 'p', loadChart);
$('#market').addEventListener('change', (e) => { state.market = e.target.value; showMarketState(); loadChart(); });

function fillMarkets() {
  if (!OV) return;
  const list = OV.markets.filter((m) => m.kind === state.kind);
  const sel = $('#market');
  sel.innerHTML = list.map((m) => `<option value="${esc(m.id)}">${esc(m.name_ar || m.name)} — ${esc(STATE[m.state][0])}</option>`).join('');
  if (!state.market || !list.find((m) => m.id === state.market)) {
    const live = list.find((m) => m.state === 'LIVE');
    state.market = (live || list[0] || {}).id;
  }
  sel.value = state.market || '';
  showMarketState();
}
function showMarketState() {
  const m = OV && OV.markets.find((x) => x.id === state.market);
  if (!m) { $('#mkt-state').textContent = ''; return; }
  const [t, c] = STATE[m.state];
  const src = m.best_source ? SRC[m.best_source] || m.best_source : 'لا يوجد';
  $('#mkt-state').innerHTML = `${dot(c)} البيانات: <b>${esc(t)}</b> · المصدر: ${esc(src)}` +
    (m.kind === 'otc' ? ' · <span class="muted">OTC: بيانات ExpertOption فقط</span>' : '') +
    (m.best_source === 'binance' ? '<div class="warnbox">مصدر مرجعي: سعر Binance الفوري وليس سعر ExpertOption نفسه.</div>' : '');
}

$('#analyze').addEventListener('click', async () => {
  if (!state.market) return toast('اختر سوقًا');
  const btn = $('#analyze'); btn.disabled = true; btn.textContent = '... جارٍ التحليل';
  try {
    const s = await api('/api/analyze', {method: 'POST', body: {market: state.market, duration: state.dur, deep: $('#deep').checked}});
    renderResult(s);
    if (s.agents_status) pollAgentResult(s.id);
    refresh();
  } catch (e) { toast('خطأ: ' + e.message); }
  btn.disabled = false; btn.textContent = '⚡ حلّل الآن';
});

function renderResult(s, agent) {
  const d = $('#r-decision');
  d.className = 'decision ' + s.decision; d.textContent = DEC[s.decision];
  const conf = s.confidence != null ? `${pct(s.confidence)} <span class="muted small">(دقة خارج العينة على ${esc(s.confidence_detail?.oos_samples ?? '?')} عينة، الحد الأدنى 95%: ${pct(s.confidence_detail?.wilson_lb)})</span>`
    : '<span class="muted">غير متاحة — لا يوجد أداء مُتحقق منه بعد</span>';
  const st = STATE[s.data_state] || ['—', ''];
  let h = `<dl class="kv">
    <dt>السوق</dt><dd>${esc(s.market_name_ar || s.market_name)} ${s.kind === 'otc' ? badge('', 'OTC') : ''}</dd>
    <dt>الاتجاه</dt><dd>${esc(DEC[s.decision])}${s.candidate && s.decision === 'WAIT' ? ` <span class="muted small">(الاتجاه المرشح: ${esc(DEC[s.candidate])})</span>` : ''}</dd>
    <dt>المدة</dt><dd>${esc(DUR[s.duration])}</dd>
    <dt>الوقت</dt><dd>${esc(fmtT(s.timestamp))}</dd>
    <dt>الثقة</dt><dd>${conf}</dd>
    <dt>اتجاه السوق</dt><dd>${esc(s.trend || '—')}</dd>
    <dt>حداثة البيانات</dt><dd>${dot(st[1])} ${esc(st[0])} · عمر آخر تحديث ${esc(s.data_age ?? '—')} ث · ${esc(SRC[s.data_source] || 'لا مصدر')}</dd>
    <dt>سعر الدخول</dt><dd class="ltr">${esc(num(s.entry_price))}</dd>
    <dt>زمن التحليل</dt><dd>${esc(s.latency_ms ?? '—')} مللي ثانية · ${s.source === 'agents' ? 'فريق الوكلاء' : 'المحرك السريع'}</dd>
  </dl>`;
  (s.warnings || []).forEach((w) => { h += `<div class="warnbox">${esc(w)}</div>`; });
  h += '<h3>الأسباب الفنية</h3><ul class="reasons">' + (s.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('') + '</ul>';
  if (s.agents_status) h += `<div id="agent-live" class="small muted">🤖 فريق الوكلاء: في الطابور…</div>`;
  if (agent) h += agent;
  $('#r-body').className = ''; $('#r-body').innerHTML = h;
}

async function pollAgentResult(signalId) {
  for (let i = 0; i < 400; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const a = await api('/api/agents').catch(() => null);
    const act = a && a.activity.find((x) => x.signal_id === signalId);
    const box = $('#agent-live');
    if (!box) return;
    if (!act) continue;
    if (act.state === 'running') box.textContent = '🤖 فريق الوكلاء يناقش الآن… (' + Math.round(Date.now() / 1000 - act.started_at) + ' ث)';
    if (act.state === 'error') { box.textContent = '🤖 فشل تشغيل الوكلاء: ' + act.error; return; }
    if (act.state === 'done') {
      box.innerHTML = `🤖 قرار فريق الوكلاء: ${badge(act.decision, DEC[act.decision])}` +
        (act.candidate && act.decision === 'WAIT' ? ` <span class="muted">(مرشح: ${esc(DEC[act.candidate])})</span>` : '') +
        ` · ${act.llm_partial ? 'النموذج اللغوي جزئيًا (فشل أثناء التشغيل وأُكمل حتميًا)' : act.llm_used ? 'بنموذج لغوي محلي' : 'استدلال حتمي (النموذج اللغوي غير متاح)'} · ${esc(act.elapsed)} ث ` +
        `<button class="btn ghost" id="see-run">عرض المناظرة</button>`;
      $('#see-run').addEventListener('click', () => showRun(act.run_id));
      return;
    }
  }
}

// ---------------------------------------------------------------- chart (canvas)
let CH = null;
async function loadChart() {
  if (!state.market) return;
  try { CH = await api(`/api/candles?market=${encodeURIComponent(state.market)}&period=${state.period}&limit=90`); } catch (e) { CH = null; }
  $('#chart-src').textContent = CH && CH.source ? 'المصدر: ' + (SRC[CH.source] || CH.source) : 'لا بيانات حقيقية';
  drawChart();
}
function drawChart() {
  const cv = $('#chart'), ctx = cv.getContext('2d');
  const W = cv.width = cv.clientWidth * devicePixelRatio, H = cv.height = cv.clientHeight * devicePixelRatio;
  const css = getComputedStyle(document.documentElement);
  ctx.clearRect(0, 0, W, H);
  const c = (CH && CH.candles) || [];
  ctx.fillStyle = css.getPropertyValue('--muted'); ctx.font = `${12 * devicePixelRatio}px sans-serif`;
  if (!c.length) { ctx.textAlign = 'center'; ctx.fillText('لا توجد بيانات حقيقية لهذا السوق', W / 2, H / 2); return; }
  const lo = Math.min(...c.map((x) => x[3])), hi = Math.max(...c.map((x) => x[2]));
  const pad = 8 * devicePixelRatio, axis = 70 * devicePixelRatio, cw = (W - axis - pad) / c.length;
  const y = (p) => pad + (hi - p) / ((hi - lo) || 1) * (H - 2 * pad);
  ctx.strokeStyle = css.getPropertyValue('--line'); ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const p = lo + (hi - lo) * i / 4, yy = y(p);
    ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(W - axis, yy); ctx.stroke();
    ctx.textAlign = 'left'; ctx.fillText(p.toPrecision(6), W - axis + 4, yy + 4);
  }
  c.forEach((k, i) => {
    const x = i * cw + cw / 2, up = k[4] >= k[1];
    ctx.strokeStyle = ctx.fillStyle = up ? css.getPropertyValue('--buy') : css.getPropertyValue('--sell');
    ctx.beginPath(); ctx.moveTo(x, y(k[2])); ctx.lineTo(x, y(k[3])); ctx.stroke();
    const b1 = y(Math.max(k[1], k[4])), b2 = y(Math.min(k[1], k[4]));
    ctx.fillRect(x - cw * 0.35, b1, cw * 0.7, Math.max(1, b2 - b1));
  });
}
addEventListener('resize', drawChart);

// ---------------------------------------------------------------- overview refresh
function signalRow(s) {
  return `<tr class="click" data-id="${esc(s.id)}"><td>${esc(s.id)}</td><td>${esc(fmtTime(s.created_at))}</td><td>${esc(s.market)}</td>
    <td>${esc(DUR[s.duration])}</td><td>${s.source === 'agents' ? 'الوكلاء' : 'سريع'}</td><td>${badge(s.decision, DEC[s.decision])}</td>
    <td>${s.candidate ? esc(DEC[s.candidate]) : '—'}</td><td>${pct(s.confidence)}</td><td>${esc(SRC[s.data_source] || '—')}</td>
    <td>${badge(s.status, STATUS[s.status])}</td></tr>`;
}
const SIG_HEAD = ['#', 'الوقت', 'السوق', 'المدة', 'المحرك', 'القرار', 'المرشح', 'الثقة', 'المصدر', 'النتيجة'];
function bindRows(el) { $$(el + ' tr.click').forEach((tr) => tr.addEventListener('click', () => showSignal(tr.dataset.id))); }

async function refresh() {
  try { OV = await api('/api/overview'); } catch (e) { return; }
  $('#payout').textContent = pct(OV.payout); $('#breakeven').textContent = pct(OV.breakeven);
  const h = OV.health;
  setPill('#pill-svc', h.status === 'ok' ? 'ok' : 'warn', h.status);
  const pv = h.providers || {};
  // CONNECTED is shown only with proof: transport up AND genuine data accepted recently.
  const proven = (p) => p && p.proven;
  setPillText('#pill-bridge', !OV.bridge_enabled ? 'جسر ExpertOption: معطّل' : proven(pv.expertoption) ? 'ExpertOption: متصل ✓' : 'ExpertOption: غير متصل',
    proven(pv.expertoption) ? 'ok' : 'bad', pv.expertoption?.detail || (OV.bridge_enabled ? 'لم تصل بيانات من الجسر' : 'معطّل افتراضيًا — انظر الإعدادات'));
  setPillText('#pill-ref', proven(pv.binance) ? 'Binance: متصل ✓' : 'Binance: غير متصل', proven(pv.binance) ? 'ok' : 'bad',
    pv.binance ? `${pv.binance.detail} · آخر بيانات قبل ${pv.binance.last_data_age ?? '—'} ث` : 'لم يتصل');
  setPillText('#pill-llm', h.llm.ok ? `${h.llm.model}: جاهز` : 'النموذج المحلي: غير متاح', h.llm.ok ? 'ok' : 'warn', h.llm.detail);
  setPillText('#pill-news', h.news?.ok ? 'الأخبار: متاحة' : 'الأخبار: غير متاحة', h.news?.ok ? 'ok' : 'warn', h.news?.error || `${h.news?.events || 0} حدث`);
  const ex = OV.execution || {};
  setPillText('#pill-mode', ex.kill_switch ? 'إيقاف طارئ' : ex.halted ? 'التداول موقوف' : ex.mode === 'paper' ? (ex.auto_enabled ? 'AUTO · تجريبي' : 'تجريبي') : (ex.auto_enabled ? 'AUTO · تحليل فقط' : 'تحليل فقط'),
    ex.kill_switch || ex.halted ? 'bad' : ex.mode === 'paper' ? 'warn' : 'ok', ex.halt_reason || 'لا يوجد تداول حقيقي — غير متاح');
  const sel = document.activeElement === $('#market');
  if (!sel) fillMarkets();
  table('#mkt-table', null, OV.markets.filter((m) => m.best_source).map((m) => {
    const s = m.sources.find((x) => x.source === m.best_source) || {};
    const [t, c] = STATE[m.state];
    return `<tr><td>${esc(m.name_ar || m.name)}</td><td>${m.kind === 'otc' ? 'OTC' : 'عادي'}</td><td>${esc(SRC[m.best_source])}</td>
      <td>${dot(c)} ${esc(t)}</td><td class="ltr">${esc(num(s.last_price))}</td><td>${esc(s.age ?? '—')}</td></tr>`;
  }));
  table('#recent', SIG_HEAD, OV.signals.map(signalRow)); bindRows('#recent');
}

async function showSignal(id) {
  const s = await api('/api/signals/' + id);
  const p = s.payload || {};
  let h = `<h2>الإشارة #${esc(s.id)} — ${esc(s.market)} ${esc(DUR[s.duration])}</h2>
    <dl class="kv"><dt>القرار</dt><dd>${badge(s.decision, DEC[s.decision])} ${s.candidate ? '(مرشح ' + esc(DEC[s.candidate]) + ')' : ''}</dd>
    <dt>النتيجة</dt><dd>${badge(s.status, STATUS[s.status])} ${s.void_reason ? esc(s.void_reason) : ''}</dd>
    <dt>الدخول → الانتهاء</dt><dd class="ltr">${esc(num(s.entry_price))} → ${esc(num(s.exit_price))}</dd>
    <dt>المصدر / الحالة</dt><dd>${esc(SRC[s.data_source] || '—')} / ${esc((STATE[s.data_state] || ['—'])[0])}</dd>
    <dt>الثقة</dt><dd>${pct(s.confidence)}</dd><dt>الوقت</dt><dd>${esc(fmtT(s.created_at))}</dd></dl>
    <h3>الأسباب</h3><ul class="reasons">${(s.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`;
  if (p.evidence) h += '<h3>أدلة الوكلاء المتخصصين</h3>' + evidenceGrid(p.evidence);
  if (p.agents) h += `<h3>فريق الوكلاء</h3><p class="small">${esc(p.agents.research?.summary || '')}<br>المخاطر: ${esc(p.agents.risk?.summary || '')}<br>النهائي: ${esc(p.agents.final?.reason || '')}</p>`;
  $('#dlg-body').innerHTML = h; $('#dlg').showModal();
}
function evidenceGrid(ev) {
  return '<div class="grid g3">' + Object.values(ev).map((e) => {
    const w = Math.round(Math.abs(e.score) * 50), col = e.score >= 0 ? 'var(--buy)' : 'var(--sell)';
    return `<div class="agent"><b>${esc(e.name_ar)}</b><div class="bar"><i data-w="${w}" data-c="${col}" data-s="${e.score >= 0 ? 1 : 0}"></i></div>
      <span class="small">${esc(e.score.toFixed(2))} — ${esc(e.facts.join('، '))}</span></div>`;
  }).join('') + '</div>';
}
// CSP forbids inline style attributes; size the evidence bars through the CSSOM.
new MutationObserver(() => $$('.bar i[data-w]').forEach((i) => {
  i.style.width = i.dataset.w + '%'; i.style.background = i.dataset.c;
  i.style.marginInlineStart = i.dataset.s === '1' ? '50%' : (50 - Number(i.dataset.w)) + '%'; i.removeAttribute('data-w');
})).observe(document.body, {childList: true, subtree: true});

// ---------------------------------------------------------------- views
async function loadSignals(reset) {
  if (reset) sigOffset = 0;
  const src = $('#sig-source').value;
  const rows = await api(`/api/signals?limit=50&offset=${sigOffset}` + (src ? '&source=' + src : ''));
  if (reset) table('#sig-table', SIG_HEAD, rows.map(signalRow));
  else $('#sig-table tbody').insertAdjacentHTML('beforeend', rows.map(signalRow).join(''));
  sigOffset += rows.length; bindRows('#sig-table');
}
$('#sig-source').addEventListener('change', () => loadSignals(true));
$('#sig-more').addEventListener('click', () => loadSignals(false));

async function loadAgents() {
  const a = await api('/api/agents');
  $('#llm-state').innerHTML = `${dot(a.llm.ok ? 'ok' : 'warn')} ${esc(a.llm.detail)}` +
    (a.llm.ok ? '' : '<div class="warnbox">بدون النموذج المحلي يعمل الفريق باستدلال حتمي على نفس الأدلة. لتفعيله: ثبّت Ollama ثم <span class="ltr">ollama pull qwen3.5:9b</span></div>');
  table('#runs', null, a.runs.map((r) => `<tr class="click" data-run="${esc(r.id)}"><td>${esc(r.id)}</td><td>${esc(r.market)}</td><td>${esc(DUR[r.duration])}</td>
    <td>${r.decision ? badge(r.decision, DEC[r.decision]) : (r.error ? badge('loss', 'خطأ') : badge('pending', 'يعمل'))}</td>
    <td>${!r.finished_at ? '—' : r.llm_used ? esc(r.llm_model) : 'حتمي'}</td><td>${r.finished_at ? esc((r.finished_at - r.started_at).toFixed(1)) : '—'}</td><td>${esc(fmtT(r.started_at))}</td></tr>`));
  $$('#runs tr.click').forEach((tr) => tr.addEventListener('click', () => showRun(tr.dataset.run, true)));
}
async function showRun(id, inline) {
  const r = await api('/api/agents/' + id), t = r.transcript || {};
  let h = `<h2>تشغيل الوكلاء #${esc(r.id)} — ${esc(r.market)} ${esc(DUR[r.duration])}</h2>`;
  if (r.error) h += `<div class="warnbox">${esc(r.error)}</div>`;
  h += '<h3>تقارير المحللين</h3><div class="grid g3">' + Object.values(t.reports || {}).map((x) => `<div class="agent"><b>${esc(x.name_ar)} ${badge(x.score > 0.1 ? 'BUY' : x.score < -0.1 ? 'SELL' : 'WAIT', x.score.toFixed(2))}</b>${esc(x.summary)}${x.disagreement ? `<div class="warnbox">${esc(x.disagreement)}</div>` : ''}</div>`).join('') + '</div>';
  h += `<h3>مناظرة المتفائل والمتشائم</h3><pre class="json">${esc((t.investment_debate_state || {}).history || '')}</pre>`;
  h += `<h3>مدير البحث</h3><p class="small">${esc(t.research?.summary || '')}</p>`;
  if (t.risk_debate_state?.history) h += `<h3>مناظرة المخاطر</h3><pre class="json">${esc(t.risk_debate_state.history)}</pre>`;
  h += `<h3>وكيل إدارة المخاطر</h3><p class="small">${esc(t.risk?.summary || '')}</p>`;
  h += `<h3>وكيل القرار النهائي</h3><p>${t.final ? badge(t.final.decision, DEC[t.final.decision]) : ''} ${esc(t.final?.reason || '')}</p>`;
  h += `<h3>سجل الاستدعاءات</h3><pre class="json">${esc(JSON.stringify(t.log || [], null, 1))}</pre>`;
  if (inline) $('#run-detail').innerHTML = h; else { $('#dlg-body').innerHTML = h; $('#dlg').showModal(); }
}

function summ(s) { return s && s.n ? `${pct(s.accuracy)} <span class="muted small">(${s.wins}/${s.n}، أدنى ${pct(s.wilson_lb)}${s.ev_per_unit != null ? `، عائد/وحدة ${s.ev_per_unit.toFixed(3)}` : ''})</span>` : '<span class="muted">—</span>'; }
async function loadPerf() {
  const [p, m, st] = await Promise.all([api('/api/performance'), api('/api/models'), api('/api/strategies')]);
  const o = p.overall_signals, c = p.overall_candidates;
  $('#perf-stats').innerHTML = [
    ['دقة الإشارات المنشورة', o.n ? pct(o.accuracy) : '—', `${o.n} نتيجة`],
    ['دقة كل الاتجاهات المرشحة', c.n ? pct(c.accuracy) : '—', `${c.n} نتيجة`],
    ['العائد المتوقع/وحدة (منشورة)', o.ev_per_unit == null ? '—' : o.ev_per_unit.toFixed(3), 'بعد احتساب العائد: ربح ← +العائد، خسارة ← −1'],
    ['نقطة التعادل', pct(p.breakeven), 'الدقة اللازمة لعدم الخسارة'],
    ['ملغاة / قيد الانتظار', `${p.void} / ${p.pending}`, 'ملغاة = لا يوجد سعر حقيقي عند الانتهاء'],
  ].map(([a, b, c2]) => `<div class="stat card"><span>${esc(a)}</span><b>${esc(b)}</b><span>${esc(c2)}</span></div>`).join('');
  table('#perf-table', ['السوق', 'المدة', 'المحرك', 'الإشارات', 'المرشحة'], p.by_market_duration.map((r) =>
    `<tr><td>${esc(r.market)}</td><td>${esc(DUR[r.duration])}</td><td>${r.engine === 'agents' ? 'الوكلاء' : 'سريع'}</td><td>${summ(r.signals)}</td><td>${summ(r.candidates)}</td></tr>`));
  table('#fail-table', ['البُعد', 'القيمة', 'الدقة', 'العدد', 'المتوسط العام'], p.failure_patterns.map((f) =>
    `<tr><td>${esc(f.dimension)}</td><td>${esc(f.value)}</td><td>${pct(f.accuracy)}</td><td>${esc(f.n)}</td><td>${pct(f.baseline)}</td></tr>`));
  const ST = {champion: 'بطل (مُستخدم)', candidate: 'مرشح', rejected: 'مرفوض', retired: 'متقاعد'};
  table('#models-table', ['#', 'السوق', 'المدة', 'الحالة', 'المصدر', 'دقة الاختبار', 'العتبة', 'عينات تدريب/اختبار', 'ملاحظة'], m.models.map((r) =>
    `<tr><td>${esc(r.id)}</td><td>${esc(r.market)}</td><td>${esc(DUR[r.duration])}</td><td>${badge(r.status === 'champion' ? 'win' : r.status === 'rejected' ? 'loss' : '', ST[r.status])}</td>
     <td>${esc(SRC[r.metrics.source] || '—')}</td><td>${pct(r.metrics.test_accuracy)}</td><td>${r.metrics.threshold == null ? 'لا تداول' : esc(r.metrics.threshold)}</td>
     <td>${esc(r.metrics.train_samples)} / ${esc(r.metrics.test_samples)}</td><td class="small">${esc(r.note || '')}${r.status === 'retired' && r.promoted_at && r.metrics.threshold != null ? ` <button class="btn ghost" data-rollback="${esc(r.id)}">استعادة</button>` : ''}</td></tr>`));
  $$('[data-rollback]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/api/models/${b.dataset.rollback}/rollback`, {method: 'POST'}); toast('تمت استعادة النموذج'); loadPerf(); } catch (e) { toast('خطأ: ' + e.message); }
  }));
  table('#strat-table', ['السوق', 'المدة', 'الاستراتيجية', 'الدقة', 'الحد الأدنى 95%', 'العدد'], st.map((r) =>
    `<tr><td>${esc(r.market)}</td><td>${esc(DUR[r.duration])}</td><td class="ltr">${esc(r.strategy)}</td><td>${pct(r.accuracy)}</td><td>${pct(r.wilson_lb)}</td><td>${esc(r.n)}</td></tr>`));
}
$('#retrain').addEventListener('click', async () => {
  toast('جارٍ التدريب والتحقق… قد يستغرق دقائق');
  try { const r = await api('/api/retrain', {method: 'POST'}); toast(`انتهى: ${r.results.length} مهمة`); loadPerf(); } catch (e) { toast('خطأ: ' + e.message); }
});

async function loadMonitor() {
  const c = await api('/api/monitor');
  if (!OV) await refresh();
  $('#mon-enabled').checked = c.enabled; $('#mon-agents').checked = c.agents; $('#mon-interval').value = c.interval;
  $('#mon-durs').innerHTML = OV.durations.map((d) => `<label><input type="checkbox" value="${d}" ${c.durations.includes(d) ? 'checked' : ''}> ${esc(DUR[d])}</label>`).join('');
  $('#mon-markets').innerHTML = OV.markets.map((m) => `<label><input type="checkbox" value="${esc(m.id)}" ${c.markets.includes(m.id) ? 'checked' : ''}> ${esc(m.name_ar || m.name)} ${dot(STATE[m.state][1])}</label>`).join('');
  $('#mon-hb').textContent = OV.health.monitor_heartbeat ? 'آخر دورة: ' + fmtT(OV.health.monitor_heartbeat) : '';
}
$('#mon-save').addEventListener('click', async () => {
  const c = await api('/api/monitor', {method: 'POST', body: {
    enabled: $('#mon-enabled').checked, agents: $('#mon-agents').checked, interval: Number($('#mon-interval').value),
    durations: $$('#mon-durs input:checked').map((i) => Number(i.value)), markets: $$('#mon-markets input:checked').map((i) => i.value)}});
  toast(c.enabled ? `المراقبة مفعّلة على ${c.markets.length} سوق` : 'المراقبة متوقفة');
});

async function loadStatus() {
  const [h, ev, mk] = await Promise.all([api('/api/health'), api('/api/events?limit=80'), api('/api/markets')]);
  const pv = h.providers || {};
  const card = (t, ok, body) => `<div class="card"><h2>${dot(ok)} ${esc(t)}</h2><div class="small">${body}</div></div>`;
  $('#status-cards').innerHTML =
    card('جسر ExpertOption', pv.expertoption?.proven ? 'ok' : 'bad', pv.expertoption ? `${pv.expertoption.proven ? '<b>متصل ✓ (بيانات حقيقية حديثة)</b>' : '<b>غير متصل</b>'}<br>${esc(pv.expertoption.detail)}<br>آخر بيانات قبل ${esc(pv.expertoption.last_data_age ?? '—')} ث · أخطاء: ${esc(pv.expertoption.errors)}` : 'لم يُرسل الجسر أي بيانات. بدونه لا توجد أسعار ExpertOption ولا OTC.') +
    card('Binance (مرجعي للعملات الرقمية)', pv.binance?.proven ? 'ok' : 'bad', pv.binance ? `${pv.binance.proven ? '<b>متصل ✓ (بيانات حقيقية حديثة)</b>' : '<b>غير متصل</b>'}<br>${esc(pv.binance.detail)}<br>آخر بيانات قبل ${esc(pv.binance.last_data_age ?? '—')} ث · إعادات اتصال: ${esc(pv.binance.reconnects)} · أخطاء: ${esc(pv.binance.errors)}` : 'غير مفعّل أو لم يتصل') +
    card('تقويم الأخبار', h.news?.ok ? 'ok' : 'warn', h.news?.ok ? `${esc(h.news.events)} حدث · آخر تحديث ${esc(fmtT(h.news.fetched_at))}` : esc(h.news?.error || 'غير متاح')) +
    card('التنبيهات', h.alerts.webhook_configured ? 'ok' : 'warn', h.alerts.webhook_configured ? `Webhook مفعّل · أُرسل ${esc(h.alerts.sent)} · فشل ${esc(h.alerts.failed)}` : 'التنبيهات تظهر هنا وفي السجل فقط. لإرسالها إلى جوالك اضبط EO_ALERT_WEBHOOK.') +
    card('النموذج اللغوي المحلي', h.llm.ok ? 'ok' : 'warn', `${esc(h.llm.model)}<br>${esc(h.llm.detail)}`) +
    card('الموارد', 'ok', `ذاكرة قصوى: ${esc(h.resources.max_rss_mb)} MB<br>قاعدة البيانات: ${esc(h.resources.db_mb)} MB<br>مساحة حرة: ${esc(h.resources.disk_free_mb)} MB`) +
    card('مدة التشغيل', h.status === 'ok' ? 'ok' : 'warn', `${esc(Math.round(h.uptime / 60))} دقيقة · الحالة ${esc(h.status)}`);
  table('#svc-table', null, Object.entries(h.services).map(([n, s]) => `<tr><td class="ltr">${esc(n)}</td><td>${dot(s.state === 'running' ? 'ok' : 'bad')} ${esc(s.state)}</td><td>${esc(s.restarts)}</td><td class="small">${esc(s.last_error || '')}</td></tr>`));
  table('#src-table', null, mk.flatMap((m) => m.sources.map((s) => `<tr><td>${esc(m.id)}</td><td>${esc(SRC[s.source] || s.source)}</td><td>${dot(STATE[s.state][1])} ${esc(STATE[s.state][0])}</td>
    <td>${esc(s.age ?? '—')}</td><td>${esc(s.accepted)}</td><td class="small">${esc(JSON.stringify(s.rejected))}</td><td>${esc(s.clock_offset ?? '—')}</td></tr>`)));
  const regs = mk.filter((m) => m.kind === 'regular' && m.reference_symbol);
  if (!$('#verify-market').options.length) $('#verify-market').innerHTML = regs.map((m) => `<option value="${esc(m.id)}">${esc(m.name_ar)} (${esc(m.reference_symbol)})</option>`).join('');
  const nw = await api('/api/news').catch(() => ({upcoming: []}));
  table('#news-table', null, nw.upcoming.map((e) => `<tr><td>${esc(fmtT(e.ts))}</td><td>${esc(e.currency)}</td><td class="ltr">${esc(e.title)}</td><td>${badge(e.impact === 'High' ? 'loss' : 'pending', e.impact === 'High' ? 'عالي' : 'متوسط')}</td><td>${esc(e.forecast)}</td><td>${esc(e.previous)}</td></tr>`));
  table('#events', null, ev.map((e) => `<tr><td>${esc(fmtT(e.ts))}</td><td>${badge(e.level === 'error' ? 'loss' : e.level === 'warning' ? 'pending' : '', e.level)}</td><td>${esc(e.kind)}</td><td class="small">${esc(e.message)}</td></tr>`));
}

async function loadSettings() {
  const [s, toks, mk] = await Promise.all([api('/api/settings'), api('/api/bridge/tokens'), api('/api/markets')]);
  $('#settings-json').textContent = JSON.stringify(s, null, 2);
  table('#tok-table', null, toks.map((t) => `<tr><td>${esc(t.id)}</td><td>${esc(t.label)}</td><td>${esc(fmtT(t.created_at))}</td><td>${esc(fmtT(t.last_used))}</td>
    <td>${t.revoked ? 'ملغى' : `<button class="btn ghost" data-revoke="${esc(t.id)}">إلغاء</button>`}</td></tr>`));
  $$('[data-revoke]').forEach((b) => b.addEventListener('click', async () => { await api(`/api/bridge/tokens/${b.dataset.revoke}/revoke`, {method: 'POST'}); loadSettings(); }));
  if (!OV.bridge_enabled) $('#tok-out').hidden = false, $('#tok-out').innerHTML = 'الجسر <b>معطّل</b>. شروط ExpertOption (البند 6.2) تحظر الروبوتات و«أي تدخل في الاتصال بين العميل والخادم» مع حظر الحساب ومصادرة الأموال. التفعيل قرارك: EO_BRIDGE_ENABLED=true في ‎.env‎ — راجع bridge/README.md.';
  $('#unknown-assets').textContent = (OV?.unknown_bridge_assets || []).join('، ') || 'لا يوجد';
  table('#mk-settings', null, mk.map((m) => `<tr><td>${esc(m.name_ar)} <span class="muted small ltr">${esc(m.id)}</span></td><td>${m.kind === 'otc' ? 'OTC' : 'عادي'}</td>
    <td class="ltr">${esc(m.reference_symbol || '—')}</td><td>${m.catalog_verified ? '✔' : '—'}</td>
    <td><input type="text" data-map="${esc(m.id)}" value="${esc(m.bridge_asset_id || '')}" size="10"></td>
    <td><input type="checkbox" data-en="${esc(m.id)}" ${m.enabled ? 'checked' : ''}></td></tr>`));
  $$('[data-map]').forEach((i) => i.addEventListener('change', () => api('/api/markets/' + i.dataset.map, {method: 'POST', body: {bridge_asset_id: i.value}}).then(() => toast('حُفظ'))));
  $$('[data-en]').forEach((i) => i.addEventListener('change', () => api('/api/markets/' + i.dataset.en, {method: 'POST', body: {enabled: i.checked}}).then(() => toast('حُفظ'))));
}
$('#tok-new').addEventListener('click', async () => {
  const r = await api('/api/bridge/tokens', {method: 'POST', body: {label: $('#tok-label').value}});
  const o = $('#tok-out'); o.hidden = false;
  o.innerHTML = `رمز الجسر (يظهر مرة واحدة): <code class="ltr">${esc(r.token)}</code>`;
  loadSettings();
});

$('#verify-btn').addEventListener('click', async () => {
  const out = $('#verify-out'); out.textContent = 'جارٍ التحقق من المصدر…';
  try {
    const r = await api('/api/verify/' + encodeURIComponent($('#verify-market').value));
    const ok = r.compared > 0 && r.match_rate === 1;
    out.innerHTML = `<div class="${ok ? 'okbox' : 'warnbox'}">قورنت ${esc(r.compared)} ثانية مع ${esc(r.symbol)} من Binance نفسه: تطابق تام في ${esc(r.exact_matches)} (${pct(r.match_rate)}). ناقصة لدينا: ${esc(r.missing_in_ours)}.${r.examples_of_mismatch.length ? ' أمثلة اختلاف: ' + esc(JSON.stringify(r.examples_of_mismatch)) : ''}</div>`;
  } catch (e) { out.innerHTML = `<div class="warnbox">${esc(e.message)}</div>`; }
});

// ---------------------------------------------------------------- AUTO
async function loadAuto() {
  const [b, ex] = await Promise.all([api('/api/auto/board'), api('/api/execution')]);
  $('#auto-on').checked = ex.config.auto_enabled;
  $('#auto-why').textContent = b.why || '';
  $('#auto-at').textContent = b.at ? 'آخر مسح: ' + fmtTime(b.at) + ` · ${b.evaluated ?? 0} تقييم` : '';
  const c = b.chosen;
  $('#auto-chosen').innerHTML = c ? `<div class="okbox"><b>الفرصة المختارة:</b> ${esc(c.market_name_ar)} · ${badge(c.decision, DEC[c.decision])} · ${esc(DUR[c.duration])} · ثقة مُتحققة ${pct(c.confidence)}<br>${esc(c.auto_choice?.why)}<br>التوقيت: ${esc(c.auto_choice?.timing)}<br>التنفيذ: ${esc(JSON.stringify(b.execution || {}))}</div>` : '';
  table('#auto-table', ['السوق', 'المدة', 'القرار', 'المرشح', 'الثقة', 'العائد المتوقع المتحفظ', 'المصدر', 'السبب الأول'], (b.rows || []).map((r) =>
    `<tr><td>${esc(r.market_name_ar)} ${r.kind === 'otc' ? badge('', 'OTC') : ''}</td><td>${esc(DUR[r.duration])}</td><td>${badge(r.decision, DEC[r.decision])}</td>
     <td>${r.candidate ? esc(DEC[r.candidate]) : '—'}</td><td>${pct(r.confidence)}</td><td>${r.edge_lb == null ? '—' : esc(r.edge_lb.toFixed(3))}</td>
     <td>${esc(SRC[r.data_source] || '—')}</td><td class="small">${esc(r.why)}</td></tr>`));
}
$('#auto-on').addEventListener('change', async (e) => {
  try { await api('/api/execution/config', {method: 'POST', body: {auto_enabled: e.target.checked}}); toast(e.target.checked ? 'AUTO مفعّل' : 'AUTO متوقف'); }
  catch (err) { toast('خطأ: ' + err.message); e.target.checked = !e.target.checked; }
});

// ---------------------------------------------------------------- EXECUTION
const RISK_FIELDS = [['stake', 'مبلغ الصفقة'], ['max_stake', 'الحد الأقصى للمبلغ'], ['max_stake_pct', 'أقصى % من الرصيد'],
  ['max_daily_loss', 'حد الخسارة اليومي'], ['max_consecutive_losses', 'حد الخسائر المتتالية'], ['max_open', 'أقصى صفقات مفتوحة'],
  ['max_trades_per_hour', 'أقصى صفقات/ساعة'], ['cooldown_s', 'تهدئة لكل سوق (ث)'], ['min_edge', 'أدنى عائد متوقع متحفظ'],
  ['max_signal_age_s', 'أقصى عمر للإشارة (ث)'], ['paper_initial_balance', 'رصيد التجريبي الابتدائي']];
const ORDER_ST = {risk_rejected: 'رفض المخاطر', submitted: 'مُرسل', confirmed: 'مؤكد', rejected: 'رفض الوسيط', settled: 'مُسوّى'};
function orderRow(o) {
  return `<tr><td>${esc(o.id)}</td><td>${esc(fmtTime(o.created_at))}</td><td>${o.mode === 'paper' ? 'تجريبي' : esc(o.mode)}</td><td>${esc(o.market)}</td><td>${esc(DUR[o.duration])}</td>
    <td>${badge(o.direction, DEC[o.direction])}</td><td>${esc(o.stake)}</td><td>${badge(o.status === 'settled' ? o.result : o.status === 'confirmed' ? 'pending' : 'void', ORDER_ST[o.status] || o.status)}</td>
    <td class="ltr">${esc(num(o.entry_price))} → ${esc(num(o.exit_price))}</td><td>${o.result ? badge(o.result, STATUS[o.result]) : '—'}</td><td>${o.pnl == null ? '—' : esc(o.pnl.toFixed(2))}</td>
    <td class="small">${esc(o.broker_ref || '')} ${esc(o.reason || '')}</td></tr>`;
}
const ORDER_HEAD = ['#', 'الوقت', 'الوضع', 'السوق', 'المدة', 'الاتجاه', 'المبلغ', 'الحالة', 'الدخول → الانتهاء', 'النتيجة', 'الربح/الخسارة', 'مرجع/سبب'];
async function loadExec() {
  const [ex, open, all, lg] = await Promise.all([api('/api/execution'), api('/api/orders?status=open'), api('/api/orders?limit=100'), api('/api/execution/log?limit=80')]);
  $$('#mode-seg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === ex.config.mode));
  $('#brokers').innerHTML = ex.brokers.map((b) => `<div class="${b.available ? 'okbox' : 'warnbox'}"><b>${b.name === 'paper' ? 'الوسيط التجريبي' : 'ExpertOption (حقيقي)'}:</b> ${esc(b.detail)}${b.terms_url ? ` <a href="${esc(b.terms_url)}" target="_blank" rel="noopener">الشروط</a>` : ''}</div>`).join('');
  const st = ex.state;
  $('#exec-state').innerHTML = (st.kill_switch ? '<div class="warnbox">⛔ الإيقاف الطارئ مفعّل</div>' : '') + (st.halted ? `<div class="warnbox">التداول موقوف: ${esc(st.halt_reason)}</div>` : '');
  if (!$('#risk-form').dataset.filled || document.activeElement?.closest('#risk-form') == null) {
    $('#risk-form').innerHTML = RISK_FIELDS.map(([k, l]) => `<label>${esc(l)}<input type="number" step="any" min="0" name="${k}" value="${esc(ex.config[k])}"></label>`).join('');
    $('#risk-form').dataset.filled = '1';
  }
  const s2 = ex.stats;
  $('#exec-stats').innerHTML = [
    ['رصيد تجريبي', st.paper_balance.toFixed(2), 'ليس مالًا حقيقيًا'],
    ['صافي الربح/الخسارة', s2.net_pnl, `اليوم ${s2.today_pnl} · أقصى تراجع ${s2.max_drawdown}`],
    ['نسبة النجاح الفعلية', s2.win_rate == null ? '—' : pct(s2.win_rate), s2.settled ? `${s2.wins} ربح / ${s2.losses} خسارة` : 'لا توجد صفقات مُسوّاة بعد'],
    ['معامل الربح', s2.profit_factor ?? '—', `خسائر متتالية: ${s2.consecutive_losses} · مفتوحة: ${s2.open}`],
  ].map(([a, b, c]) => `<div class="stat card"><span>${esc(a)}</span><b>${esc(b)}</b><span>${esc(c)}</span></div>`).join('');
  table('#open-orders', ORDER_HEAD, open.map(orderRow));
  table('#closed-orders', ORDER_HEAD, all.filter((o) => !['submitted', 'confirmed'].includes(o.status)).map(orderRow));
  table('#exec-log', null, lg.map((r) => `<tr><td>${esc(fmtT(r.ts))}</td><td>${esc(r.order_id ?? '—')}</td><td class="ltr">${esc(r.event)}</td><td class="small">${esc(typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail))}</td></tr>`));
}
$$('#mode-seg button').forEach((b) => b.addEventListener('click', async () => {
  if (b.disabled) return;
  try { await api('/api/execution/config', {method: 'POST', body: {mode: b.dataset.mode}}); toast('تم تغيير الوضع'); loadExec(); refresh(); } catch (e) { toast('خطأ: ' + e.message); }
}));
$('#risk-save').addEventListener('click', async () => {
  const body = {}; $$('#risk-form input').forEach((i) => { body[i.name] = Number(i.value); });
  try { await api('/api/execution/config', {method: 'POST', body}); toast('حُفظت إعدادات المخاطر'); $('#risk-form').dataset.filled = ''; loadExec(); } catch (e) { toast('خطأ: ' + e.message); }
});
$('#kill').addEventListener('click', async () => { await api('/api/execution/kill', {method: 'POST'}); toast('⛔ تم الإيقاف الطارئ'); loadExec(); refresh(); });
$('#resume').addEventListener('click', async () => { await api('/api/execution/resume', {method: 'POST'}); toast('تم الاستئناف'); loadExec(); refresh(); });
$('#reset-paper').addEventListener('click', async () => { await api('/api/execution/reset-paper', {method: 'POST'}); toast('أُعيد رصيد التجريبي'); loadExec(); });

// ---------------------------------------------------------------- boot
(async () => {
  const me = await api('/api/me'); CSRF = me.csrf;
  await refresh(); loadChart();
  setInterval(refresh, 3000);
  setInterval(() => { if ($('#v-auto').classList.contains('active')) loadAuto(); if ($('#v-exec').classList.contains('active') && !document.activeElement?.closest('#risk-form')) loadExec(); }, 4000);
  setInterval(() => { if ($('#v-dash').classList.contains('active')) loadChart(); }, 5000);
})();
