'use strict';
// النواة — التحقق من التيك قبل دخوله المحرك، وآلة حالات البيانات. دوال بحتة؛ الحالة تُمرَّر صراحةً.
// المبدأ: لا نفترض أن البيانات المستقبلة كاملة أو صحيحة. ما لا يجتاز التحقق يُرفض ويُعدّ بسببه، ولا يُصحَّح بالتخمين.

const ASSET_RE = /^[A-Za-z0-9_#.\-\/ ]{1,40}$/;

// t: { asset, ts, p } · prev: آخر تيك مقبول لنفس الأصل { ts, p } أو null · opts: { maxJump, jumpWindowS }
// v4.0.1: لا مقارنة بساعة الجهاز. ساعة المنصة قد تكون مزاحة بثبات (مكتبة lordralinc/pocket_option توثّق −7200 ث)،
// والمقارنة بساعة الجهاز كانت ترفض كل التيكات في تلك الحالة. التأخر يُقاس نسبيًا في المحرك (createClockTracker).
// يعيد '' للتيك الصالح أو سبب الرفض. (التكرار يُفحص منفصلًا: ليس خطأ بيانات بل إعادة إرسال.)
function tickError(t, prev, opts) {
  if (!t || typeof t.asset !== 'string' || !ASSET_RE.test(t.asset)) return 'اسم أصل غير صالح';
  if (!Number.isFinite(t.ts)) return 'وقت غير رقمي';
  if (!Number.isFinite(t.p)) return 'سعر غير رقمي';
  if (!(t.p > 0)) return 'سعر غير موجب';
  if (t.ts > 1e11) return 'وقت بوحدة غير متوقعة (مللي ثانية؟)'; // لا نحوّل تلقائيًا: لا نخمّن
  if (t.ts < 1e9) return 'وقت غير منطقي (قبل 2001)';
  if (prev && prev.p > 0 && Math.abs(t.ts - prev.ts) <= (opts && opts.jumpWindowS || 300)) {
    const ch = Math.abs(t.p / prev.p - 1);
    if (ch > (opts && opts.maxJump || .2)) return 'قفزة سعرية شاذة (' + Math.round(ch * 100) + '%)';
  }
  return '';
}

// كاشف التكرار: حلقة محدودة لكل أصل من مفاتيح (وقت|سعر). الذاكرة ثابتة مهما طال التشغيل.
function createDedup(size = 256) {
  const rings = new Map();
  return {
    seen(asset, ts, p) {
      let r = rings.get(asset);
      if (!r) { r = { keys: new Set(), order: [] }; rings.set(asset, r); }
      const k = ts + '|' + p;
      if (r.keys.has(k)) return true;
      r.keys.add(k); r.order.push(k);
      if (r.order.length > size) r.keys.delete(r.order.shift());
      return false;
    },
    forget(asset) { rings.delete(asset); },
    size() { let n = 0; for (const r of rings.values()) n += r.order.length; return n; }
  };
}

// آلة حالات البيانات. «حية» لا تُعطى إلا بوجود اتصال مفتوح وتيك صالح حديث للأصل الحالي — الاتصال وحده لا يكفي.
// x: { openConns, connecting, everOpen, lastOpenAt, lastCloseAt, lastValidAt, errorBurst, now }
// t: { liveMs, delayMs, unavailableMs, waitMs }
const FEED_LABEL = {
  disconnected: 'غير متصل', connecting: 'جارٍ الاتصال', connected: 'متصل — بانتظار البيانات', live: 'بيانات حية',
  delayed: 'بيانات متأخرة', stale: 'بيانات قديمة', unavailable: 'البيانات غير متاحة', error: 'خطأ في البيانات'
};
function feedStatus(x, t) {
  if (!x.openConns) {
    if (x.connecting) return 'connecting';
    return 'disconnected';
  }
  const age = x.lastValidAt ? x.now - x.lastValidAt : null;
  if (x.errorBurst && (age === null || age > t.delayMs)) return 'error';
  if (age === null || x.lastValidAt < x.lastOpenAt - t.delayMs) {
    // اتصال مفتوح لم يصلنا منه تيك صالح بعد
    return x.now - x.lastOpenAt <= t.waitMs ? 'connected' : 'unavailable';
  }
  if (age <= t.liveMs) return 'live';
  if (age <= t.delayMs) return 'delayed';
  if (age <= t.unavailableMs) return 'stale';
  return 'unavailable';
}
// متتبع ساعة المنصة: d = وقت الاستلام (الجهاز) − وقت التيك (المنصة) = إزاحة الساعتين + تأخر الشبكة.
// أصغر d خلال النافذة ≈ الإزاحة الثابتة (أقل تأخر)، والتأخر الحالي = d − الأصغر. لا يفترض أن الساعتين متطابقتان.
function createClockTracker(windowMs = 5 * 60e3, maxSamples = 600) {
  const q = [];
  return {
    add(atMs, ts) {
      q.push({ at: atMs, d: atMs / 1000 - ts });
      while (q.length > maxSamples || (q.length && atMs - q[0].at > windowMs)) q.shift();
    },
    offsetS() { if (!q.length) return null; let m = Infinity; for (const x of q) if (x.d < m) m = x.d; return -m; },   // موجب = المنصة متقدمة
    latencyMs() { if (!q.length) return null; let m = Infinity; for (const x of q) if (x.d < m) m = x.d; return Math.round((q[q.length - 1].d - m) * 1000); },
    size() { return q.length; }
  };
}
module.exports = { ASSET_RE, tickError, createDedup, createClockTracker, FEED_LABEL, feedStatus };
