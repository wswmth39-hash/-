// ==UserScript==
// @name         ExpertOption → local AI platform bridge (read-only)
// @namespace    eoplatform
// @version      1.0.0
// @description  Passively reads the quotes your own ExpertOption page already receives and forwards them to YOUR local analysis server. Never sends anything to ExpertOption, never trades, never reads balance/account data.
// @match        https://expertoption.com/*
// @match        https://*.expertoption.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

/*
 * IMPORTANT — what is and is not verified
 * ---------------------------------------
 * ExpertOption has no documented public API, and its private WebSocket message format could not be
 * inspected from the environment this was built in. The tick extractor below is therefore a
 * HEURISTIC that looks for {asset, price, time}-shaped objects. Before trusting any data:
 *   1. Run "Discovery" from the Tampermonkey menu for 2–3 minutes while switching assets.
 *   2. Export the report (it contains message NAMES and SHAPES only — never values of
 *      account-related messages) and check which messages carry quotes.
 *   3. Compare the "last price" on the dashboard with the price shown on your chart.
 * If they do not match, adjust EXTRACT below (or share the discovery report to get it adjusted).
 *
 * Safety properties (enforced in code below):
 *   - The page's WebSocket is wrapped to ADD a 'message' listener only. send() is not touched.
 *   - Any message containing account-like keys is dropped before any processing.
 *   - Data goes only to the server URL you configure (127.0.0.1/localhost by @connect).
 */
(function () {
  'use strict';
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  if (W.__eoBridgeInstalled) return;            // double-injection guard
  W.__eoBridgeInstalled = true;

  const cfg = {
    server: GM_getValue('server', 'http://127.0.0.1:8000'),
    token: GM_getValue('token', ''),
  };
  const SENSITIVE = /balance|email|mail|token|session|password|passwd|phone|account|user_?id|profile|card|wallet|deposit|withdraw|auth|secret|key/i;
  const ASSET_KEYS = ['asset', 'assetId', 'asset_id', 'symbol', 'pair', 'instrument'];
  const PRICE_KEYS = ['price', 'rate', 'value', 'quote', 'close', 'bid'];
  const TIME_KEYS = ['time', 'timestamp', 'ts', 't', 'created_at', 'date'];

  const names = {};          // platform asset id -> display name (learned from asset-list messages)
  const queue = {};          // asset key -> [[ts, price], ...]
  const stats = {msgs: 0, ticks: 0, sent: 0, lastErr: '', lastOk: 0, dropped_sensitive: 0};
  let discovery = null;      // {until, events: {name: {count, shapes:Set}}}

  function hasSensitive(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 6) return false;
    for (const k of Object.keys(obj)) {
      if (SENSITIVE.test(k)) return true;
      if (hasSensitive(obj[k], depth + 1)) return true;
    }
    return false;
  }
  function shape(v, d = 0) {
    if (Array.isArray(v)) return d > 3 ? '[…]' : '[' + (v.length ? shape(v[0], d + 1) : '') + ']x' + v.length;
    if (v && typeof v === 'object') return d > 3 ? '{…}' : '{' + Object.keys(v).slice(0, 15).map((k) => k + ':' + shape(v[k], d + 1)).join(',') + '}';
    return typeof v;
  }
  function pick(o, keys) { for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]; return undefined; }
  function toSec(t) {
    t = Number(t);
    if (!isFinite(t)) return null;
    if (t > 1e14) return t / 1e6; if (t > 1e11) return t / 1e3;   // µs / ms → s
    return t;
  }

  // Learn id→name from any object that looks like an asset descriptor.
  function learnNames(o) {
    if (o && typeof o === 'object' && (o.id !== undefined) && typeof (o.name || o.symbol) === 'string' && !('price' in o)) {
      names[String(o.id)] = String(o.symbol || o.name);
    }
  }

  // HEURISTIC extractor (see header). Walks the JSON and emits ticks for {asset, price, time} objects.
  function EXTRACT(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (Array.isArray(node)) { node.forEach((x) => EXTRACT(x, depth + 1)); return; }
    learnNames(node);
    const a = pick(node, ASSET_KEYS), p = pick(node, PRICE_KEYS), t = pick(node, TIME_KEYS);
    if (a !== undefined && typeof p !== 'object' && t !== undefined) {
      const price = Number(p), ts = toSec(t);
      if (isFinite(price) && price > 0 && ts) {
        const key = String(a);
        (queue[key] = queue[key] || []).push([ts, price]);
        stats.ticks++;
      }
    }
    for (const k of Object.keys(node)) if (node[k] && typeof node[k] === 'object') EXTRACT(node[k], depth + 1);
  }

  function onMessage(ev) {
    try {
      if (typeof ev.data !== 'string') return;           // binary frames ignored
      const raw = ev.data.replace(/^\d+/, '');            // tolerate socket.io-style numeric prefixes
      if (!raw || (raw[0] !== '{' && raw[0] !== '[')) return;
      const msg = JSON.parse(raw);
      stats.msgs++;
      const name = (msg && (msg.action || msg.event || msg.type || (Array.isArray(msg) && typeof msg[0] === 'string' && msg[0]))) || '?';
      const sensitive = hasSensitive(msg);
      if (discovery && Date.now() < discovery.until) {
        const e = discovery.events[name] = discovery.events[name] || {count: 0, shapes: new Set(), sensitive: false};
        e.count++; e.sensitive = e.sensitive || sensitive;
        if (e.shapes.size < 3) e.shapes.add(sensitive ? '(shape withheld: account-like keys)' : shape(msg).slice(0, 600));
      }
      if (sensitive) { stats.dropped_sensitive++; return; }
      EXTRACT(msg);
    } catch (e) { /* non-JSON or malformed: ignore */ }
  }

  // Wrap WebSocket: add a read-only listener. We never call or wrap send().
  const NativeWS = W.WebSocket;
  function WrappedWS(url, protocols) {
    const ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
    try { ws.addEventListener('message', onMessage); } catch (e) {}
    return ws;
  }
  WrappedWS.prototype = NativeWS.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) WrappedWS[k] = NativeWS[k];
  W.WebSocket = WrappedWS;

  function flush() {
    const assets = Object.keys(queue).filter((k) => queue[k].length).map((k) => {
      const nm = names[k] || k;
      return {asset: nm, otc: /otc/i.test(nm) ? true : null, ticks: queue[k].splice(0, 2000)};
    });
    if (!assets.length || !cfg.token) return;
    GM_xmlhttpRequest({
      method: 'POST', url: cfg.server.replace(/\/$/, '') + '/api/bridge/ingest', timeout: 5000,
      headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.token},
      data: JSON.stringify({client: 'eo-bridge/1.0.0', assets}),
      onload: (r) => { if (r.status === 200) { stats.sent++; stats.lastOk = Date.now(); stats.lastErr = ''; } else stats.lastErr = 'HTTP ' + r.status; },
      onerror: () => { stats.lastErr = 'server unreachable'; },
      ontimeout: () => { stats.lastErr = 'timeout'; },
    });
  }
  setInterval(flush, 1000);

  // Small read-only status badge (no interaction with the platform UI).
  function badge() {
    let b = document.getElementById('eo-bridge-badge');
    if (!b) {
      if (!document.body) return;
      b = document.createElement('div'); b.id = 'eo-bridge-badge';
      Object.assign(b.style, {position: 'fixed', bottom: '6px', left: '6px', zIndex: 2147483647, background: 'rgba(0,0,0,.7)',
        color: '#fff', font: '11px sans-serif', padding: '3px 7px', borderRadius: '6px', pointerEvents: 'none'});
      document.body.appendChild(b);
    }
    const ok = stats.lastOk && Date.now() - stats.lastOk < 5000;
    b.textContent = `جسر AI: ${!cfg.token ? 'لا يوجد رمز' : ok ? 'يرسل ✓' : (stats.lastErr || 'بانتظار الأسعار')} · رسائل ${stats.msgs} · تيكات ${stats.ticks}` + (discovery && Date.now() < discovery.until ? ' · استكشاف…' : '');
  }
  setInterval(badge, 1000);

  GM_registerMenuCommand('Set server URL', () => { const v = prompt('Server URL', cfg.server); if (v) { cfg.server = v; GM_setValue('server', v); } });
  GM_registerMenuCommand('Set bridge token', () => { const v = prompt('Bridge token (from dashboard → Settings)', ''); if (v) { cfg.token = v.trim(); GM_setValue('token', cfg.token); } });
  GM_registerMenuCommand('Start discovery (3 min)', () => { discovery = {until: Date.now() + 180000, events: {}}; });
  GM_registerMenuCommand('Export discovery report', () => {
    if (!discovery) return alert('Run discovery first');
    const rep = {generated: new Date().toISOString(), host: location.host, stats, known_asset_names: names,
      events: Object.fromEntries(Object.entries(discovery.events).map(([k, v]) => [k, {count: v.count, sensitive: v.sensitive, shapes: [...v.shapes]}]))};
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(rep, null, 2)], {type: 'application/json'}));
    a.download = 'eo-discovery.json'; a.click();
  });
})();
