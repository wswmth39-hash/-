'use strict';
// طبقة المنصة — اعتراض WebSocket الصفحة للقراءة فقط وترجمة رسائلها إلى أوامر المحرك.
// - لا نعترض send ولا نرسل شيئًا إطلاقًا، ولا نفتح أي اتصال خاص بنا.
// - حالة مستقلة لكل اتصال: الحدث الثنائي المنتظر لمرفقاته، وطابور ترتيب الرسائل. (v3.6 كانت حالة expect مشتركة
//   بين كل الاتصالات، فإطار ثنائي من اتصال قد يُفسَّر بحدث من اتصال آخر.)
// - التحليل وفق بروتوكول Socket.IO (core/sio.js) مع أي عدد من المرفقات الثنائية وnamespace وack.
// - أي فشل في التحليل يُسجَّل (لا يُبتلع بصمت).
// - حارس من التركيب المزدوج: لو حُقن السكربت مرتين لا يُلَف WebSocket مرتين ولا تتكرر المستمعات.
const { parseText, fillPlaceholders, eventName } = require('../core/sio');
const { hostOf, skeleton } = require('./discovery');
const WS_GRACE_MS = 3000; // مهلة قبل اعتبار الانقطاع حقيقيًا (إعادة اتصال المنصة العادية تستغرق ثوانٍ قليلة)
const TAP = '__wsnfTap';

// الأحداث التي نقرؤها. أسماؤها وصيغها موثّقة في الهندسة العكسية المنشورة لمكتبة lordralinc/pocket_option
// (reverse/on_events.md): updateStream = [[asset, time, price]]، updateHistoryNew* = { asset, history: [[time, price]] }،
// successauth / NotAuthorized، updateAssets = صفوف [id, asset, label, …]. لا نخترع أي حدث آخر.
const KNOWN = [
  { test: n => n === 'updateStream', kind: 'stream' },
  { test: n => /^updateHistoryNew/.test(n), kind: 'hist' },
  { test: n => n === 'successauth', kind: 'auth' },
  { test: n => n === 'NotAuthorized', kind: 'notauth' },
  { test: n => n === 'updateAssets', kind: 'assets' }
];

// ترجمة حدث إلى استدعاءات المحرك (مكشوفة للاختبارات باسم handle)
function createHandler(E) {
  const [ingestTicks, ingestHistory, onAuth, onAssets, logErr] = E.use('ingestTicks', 'ingestHistory', 'onAuth', 'onAssets', 'logErr');
  return function handle(kind, j, connId) {
    try {
      if (kind === 'stream') ingestTicks(connId || 0, j);
      if (kind === 'hist' && j && j.asset && Array.isArray(j.history)) ingestHistory(connId || 0, j.asset, j.history);
      if (kind === 'auth') onAuth(connId || 0, true);
      if (kind === 'notauth') onAuth(connId || 0, false);
      if (kind === 'assets') onAssets(connId || 0, j);
    } catch (e) { E.S.loading = false; logErr('HANDLE', String(e && e.message || e)); }
  };
}

// تركيب الاعتراض على win.WebSocket. timers: { setTimeout, clearTimeout }. discovery: أداة الاستكشاف (اختيارية).
function installSocketTap(win, E, handle, timers, discovery) {
  const [connCreated, connOpened, connClosed, onMessage, onEvent, parseError, onWsDown, logErr, onOutgoing, onUnpaired] =
    E.use('connCreated', 'connOpened', 'connClosed', 'onMessage', 'onEvent', 'parseError', 'onWsDown', 'logErr', 'onOutgoing', 'onUnpaired');
  const NativeWS = win.WebSocket;
  if (!NativeWS) return false;
  if (NativeWS[TAP]) return false; // مركّب مسبقًا
  const decoder = new TextDecoder();
  const toText = d => (win.Blob && d instanceof win.Blob) ? d.text() : Promise.resolve(decoder.decode(d instanceof ArrayBuffer ? new Uint8Array(d) : d));
  const live = new Set();
  let downTimer = null;

  function dispatch(c, data, binary) {
    const name = eventName(data);
    if (!name) { parseError(c.id, 'حدث بلا اسم'); return; }
    if (discovery) discovery.observe(name, data.slice(1), { binary });
    const k = KNOWN.find(x => x.test(name));
    onEvent(c.id, name, !!k);
    if (k) handle(k.kind, data[1], c.id);
  }
  function onText(c, s) {
    const m = parseText(s);
    if (discovery) discovery.frame(m.sio ? 'sio:' + m.sio : 'eio:' + m.eio);
    if (m.error) { parseError(c.id, m.error + ' — ' + s.slice(0, 40)); return; }
    if (m.eio !== 'message') return;
    if (m.sio === 'event' || (m.sio === 'binary_event' && !m.attachments)) { if (m.data !== undefined) dispatch(c, m.data, false); return; }
    if (m.sio === 'binary_event') {
      if (c.pend) parseError(c.id, 'حدث ثنائي جديد قبل اكتمال مرفقات السابق (' + c.pend.atts.length + '/' + c.pend.need + ')');
      c.pend = { data: m.data, need: m.attachments, atts: [] };
    }
  }
  function onBinaryText(c, t) {
    if (!c.pend) {
      // ليس بالضرورة خطأ: نعدّه ونحفظ بنيته فقط (بلا قيم) لمعرفة ما ترسله المنصة بهذه الطريقة
      let sk = 'نص غير JSON';
      try { sk = skeleton(JSON.parse(t)); } catch (e) {}
      onUnpaired(c.id, sk);
      if (discovery) discovery.frame('binary:unpaired');
      return;
    }
    let v;
    try { v = JSON.parse(t); } catch (e) { parseError(c.id, 'مرفق ثنائي ليس JSON: ' + String(e && e.message || e).slice(0, 60)); c.pend = null; return; }
    c.pend.atts.push(v);
    if (c.pend.atts.length < c.pend.need) return;
    const p = c.pend; c.pend = null;
    let data;
    try { data = fillPlaceholders(p.data, p.atts); } catch (e) { parseError(c.id, String(e && e.message || e)); return; }
    dispatch(c, data, true);
  }
  function observeOut(c, data) {
    if (typeof data !== 'string') return;
    const m = parseText(data);
    if (m.eio !== 'message' || (m.sio !== 'event' && m.sio !== 'binary_event')) return;
    const name = eventName(m.data);
    if (name) onOutgoing(c.id, name, Array.isArray(m.data) ? m.data[1] : undefined);
  }
  // الترتيب داخل الاتصال الواحد محفوظ: النص الذي يصل أثناء فك إطار ثنائي ينتظر دوره
  function onMsg(c, ev) {
    const d = ev.data, bytes = typeof d === 'string' ? d.length : (d && (d.byteLength || d.size)) || 0;
    onMessage(c.id, bytes);
    if (typeof d === 'string') {
      if (!c.busy) { onText(c, d); return; }
      c.q = c.q.then(() => onText(c, d));
      return;
    }
    c.busy++;
    c.q = c.q.then(() => toText(d)).then(t => onBinaryText(c, t))
      .catch(e => parseError(c.id, 'فك إطار ثنائي: ' + String(e && e.message || e)))
      .then(() => { c.busy--; });
  }

  const Tapped = function (url, proto) {
    const ws = proto !== undefined ? new NativeWS(url, proto) : new NativeWS(url);
    const c = { id: connCreated(hostOf(url)), pend: null, q: Promise.resolve(), busy: 0 }; // المضيف فقط، بلا مسار ولا معاملات
    try { if (discovery) discovery.host(url); } catch (e) {}
    // مراقبة سلبية لما ترسله المنصة نفسها (اسم الحدث، وأصل/مدة الاشتراك فقط). شفافة تمامًا: نفس الوسائط ونفس القيمة المعادة،
    // ولا تمنع ولا تؤخر ولا تُنشئ أي رسالة. البوت نفسه لا يرسل شيئًا.
    const nativeSend = ws.send;
    if (typeof nativeSend === 'function') {
      ws.send = function (data) {
        try { observeOut(c, data); } catch (e) {}
        return nativeSend.apply(this, arguments);
      };
    }
    ws.addEventListener('message', ev => { try { onMsg(c, ev); } catch (e) { parseError(c.id, 'معالجة رسالة: ' + String(e && e.message || e)); } });
    ws.addEventListener('open', () => {
      live.add(ws);
      connOpened(c.id);
      if (downTimer) { timers.clearTimeout(downTimer); downTimer = null; } // رجع الاتصال خلال المهلة: لا انقطاع فعلي
    });
    ws.addEventListener('close', () => {
      c.pend = null; // لا نفسّر مرفقات قادمة من اتصال مغلق
      const wasLive = live.delete(ws);
      const last = connClosed(c.id);
      if (!wasLive || !last) return;    // فشل قبل أن يفتح، أو ما زال اتصال آخر حيًا
      if (downTimer) return;            // الانقطاع مسجَّل قيد المهلة أصلًا
      downTimer = timers.setTimeout(() => { // لا نسجّل خطأ ولا نُلغي صفقة إلا لو طال الانقطاع
        downTimer = null;
        if (live.size) return;
        logErr('WS_DOWN', 'انقطع اتصال WebSocket');
        onWsDown();
      }, WS_GRACE_MS);
    });
    return ws; // لا نعترض send ولا نرسل شيئًا
  };
  Tapped.prototype = NativeWS.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(k => { Tapped[k] = NativeWS[k]; });
  Object.defineProperty(Tapped, TAP, { value: true });
  win.WebSocket = Tapped;
  return true;
}
module.exports = { createHandler, installSocketTap, WS_GRACE_MS, KNOWN };
