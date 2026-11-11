'use strict';
// طبقة المنصة — «استكشاف بيانات المنصة»: أداة تشخيص يشغّلها المستخدم على صفحته الحقيقية لمعرفة ما ترسله المنصة فعلًا،
// بدل تخمين أسماء الأحداث وصيغها. تعمل فقط عند تفعيلها يدويًا، ولمدة محدودة، وتسجّل:
//   - أسماء الأحداث وعددها وهل وصلت كنص أو كمرفق ثنائي
//   - «هيكل» كل حدث: الأنواع والمفاتيح وأطوال المصفوفات فقط، دون القيم
//   - عيّنات قيم مختصرة فقط لأحداث يبدو اسمها سوقيًا وليس في هيكلها أي مفتاح حساس
//   - مضيف اتصال WebSocket فقط (بلا مسار ولا معاملات: قد تحوي رموز جلسة)
// لا تسجّل أبدًا قيم أي حدث فيه مفتاح يوحي بالحساب أو الهوية (رصيد، بريد، مستخدم، رمز، جلسة، ...). الرسائل الصادرة لا تُعترض أصلًا.

const SENSITIVE = /(bal|amount|sum|email|mail|user|login|token|auth|pass|session|sid|uid|phone|account|wallet|deposit|withdraw|card|\bip\b|country|currency|profit|bonus|demo|real|name|secret|key|hash|cookie)/i;
const MARKET = /(stream|history|candle|tick|quote|price|chart|period|ohlc)/i;

function skeleton(v, depth = 0) {
  if (depth > 5) return '…';
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? ['arr', v.length, skeleton(v[0], depth + 1)] : ['arr', 0];
  const t = typeof v;
  if (t === 'number') return 'num';
  if (t === 'string') return 'str';
  if (t === 'boolean') return 'bool';
  if (t === 'object') {
    const o = {};
    Object.keys(v).slice(0, 40).forEach(k => { o[k] = skeleton(v[k], depth + 1); });
    return o;
  }
  return t;
}
function sensitiveKeys(sk, out = []) {
  if (Array.isArray(sk)) { if (sk[2] !== undefined) sensitiveKeys(sk[2], out); return out; }
  if (sk && typeof sk === 'object') for (const k in sk) { if (SENSITIVE.test(k)) out.push(k); sensitiveKeys(sk[k], out); }
  return out;
}
// عيّنة مختصرة: الأرقام كما هي، النصوص فقط إن بدت رمز أصل، أول 5 عناصر من كل مصفوفة
function sample(v, depth = 0) {
  if (depth > 4) return '…';
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return /^[A-Za-z0-9_#.\-\/ ]{1,24}$/.test(v) ? v : '<نص:' + v.length + '>';
  if (Array.isArray(v)) { const a = v.slice(0, 5).map(x => sample(x, depth + 1)); if (v.length > 5) a.push('…(+' + (v.length - 5) + ')'); return a; }
  if (typeof v === 'object') { const o = {}; Object.keys(v).slice(0, 20).forEach(k => { o[k] = SENSITIVE.test(k) ? '<محجوب>' : sample(v[k], depth + 1); }); return o; }
  return '<' + typeof v + '>';
}
const hostOf = url => { try { return new URL(String(url)).host; } catch (e) { return '<غير معروف>'; } };

function createDiscovery({ clock, maxMs = 10 * 60e3, maxMsgs = 20000, maxEvents = 150 } = {}) {
  const D = { on: false, startedAt: 0, stoppedAt: 0, why: '', msgs: 0, events: {}, frames: {}, hosts: {} };
  const stop = why => { if (D.on) { D.on = false; D.stoppedAt = clock(); D.why = why || 'إيقاف يدوي'; } };
  return {
    start() { Object.assign(D, { on: true, startedAt: clock(), stoppedAt: 0, why: '', msgs: 0, events: {}, frames: {}, hosts: {} }); },
    stop,
    get on() { return D.on; },
    host(url) { if (D.on) { const h = hostOf(url); D.hosts[h] = (D.hosts[h] || 0) + 1; } },
    frame(kind) { if (D.on) D.frames[kind] = (D.frames[kind] || 0) + 1; },
    observe(name, args, meta = {}) {
      if (!D.on) return;
      if (clock() - D.startedAt > maxMs) return stop('انتهت المدة (' + Math.round(maxMs / 60000) + ' د)');
      if (++D.msgs > maxMsgs) return stop('بلغ الحد (' + maxMsgs + ' رسالة)');
      const key = String(name).slice(0, 60);
      let ev = D.events[key];
      if (!ev) { if (Object.keys(D.events).length >= maxEvents) return; ev = D.events[key] = { n: 0, binary: 0, firstAt: clock(), lastAt: 0, skeletons: [], samples: [], sensitive: [] }; }
      ev.n++; ev.lastAt = clock(); if (meta.binary) ev.binary++;
      const sk = skeleton(args), sj = JSON.stringify(sk);
      if (ev.skeletons.length < 3 && !ev.skeletons.includes(sj)) ev.skeletons.push(sj);
      const sens = sensitiveKeys(sk);
      sens.forEach(k => { if (!ev.sensitive.includes(k) && ev.sensitive.length < 20) ev.sensitive.push(k); });
      if (!sens.length && MARKET.test(key) && ev.samples.length < 3) ev.samples.push(sample(args));
    },
    report(extra = {}) {
      return {
        type: 'wsnf-platform-discovery', schema: 1, startedAt: D.startedAt ? new Date(D.startedAt).toISOString() : null,
        durationS: D.startedAt ? Math.round(((D.on ? clock() : D.stoppedAt) - D.startedAt) / 1000) : 0, running: D.on, stopReason: D.why,
        note: 'أسماء الأحداث وهياكلها فقط. لا قيم لأي حدث فيه مفتاح حساس، ولا رسائل صادرة، ولا عناوين كاملة. راجع الملف قبل مشاركته.',
        messages: D.msgs, hosts: { ...D.hosts }, frames: { ...D.frames },
        events: Object.fromEntries(Object.entries(D.events).sort((a, b) => b[1].n - a[1].n).map(([k, e]) => [k, { ...e, skeletons: e.skeletons.map(s => JSON.parse(s)) }])),
        ...extra
      };
    }
  };
}
module.exports = { createDiscovery, skeleton, sensitiveKeys, sample, hostOf, SENSITIVE, MARKET };
