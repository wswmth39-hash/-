'use strict';
// النواة — تصنيف حالة السوق قبل أي توصية (أطر متعددة، هيكل القمم/القيعان، ADX، انعكاس، اختراق صالح/وهمي).
// دوال بحتة على شموع مغلقة؛ القمم/القيعان تحتاج شمعتين بعدها تأكيدًا فلا تستخدم ما بعد آخر شمعة.
const { ema, atr, atrBase, eff, bb, body, rng, bull, bear, upw, low, resample, swings, structOf, adxOf, rsiSeries } = require('./indicators');
// ================= v3.1: فهم حالة السوق (قبل أي توصية) =================
// يُحسب قبل التصويت: أطر متعددة + هيكل القمم/القيعان + ADX + الزخم + التذبذب + انعكاس + اختراق صالح/وهمي.
// الناتج: kind/label (الحالة)، clarity (الوضوح 0-100)، allow (الاتجاه الوحيد المسموح: 1 / -1 / 0 = لا دخول).
// كله على شموع مغلقة فقط (القمم/القيعان تحتاج شمعتين تأكيدًا بعدها فلا نظر للمستقبل).
const CTX_LBL = { trend: 'اتجاه', range: 'عرضي (نطاق)', valid: 'اختراق صالح', fake: 'اختراق وهمي', rev: 'انعكاس', weak: 'اتجاه ضعيف', squeeze: 'انضغاط', chaos: 'فوضوي', unclear: 'غير واضح' };
const CTX_KINDS = ['trend', 'range', 'valid', 'fake', 'rev', 'weak', 'squeeze', 'chaos', 'unclear'];
function frameTrend(cs, fa, sl, minLen) {
  if (!cs || cs.length < minLen) return null;
  const c = cs.map(x => x.c), n = c.length - 1, ef = ema(c, fa), es = ema(c, sl);
  const a = atr(cs, Math.min(14, n - 1)) || 1e-12;
  const sep = (ef[n] - es[n]) / a, slope = (es[n] - es[n - 4]) / a, st = structOf(swings(cs, 2));
  const v = (sep > .15 ? 1 : sep < -.15 ? -1 : 0) + (slope > .1 ? .5 : slope < -.1 ? -.5 : 0) + st, sc = v / 2.5;
  return { d: Math.abs(sc) >= .4 ? Math.sign(sc) : 0, s: Math.abs(sc), st };
}
function reversalScan(cs, td, atrv, mom) {
  if (!td) return { score: 0, dir: 0, ok: false, why: [] };
  const n = cs.length - 1, c = cs.map(x => x.c), l = cs[n], e = ema(c, 20), why = [];
  let sc = 0;
  if ((c[n] - e[n]) * td / atrv > 2) { sc += 1; why.push('امتداد مفرط'); }
  const wk = td > 0 ? upw(l) : low(l);
  if (wk >= 2 * body(l) && wk > .45 * rng(l)) { sc += 1; why.push('رفض عند الطرف'); }
  if (mom.decel) { sc += 1; why.push('تباطؤ الزخم'); }
  const seg = cs.slice(-60), c60 = seg.map(x => x.c), sw = swings(seg, 2), arr = td > 0 ? sw.hi : sw.lo;
  if (arr.length >= 2) {
    const a = arr[arr.length - 2], b = arr[arr.length - 1];
    if (a.i >= 15 && b.i >= 15) {
      const rs = rsiSeries(c60), ra = rs[a.i], rb = rs[b.i];
      if (td > 0 && b.p > a.p && rb < ra - 3) { sc += 1.5; why.push('تباعد هابط RSI'); }
      if (td < 0 && b.p < a.p && rb > ra + 3) { sc += 1.5; why.push('تباعد صاعد RSI'); }
    }
  }
  const lv = td > 0 ? sw.lo : sw.hi;
  if (lv.length) {
    const L = lv[lv.length - 1];
    if (td > 0 && c[n] < L.p) { sc += 2; why.push('كسر هيكل الاتجاه'); }
    if (td < 0 && c[n] > L.p) { sc += 2; why.push('كسر هيكل الاتجاه'); }
  }
  const against = td > 0 ? bear(l) : bull(l);
  return { score: sc, dir: -td, ok: sc >= 3 && against, why };
}
// اختراق صالح (إغلاق خلف المستوى + جسم قوي + اتساع مدى + ثبات) مقابل وهمي (ذيل رفض أو إغلاق عاد داخل النطاق)
function breakoutScan(cs, atrv) {
  const n = cs.length; let out = null;
  for (let age = 2; age >= 0; age--) {
    const j = n - 1 - age;
    if (j < 22) continue;
    const bs = cs.slice(j - 20, j), hh = Math.max(...bs.map(x => x.h)), ll = Math.min(...bs.map(x => x.l)), x = cs[j], after = cs.slice(j + 1);
    if (hh - ll > 5 * atrv) continue; // لا اختراق حقيقي إلا بعد تجميع/نطاق؛ غير ذلك استمرار اتجاه وليس اختراقًا
    for (const side of [1, -1]) {
      const lv = side > 0 ? hh : ll, beyond = side > 0 ? x.c - lv : lv - x.c, pierce = side > 0 ? x.h > lv : x.l < lv;
      const wk = side > 0 ? upw(x) : low(x);
      const held = after.every(y => side > 0 ? y.c > lv : y.c < lv), back = after.some(y => side > 0 ? y.c <= lv : y.c >= lv);
      if (pierce && beyond <= 0 && wk >= .5 * rng(x)) out = { t: 'fake', side, age, why: 'اختراق بذيل رفض' };
      else if (beyond > 0 && back) out = { t: 'fake', side, age, why: 'اختراق عاد داخل النطاق' };
      else if (beyond >= .15 * atrv && body(x) >= .5 * rng(x) && rng(x) >= atrv && held) out = { t: 'valid', side, age, why: 'اختراق بإغلاق وجسم قوي' };
    }
  }
  return out;
}
// opts: { tf, htfK } — الإطار الزمني ومعامل الإطار الأعلى يُمرَّران صراحةً
function marketContext(cs, opts) {
  const { tf, htfK } = opts;
  const n = cs.length - 1, c = cs.map(x => x.c);
  const atrv = atr(cs) || 1e-12, a0 = atrBase(cs) || 1e-12, volR = atrv / a0;
  const fb = frameTrend(cs.slice(-120), 9, 21, 40), f5 = frameTrend(resample(cs, htfK, tf), 9, 21, 30), f15 = frameTrend(resample(cs, htfK * 3, tf), 5, 13, 16);
  const W = [1, 1.5, 1], FR = [fb, f5, f15];
  let sw = 0, tw = 0;
  FR.forEach((f, i) => { if (f) { sw += W[i] * f.d; tw += W[i]; } });
  const align = tw ? sw / tw : 0, bias = Math.abs(align) >= .5 ? Math.sign(align) : 0;
  const conflict = !!(fb && f5 && fb.d && f5.d && fb.d !== f5.d);
  const ad = adxOf(cs.slice(-120)) || { adx: 20 }, er = eff(c, 20), er10 = eff(c, 10);
  let ch = 0;
  for (let i = n - 10; i <= n; i++) if (i >= 2 && Math.sign(c[i] - c[i - 1]) !== Math.sign(c[i - 1] - c[i - 2])) ch++;
  const chop = ch / 11;
  const m1 = (c[n] - c[n - 5]) / atrv, m0 = (c[n - 5] - c[n - 10]) / atrv;
  const mom = { v: m1, dir: Math.abs(m1) >= .5 ? Math.sign(m1) : 0, decel: m1 * m0 > 0 && Math.abs(m1) < .6 * Math.abs(m0), accel: m1 * m0 > 0 && Math.abs(m1) > 1.3 * Math.abs(m0) };
  const trendD = bias || (fb ? fb.d : 0);
  const rev = reversalScan(cs, trendD, atrv, mom), bo = breakoutScan(cs, atrv);
  const ws = [];
  for (let i = Math.max(19, n - 49); i <= n; i++) { const [, sd] = bb(c, i); ws.push(sd); }
  const sqz = ws.filter(v => v < ws[ws.length - 1]).length / ws.length <= .2;
  const rg = cs.slice(-30), hh = Math.max(...rg.map(x => x.h)), ll = Math.min(...rg.map(x => x.l)), pos = hh > ll ? (c[n] - ll) / (hh - ll) : .5, width = hh - ll;
  const al = d => d * Math.sign(align || 0);
  let kind = 'unclear', allow = 0, clarity = 25, note = '';
  if (chop >= .7 && er10 < .2 && er < .25) { kind = 'chaos'; clarity = 10; note = 'حركة متعرجة بلا اتجاه'; }
  else if (bo && bo.t === 'fake') {
    kind = 'fake'; allow = -bo.side; note = bo.why;
    clarity = 55 + (bo.age === 0 ? 5 : 0) + (align && al(-bo.side) > 0 ? 10 : align && al(-bo.side) < 0 ? -10 : 0) - (volR > 1.6 ? 10 : 0);
  } else if (bo && bo.t === 'valid') {
    kind = 'valid'; allow = bo.side; note = bo.why;
    clarity = 60 + (align && al(bo.side) > 0 ? 12 : align && al(bo.side) < 0 ? -20 : 0) + (ad.adx >= 20 ? 8 : 0) - (conflict ? 15 : 0);
  } else if (rev.ok) { kind = 'rev'; allow = rev.dir; note = rev.why.join('، '); clarity = Math.min(85, 40 + rev.score * 8); }
  else if (sqz && ad.adx < 25 && er < .35) { kind = 'squeeze'; clarity = 30; note = 'انضغاط: انتظر الاختراق'; }
  else if (bias && (ad.adx >= 20 || er >= .3)) {
    kind = 'trend'; allow = bias; note = (bias > 0 ? 'صاعد' : 'هابط') + ' · ADX ' + Math.round(ad.adx);
    clarity = 30 + Math.min(35, ad.adx) + 30 * Math.abs(align) - (mom.decel ? 10 : 0) - ((c[n] - ema(c, 20)[n]) * bias / atrv > 2.5 ? 10 : 0) - (conflict ? 15 : 0);
  } else if (ad.adx < 20 && er < .25 && volR < 1.5) {
    kind = 'range';
    if (width < 2 * atrv) { note = 'نطاق ضيق'; clarity = 35; }
    else if (pos <= .25) { allow = 1; note = 'قرب قاع النطاق'; clarity = 50 + (20 - ad.adx) + Math.abs(pos - .5) * 40; }
    else if (pos >= .75) { allow = -1; note = 'قرب قمة النطاق'; clarity = 50 + (20 - ad.adx) + Math.abs(pos - .5) * 40; }
    else { note = 'منتصف النطاق'; clarity = 35; }
  } else if (bias) { kind = 'weak'; allow = bias; note = 'اتجاه بلا قوة كافية'; clarity = 30 + ad.adx + 15 * Math.abs(align); }
  else note = 'الأطر متضاربة أو بلا اتجاه';
  clarity = Math.max(0, Math.min(100, Math.round(clarity)));
  const arrow = f => !f ? '·' : f.d > 0 ? '▲' : f.d < 0 ? '▼' : '–';
  return { kind, label: CTX_LBL[kind], allow, clarity, note, align, bias, conflict, adx: Math.round(ad.adx), er: +er.toFixed(2), volR: +volR.toFixed(2), pos: +pos.toFixed(2), mom: +m1.toFixed(2), f5d: f5 ? f5.d : 0, f15d: f15 ? f15.d : 0, mtf: arrow(fb) + arrow(f5) + arrow(f15), rev: rev.score, bo: bo ? bo.t + (bo.side > 0 ? '↑' : '↓') : '' };
}
function ctxPermit(ctx, dir, cfg) {
  if (!cfg.useCtx) return { ok: true };
  if (!ctx) return { ok: false, why: 'حالة السوق غير محسوبة' };
  if (ctx.clarity < cfg.minClarity) return { ok: false, why: 'حالة السوق غير واضحة: ' + ctx.label + ' (' + ctx.clarity + '%)' };
  if (!ctx.allow) return { ok: false, why: 'لا دخول في حالة «' + ctx.label + '»' + (ctx.note ? ': ' + ctx.note : '') };
  if (ctx.allow !== dir) return { ok: false, why: 'الاتجاه يخالف حالة السوق «' + ctx.label + '» (' + ctx.note + ')' };
  if (ctx.f5d === -dir && ctx.f15d === -dir && ctx.kind !== 'rev' && ctx.kind !== 'fake') return { ok: false, why: 'عكس الإطارين الأعلى معًا' };
  return { ok: true };
}
module.exports = { CTX_LBL, CTX_KINDS, frameTrend, reversalScan, breakoutScan, marketContext, ctxPermit };
