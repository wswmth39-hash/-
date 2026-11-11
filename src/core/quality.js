'use strict';
// النواة — صلاحية البيانات قبل أي تحليل. دوال بحتة؛ كل معامل يُمرَّر صراحةً.
function verifyCandles(cs, tf, maxGap) {
  let gaps = 0;
  for (let i = 0; i < cs.length; i++) {
    const x = cs[i];
    if (![x.o, x.h, x.l, x.c].every(Number.isFinite)) return { ok: false, why: 'قيم غير صالحة' };
    if (x.h < x.l || x.h < Math.max(x.o, x.c) || x.l > Math.min(x.o, x.c)) return { ok: false, why: 'شمعة مشوهة' };
    if (i && x.t <= cs[i - 1].t) return { ok: false, why: 'توقيت مكرر' };
    if (i && x.t - cs[i - 1].t > tf) gaps++;
  }
  if (cs.length && gaps / cs.length > maxGap) return { ok: false, why: 'فجوات زمنية كثيرة (' + gaps + ')' };
  return { ok: true, why: 'سليمة' + (gaps ? ' (' + gaps + ' فجوة)' : '') };
}

// tickAgeMs: عمر آخر تيك حي بالمللي ثانية (يحسبه المحرك من ساعته)، أو null أثناء التاريخ/بلا بيانات حية.
function dataQuality(cs, tf, tickAgeMs, maxTickAgeMs) {
  const n = cs.length, issues = [];
  if (n < 2) return { q: 0, issues: ['لا بيانات'] };
  let q = 100, gaps = 0, flat = 0;
  const rs = [];
  for (let i = 0; i < n; i++) {
    if (i && cs[i].t - cs[i - 1].t > tf) gaps++;
    const r = cs[i].h - cs[i].l;
    rs.push(r);
    if (r === 0) flat++;
  }
  if (gaps) { q -= Math.min(40, gaps / n * 400); issues.push('فجوات زمنية ' + gaps); }
  if (flat / n > .1) { q -= Math.min(30, flat / n * 100); issues.push('شموع مسطحة ' + Math.round(flat / n * 100) + '%'); }
  const med = rs.slice().sort((a, b) => a - b)[n >> 1];
  if (med > 0) {
    const out = rs.filter(x => x > 12 * med).length;
    if (out / n > .03) { q -= 15; issues.push('قفزات شاذة ' + out); }
  }
  if (tickAgeMs !== null && tickAgeMs !== undefined) {
    const age = tickAgeMs;
    if (age > maxTickAgeMs) { q -= 25; issues.push('تأخر آخر تيك ' + Math.round(age / 1000) + 'ث'); }
  }
  return { q: Math.max(0, Math.round(q)), issues };
}


// v3.4: صلاحية البيانات قبل التحليل. يعيد سبب المنع أو '' إذا كانت البيانات صالحة.
// - انقطاع الاتصال (حي فقط) - الشمعة الجديدة لا تلي المغلقة مباشرة (فجوة) - آخر contigN شمعة غير متصلة زمنيًا.
// يُطبَّق نفس شرط الاتصال على التاريخ والحي حتى يتعلّم البوت ويقرر بنفس القواعد.
// opts: { live, wsUp, tf, contigN }
function liveBlock(arr, tNew, opts) {
  const { live, wsUp, tf, contigN } = opts;
  if (live && wsUp === false) return 'انقطاع الاتصال: التحليل متوقف';
  const c = arr[arr.length - 1];
  if (tNew !== undefined && c && tNew - c.t > tf) return 'انقطاع في البيانات (' + Math.round((tNew - c.t - tf) / 60) + ' د): التحليل متوقف';
  const N = Math.min(contigN, arr.length - 1);
  for (let i = arr.length - N; i < arr.length; i++) if (i > 0 && arr[i].t - arr[i - 1].t !== tf)
    return 'فجوة بيانات حديثة: بانتظار ' + contigN + ' شمعة متصلة';
  return '';
}

// v3.6: عقد «الشموع المغلقة فقط». نافذة التحليل يجب أن تتكون من شموع انتهى وقتها عند لحظة asOf (وقت المنصة بالثواني)،
// مرتبة زمنيًا ومحاذاة للإطار. لا يُسمح بتجاوز ذلك إلا بعلَم صريح allowOpen (للأبحاث فقط؛ النتيجة تُعلَّم incomplete).
// يعيد سبب الرفض أو '' إن كانت النافذة صالحة.
function closedWindowError(cs, tf, asOf) {
  if (!(tf > 0)) return 'إطار زمني غير محدد';
  if (!Number.isFinite(asOf)) return 'لحظة التحليل (asOf) غير محددة';
  for (let i = 0; i < cs.length; i++) {
    const x = cs[i];
    if (!x || !Number.isFinite(x.t)) return 'شمعة بلا وقت';
    if (i && x.t <= cs[i - 1].t) return 'ترتيب الشموع الزمني مختل';
  }
  if (cs.length && cs[cs.length - 1].t + tf > asOf) return 'شمعة غير مكتملة في نافذة التحليل (تنتهي بعد لحظة التحليل)';
  return '';
}
module.exports = { verifyCandles, dataQuality, liveBlock, closedWindowError };
