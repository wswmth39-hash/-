// ==UserScript==
// @name         wsnf smart bot v3.6 (simulation only + candle recorder)
// @namespace    local.wsnf.v34sim
// @version      3.6.0
// @description  تحليل وإشارات وصفقات افتراضية فقط (Paper Trading) + مسجّل شموع محلي. لا ينقر أي زر في المنصة ولا يرسل أي أمر.
// @match        https://pocketoption.com/*
// @match        https://*.pocketoption.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
/* v3.6 (المرحلة C): المحرك مفصول عن الواجهة. البنية في docs/ENGINE.md.
   وضع المحاكاة فقط — إلزامي: لا يوجد كود ينقر أزرار المنصة أو يرسل أوامر. WebSocket للقراءة فقط. */
// هذا الملف مولَّد آليًا من src/ بواسطة build.js — لا تعدّله مباشرة.
(function () {
'use strict';
const __defs = {
/* ---- core/catalog.js ---- */
"core/catalog": function (module, exports, require) {
'use strict';
// النواة — ثوابت مشتركة: مدد الانتهاء، حالات السوق، الفلاتر، التجارب، الإعدادات الافتراضية لقواعد القرار.
const HZ = [1, 2, 3, 5];
const RGS = ['اتجاهي', 'عرضي', 'مختلط', 'متقلب'];
const VETOS = ['قفزة سعرية', 'ملاحقة متأخرة', 'تذبذب الإشارة', 'مقاومة قريبة', 'دعم قريب', 'مؤشر واحد مهيمن'];
const DEFAULTS = { minAgree: 3, minConf: 65, minScore: .15, useHtf: true, veto: true, regimes: null, useCtx: true, minClarity: 45, dyn: true };
const hzLabel = (h, tf) => { const s = h * tf; return s < 60 || s % 60 ? s + ' ث' : s / 60 + ' د'; };
// كل تجربة = تعديل واحد على قواعد القرار. تُختبر بصفقات ظلّية على نفس الشموع دون أن تؤثر على القرار الفعلي.
const EXPS = [
  { k: 'base', n: 'الأساس (الإعداد الحالي)', o: {} },
  { k: 'noveto', n: 'بدون فلتر الإشارات الكاذبة', o: { veto: false } },
  { k: 'agree4', n: 'اتفاق 4 مجموعات فأكثر', o: { minAgree: 4 } },
  { k: 'conf72', n: 'ثقة 72% فأكثر', o: { minConf: 72 } },
  { k: 'score25', n: 'قوة إشارة أعلى (> 0.25)', o: { minScore: .25 } },
  { k: 'nohtf', n: 'بدون فلتر الإطار الأعلى', o: { useHtf: false } },
  { k: 'trend', n: 'الأسواق الاتجاهية فقط', o: { regimes: ['اتجاهي'] } },
  { k: 'static', n: 'تجميع ثابت للمؤشرات (بدون دمج ديناميكي)', o: { dyn: false } },
  { k: 'noctx', n: 'بدون فلتر حالة السوق', o: { useCtx: false } },
  { k: 'clar60', n: 'وضوح حالة السوق 60% فأكثر', o: { minClarity: 60 } },
  { k: 'notvol', n: 'استبعاد السوق المتقلب', o: { regimes: ['اتجاهي', 'عرضي', 'مختلط'] } },
  { k: 'forced', n: 'مرجع: بدون امتناع (كل شمعة)', o: { force: true, minConf: 0 }, ref: true }
];
const RGC = { 'اتجاهي': 't', 'عرضي': 'r', 'مختلط': 'm', 'متقلب': 'v' };
const qk = (k, h, rg) => 'q|' + k + '|' + h + '|' + (RGC[rg] || 'x');
module.exports = { HZ, RGS, VETOS, DEFAULTS, hzLabel, EXPS, RGC, qk };
},
/* ---- core/clusters.js ---- */
"core/clusters": function (module, exports, require) {
'use strict';
// النواة — استقلالية الأدلة: قياس الترابط بين أصوات الاستراتيجيات، دمج المجموعات المتطابقة عمليًا،
// وتخفيف أوزان الأصوات المترابطة (n_eff) حتى لا تُحسب أدلة مترابطة كأنها مستقلة.
// مصنع createClusters(env): env.cfg (قراءة)، env.corr() و env.corrH() عدّادات الترابط (تملكها هذه الوحدة كتابةً)،
// env.isLoading() هل نعيد تشغيل التاريخ (عدّاداته منفصلة لكل أصل وتُصفَّر عند كل تحميل).
const { GRP, SK } = require('./strategies');

function createClusters(env) {
  const CFG = env.cfg;
  const S = Object.freeze({ get corr() { return env.corr(); }, get corrH() { return env.corrH(); }, get loading() { return env.isLoading(); } });
  // ================= v3.2: عزل الأدلة المتشابهة (ترابط فعلي لا مجموعات ثابتة فقط) =================
  // ρ بين مؤشرين = 2×(نسبة اتفاق إشارتيهما عند نشاطهما معًا) − 1. المجموعات الثابتة تُدمج ديناميكيًا إذا ثبت تطابق مجموعتين مختلفتين عمليًا.
  const CL = { map: {}, n: 0 };
  // v3.4: عدّادات الترابط من إعادة تشغيل التاريخ تُحفظ لكل أصل وتُصفَّر عند كل تحميل للتاريخ (كانت تتضاعف عند إعادة إرسال التاريخ)
  function corrGet(key) {
    const o = [0, 0], add = x => { if (x) { o[0] += x[0]; o[1] += x[1]; } };
    add(S.corr[key]);
    for (const a in S.corrH) add(S.corrH[a][key]);
    return o;
  }
  const corrHistTotal = () => { let t = 0; for (const a in S.corrH) for (const k in S.corrH[a]) t += S.corrH[a][k][0]; return t; };
  function pairRho(a, b) {
    const x = corrGet(a + '|' + b), y = corrGet(b + '|' + a), n = x[0] + y[0];
    if (n < 100) return null;
    return 2 * ((x[1] + y[1]) / n) - 1;
  }
  function rebuildClusters() {
    const par = {};
    const gl = [...new Set(SK.map(k => GRP[k]))];
    gl.forEach(g => { par[g] = g; });
    const find = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    // دمج مجموعتين ثابتتين فقط إذا قيس ≥3 أزواج بينهما ومتوسط ρ ≥ 0.6 (زوج واحد متطابق لا يكفي)
    const agg = {};
    for (let i = 0; i < SK.length; i++) for (let j = i + 1; j < SK.length; j++) {
      const a = SK[i], b = SK[j];
      if (GRP[a] === GRP[b]) continue;
      const r = pairRho(a, b);
      if (r === null) continue;
      const key = [GRP[a], GRP[b]].sort().join('');
      const o = agg[key] || (agg[key] = { n: 0, s: 0, a: GRP[a], b: GRP[b] });
      o.n++; o.s += r;
    }
    for (const key in agg) { const o = agg[key]; if (o.n >= 3 && o.s / o.n >= .6) par[find(o.a)] = find(o.b); }
    CL.map = {};
    SK.forEach(k => { CL.map[k] = find(GRP[k]); });
    CL.n = (CL.n || 0) + 1;
  }
  const clusterOf = k => (CFG.dyn !== false && CL.map[k]) || GRP[k];


  // ---- مراقب الترابط بين الاستراتيجيات (تشخيص) ----
  function trackCorr(raw, asset) {
    const act = SK.filter(k => Math.abs(raw[k] || 0) >= .5);
    const C = S.loading && asset ? (S.corrH[asset] || (S.corrH[asset] = {})) : S.corr;
    for (let i = 0; i < act.length; i++) for (let j = i + 1; j < act.length; j++) {
      const key = act[i] + '|' + act[j], o = C[key] || (C[key] = [0, 0]);
      o[0]++; if (raw[act[i]] * raw[act[j]] > 0) o[1]++;
    }
  }
  function corrReport(minN = 100, thr = .8) {
    const out = [];
    const keys = new Set(Object.keys(S.corr));
    for (const a in S.corrH) Object.keys(S.corrH[a]).forEach(k => keys.add(k));
    for (const k of keys) {
      const [n, a] = corrGet(k);
      if (n < minN) continue;
      const r = a / n;
      if (r >= thr || r <= 1 - thr) out.push({ pair: k, n, agree: +r.toFixed(3), sameGroup: GRP[k.split('|')[0]] === GRP[k.split('|')[1]] });
    }
    return out.sort((x, y) => Math.abs(y.agree - .5) - Math.abs(x.agree - .5));
  }
  // تخفيف التصويت المكرر: داخل كل عنقود تُحسب الأدلة المستقلة الفعلية n_eff = m / (1 + (m-1)·ρ̄) ويُضرب كل وزن بـ √n_eff / m.
  // مؤشران متطابقان (ρ=1) لا يزيدان الدليل عن مؤشر واحد؛ مستقلان (ρ=0) يعطيان √2 كالسابق. ρ̄ تُقاس من البيانات (≥100 حالة) وإلا افتراض 0.3 داخل المجموعة الثابتة.
  function dampen(items) {
    const byC = {};
    items.forEach(x => { x.g0 = GRP[x.k]; x.g = clusterOf(x.k); (byC[x.g] = byC[x.g] || []).push(x); });
    for (const g in byC) {
      const m = byC[g], cnt = m.length;
      if (cnt < 2) continue;
      if (CFG.dyn === false) { m.forEach(x => { x.w = x.w / Math.sqrt(cnt); }); continue; }
      let sum = 0, np = 0;
      for (let i = 0; i < cnt; i++) for (let j = i + 1; j < cnt; j++) {
        const r = pairRho(m[i].k, m[j].k);
        sum += Math.max(0, r !== null ? r : (GRP[m[i].k] === GRP[m[j].k] ? .3 : 0)); np++;
      }
      const rho = sum / np, neff = cnt / (1 + (cnt - 1) * rho), f = Math.sqrt(neff) / cnt;
      m.forEach(x => { x.w = x.w * f; });
    }
    return items;
  }

  return { CL, corrGet, corrHistTotal, pairRho, rebuildClusters, clusterOf, trackCorr, corrReport, dampen };
}
module.exports = { createClusters };
},
/* ---- core/context.js ---- */
"core/context": function (module, exports, require) {
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
},
/* ---- core/decision.js ---- */
"core/decision": function (module, exports, require) {
'use strict';
// النواة — التحليل واتخاذ القرار. analyze(cs, deps) دالة على مدخلاتها فقط:
//   cs            نافذة شموع مغلقة مرتبة زمنيًا (تُرفض أي شمعة تنتهي بعد deps.asOf)
//   deps.cfg      الإعدادات · deps.A سجل إحصاء الأصل · deps.learner (learning.js) · deps.clusters (clusters.js)
//   deps.asOf     لحظة التحليل بوقت المنصة (ثوانٍ) — إلزامي · deps.allowOpen علَم صريح للسماح بشمعة غير مكتملة (للأبحاث فقط)
//   deps.useNew(k) النسخة المعتمدة · deps.sdh اتجاهات الإشارات السابقة · deps.tickAgeMs عمر آخر تيك حي أو null
//   deps.onQuality(dq) / deps.onStratErr(k, e) / deps.onError(code, msg) استدعاءات إبلاغ (المحرك يسجّلها)
// لا DOM، لا تخزين، لا ساعة، لا حالة عامة.
const { bucket } = require('./stats');
const { rsi, atr, atrBase, eff, rng, levels, htfTrend } = require('./indicators');
const { NM, evaluate } = require('./strategies');
const { verifyCandles, dataQuality, closedWindowError } = require('./quality');
const { marketContext, ctxPermit } = require('./context');
const { hzLabel } = require('./catalog');

// قرار الدخول من مكونات التحليل + الإعدادات. الامتناع هو الأصل: لا إشارة إلا إذا اجتازت كل الشروط.
// base: الإعدادات الحالية، o: تعديل تجريبي اختياري (للتجارب الظلية) — لا تُعدَّل base.
function decide(r, o, base) {
  const cfg = o ? { ...base, ...o } : base;
  if (!r || !r.comp || !r.sd) return { ok: false, why: [(r && r.why) || 'لا بيانات كافية'] };
  if (cfg.force) return { ok: true, why: [] };
  const why = [];
  if (Math.abs(r.sc) <= cfg.minScore) why.push('قوة الإشارة ضعيفة');
  const ag = cfg.dyn === false && r.agreeS !== undefined ? r.agreeS : r.agree;
  if (ag < cfg.minAgree) why.push('اتفاق ' + ag + ' من ' + cfg.minAgree + ' مجموعات مستقلة');
  if (r.opp >= .3) why.push('أصوات معاكسة قوية');
  if (cfg.useHtf && !r.htfOK) why.push('عكس اتجاه الإطار الأعلى');
  if (cfg.veto && r.vetoes.length) why.push('إشارة كاذبة محتملة: ' + r.vetoes.join('، '));
  if (cfg.regimes && !cfg.regimes.includes(r.regime)) why.push('حالة السوق (' + r.regime + ') غير مناسبة');
  const cp = ctxPermit(r.ctx, r.sd, cfg);
  if (!cp.ok) why.push(cp.why);
  return { ok: !why.length, why };
}

// اكتشاف الإشارات الكاذبة المحتملة قبل إصدار التوصية
// sdh: اتجاهات آخر الإشارات على هذا الأصل (قبل هذه الشمعة)
function falseSignals(cs, X, dir, items, sdh) {
  const out = [], n = cs.length, l = cs[n - 1], c = cs.map(x => x.c);
  if (rng(l) > 3 * X.atr) out.push('قفزة سعرية');
  if ((c[n - 1] - c[n - 4]) * dir > 2.5 * X.atr) out.push('ملاحقة متأخرة');
  const seq = ((sdh || []).slice(-3)).concat([dir]);
  let ch = 0;
  for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) ch++;
  if (seq.length >= 4 && ch >= 3) out.push('تذبذب الإشارة');
  const [lo, hi] = levels(cs), p = c[n - 1];
  if (dir > 0 && hi.some(v => v > p && v - p < .5 * X.atr)) out.push('مقاومة قريبة');
  if (dir < 0 && lo.some(v => v < p && p - v < .5 * X.atr)) out.push('دعم قريب');
  const tot = items.reduce((a, b) => a + b.w * Math.abs(b.v), 0);
  const top = Math.max(...items.map(x => x.w * Math.abs(x.v)));
  if (items.length >= 3 && tot > 0 && top / tot > .6) out.push('مؤشر واحد مهيمن');
  return out;
}


const noneR = (why, regime = '-') => ({ d: 'none', conf: 0, conf0: 0, why, abst: [why], raw: {}, regime, bk: null, notes: [], htf: 0, htfOK: false, agree: 0, agreeS: 0, rawA: {}, comp: false, sd: 0, sc: 0, vetoes: [] });
function analyze(cs, deps) {
  const { cfg: CFG, learner, clusters, A } = deps, tf = CFG.tf;
  const none = noneR;
  // عقد الشموع المغلقة: يُرفض التحليل إن كانت أي شمعة في النافذة لم ينتهِ وقتها عند asOf، إلا بعلَم صريح allowOpen
  const cw = closedWindowError(cs, tf, deps.asOf);
  let incomplete = false;
  if (cw) {
    if (deps.allowOpen === true && /غير مكتملة/.test(cw)) incomplete = true;
    else return none(cw);
  }
  if (cs.length < 60) return none('تجميع البيانات ' + cs.length + '/60');
  const vc = verifyCandles(cs, tf, CFG.maxGap);
  if (!vc.ok) return none('بيانات غير موثوقة: ' + vc.why);
  const dq = dataQuality(cs, tf, deps.tickAgeMs, CFG.maxTickAgeMs);
  if (deps.onQuality) deps.onQuality(dq);
  if (dq.q < CFG.minQ) return none('جودة البيانات ' + dq.q + '% (' + dq.issues.join('، ') + ')');
  const c = cs.map(x => x.c), X = { rsi: rsi(c), atr: atr(cs) };
  const a0 = atrBase(cs) || 1e-12;
  if (X.atr < .4 * a0) return none('سوق ميت');
  // حالة السوق: متقلب (قفزة تذبذب) ثم اتجاهي ثم عرضي ثم مختلط
  const er = eff(c), regime = X.atr > 1.8 * a0 ? 'متقلب' : er > .35 ? 'اتجاهي' : er < .2 ? 'عرضي' : 'مختلط';
  // 1) التصويت (strategies.js) 2) الأوزان من التعلّم (learning.js) 3) تخفيف الترابط (clusters.js) 4) القرار
  const ev = evaluate(cs, c, X, deps.useNew, deps.onStratErr);
  const raw = ev.raw, rawA = {}, items = [], det = {};
  for (const { k, kind, ak, v, det: n } of ev.list) {
    det[k] = n;
    rawA[k] = v;
    if (v === 0) continue;
    const W = learner.wtR(A, ak, regime);
    if (W.w === 0) continue;
    // التعديل اليدوي حسب النوع يُستخدم فقط حين لا توجد بيانات كافية لهذه الحالة؛ وإلا فالبيانات هي التي تحكم
    const m = W.rg ? 1 : ((kind === 'T' && regime === 'اتجاهي') || (kind === 'R' && regime === 'عرضي') ? 1.4
      : (kind === 'T' && regime === 'عرضي') || (kind === 'R' && regime === 'اتجاهي') ? .6 : 1);
    items.push({ k, ak, v: W.inv ? -v : v, w: W.w * m, inv: W.inv, mode: W.mode });
  }
  if (!items.length) return { ...none('لا أصوات', regime), raw, rawA };
  clusters.dampen(items);
  const ws = items.reduce((a, b) => a + b.w, 0);
  const score = items.reduce((a, b) => a + b.w * b.v, 0) / ws;
  if (!(Math.abs(score) > 0)) return { ...none('أصوات متعادلة', regime), raw, rawA };
  const dir = score > 0 ? 1 : -1;
  const gs = {};
  items.forEach(x => { const o = gs[x.g] || (gs[x.g] = { sw: 0, sv: 0 }); o.sw += x.w; o.sv += x.w * x.v; });
  const agree = Object.values(gs).filter(o => o.sv / o.sw * dir >= .5).length; // عناقيد مستقلة متفقة (دمج ديناميكي للمتطابقة)
  const gs0 = {};
  items.forEach(x => { const o = gs0[x.g0] || (gs0[x.g0] = { sw: 0, sv: 0 }); o.sw += x.w; o.sv += x.w * x.v; });
  const agreeS = Object.values(gs0).filter(o => o.sv / o.sw * dir >= .5).length; // بالمجموعات الثابتة فقط (للمقارنة)
  const sa = items.reduce((a, b) => a + b.w * Math.abs(b.v), 0) || 1e-9;
  const opp = items.filter(x => x.v * dir < 0).reduce((a, b) => a + b.w * Math.abs(b.v), 0) / sa;
  const htf = htfTrend(cs, CFG.htfK, tf), htfOK = htf === 0 || htf === dir;
  // v3.4: «القوة» = درجة اتفاق الأصوات المرجّحة (50–95). ليست احتمال نجاح. كانت تُقصّ عند 70 حتى 100 إشارة حية،
  // فكانت كل الإشارات تظهر 70% بالضبط وتقع في فئة بوابة واحدة. نسبة النجاح الفعلية تُعرض منفصلة مع حجم العينة.
  const conf0 = Math.min(95, Math.round(50 + Math.abs(score) * 70));
  let ctx = null;
  try { ctx = marketContext(cs, { tf, htfK: CFG.htfK }); } catch (e) { if (deps.onError) deps.onError('CTX_ERR', String(e && e.message || e)); }
  const X2 = { atr: X.atr };
  const vetoes = falseSignals(cs, X2, dir, items, deps.sdh);
  const r0 = { comp: true, sd: dir, sc: score, agree, agreeS, opp, htfOK, vetoes, regime, ctx };
  const dc = decide(r0, null, CFG), ok = dc.ok;
  const conf = ok ? conf0 : Math.min(conf0, 59);
  const notes = items.filter(x => Math.abs(x.v) >= .5).map(x => (det[x.k] || NM[x.k]) + (x.v > 0 ? '▲' : '▼') + (x.inv ? '⟲' : ''));
  const hzB = learner.bestHz(A, regime, items, dir);
  if (hzB) notes.push('أنسب مدة: ' + hzLabel(hzB.h, tf) + ' (' + Math.round(hzB.acc * 100) + '%)');
  if (ctx) { notes.unshift('أطر ' + ctx.mtf + (ctx.bo ? ' · ' + ctx.bo : '')); notes.unshift('حالة: ' + ctx.label + ' ' + ctx.clarity + '%' + (ctx.note ? ' (' + ctx.note + ')' : '')); }
  const out = { d: ok ? (dir > 0 ? 'call' : 'put') : 'none', conf, conf0, why: regime, abst: dc.why, regime, raw, bk: bucket(conf), notes, agree, agreeS, opp, htf, htfOK, score, sc: score, sd: dir, comp: true, vetoes, q: dq.q, atr: X.atr, ctx, rawA, hzB };
  if (incomplete) { out.incomplete = true; out.notes.unshift('⚠ تحليل على شمعة غير مكتملة (allowOpen)'); }
  return out;
}
module.exports = { decide, falseSignals, noneR, analyze };
},
/* ---- core/indicators.js ---- */
"core/indicators": function (module, exports, require) {
'use strict';
// النواة — المؤشرات الفنية وأنماط الشموع والقمم/القيعان.
// كلها دوال بحتة: المدخل مصفوفة شموع مغلقة مرتبة زمنيًا {t,o,h,l,c} أو مصفوفة أسعار، والمخرج قيمة محسوبة منها فقط.
// لا تقرأ أي حالة عامة ولا إعدادات: كل معامل (مثل مدة الشمعة tf) يُمرَّر صراحةً.
// ================= المؤشرات =================
const ema = (a, n) => {
  const k = 2 / (n + 1); let e = a[0]; const o = [e];
  for (let i = 1; i < a.length; i++) { e = a[i] * k + e * (1 - k); o.push(e); }
  return o;
};
// v3.4: RSI بطريقة Wilder (التنعيم الأسي القياسي الذي صُممت له عتبتا 30/70). كان متوسطًا بسيطًا،
// وكان يعطي 100 عند سكون السعر (لا ربح ولا خسارة) فيصدر إشارة بيع كاذبة. الصحيح عند السكون = 50.
const rsiVal = (g, l) => (g === 0 && l === 0) ? 50 : l === 0 ? 100 : 100 - 100 / (1 + g / l);
const rsiSeries = (c, n = 14) => {
  const out = new Array(c.length).fill(50);
  if (c.length <= n) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n; out[n] = rsiVal(g, l);
  for (let i = n + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (n - 1) + (d > 0 ? d : 0)) / n; l = (l * (n - 1) + (d < 0 ? -d : 0)) / n;
    out[i] = rsiVal(g, l);
  }
  return out;
};
const rsi = (c, n = 14) => { const r = rsiSeries(c, n); return r[r.length - 1]; };
const atr = (cs, n = 14) => {
  let s = 0;
  for (let i = cs.length - n; i < cs.length; i++) {
    const x = cs[i], p = cs[i - 1];
    s += Math.max(x.h - x.l, Math.abs(x.h - p.c), Math.abs(x.l - p.c));
  }
  return s / n;
};
const hl = (cs, n) => { const w = cs.slice(-n); return [Math.max(...w.map(x => x.h)), Math.min(...w.map(x => x.l))]; };
const eff = (c, n = 20) => {
  let p = 0;
  for (let i = c.length - n; i < c.length; i++) p += Math.abs(c[i] - c[i - 1]);
  return p === 0 ? 0 : Math.abs(c[c.length - 1] - c[c.length - 1 - n]) / p;
};
// v3.4: الدوجي (إغلاق = افتتاح) ليس صاعدًا ولا هابطًا. كان !bull يُستخدم بمعنى «هابطة» فيُحسب الدوجي هابطًا.
const body = x => Math.abs(x.c - x.o), rng = x => Math.max(x.h - x.l, 1e-12), bull = x => x.c > x.o, bear = x => x.c < x.o;
const upw = x => x.h - Math.max(x.o, x.c), low = x => Math.min(x.o, x.c) - x.l;
// ATR مرجعي: متوسط المدى الحقيقي على ما يصل إلى 100 شمعة قبل آخر 30 (كان ATR لـ 14 شمعة فقط: مرجع شديد الضوضاء)
const atrBase = cs => { const b = cs.slice(0, -30), n = Math.min(100, b.length - 1); return n >= 14 ? atr(b, n) : atr(b); };
const bb = (c, i, n = 20) => {
  const w = c.slice(i - n + 1, i + 1), m = w.reduce((a, b) => a + b) / n;
  const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / n) || 1e-12;
  return [m, sd];
};
// ================= إطار زمني أعلى =================
// v3.4: الشموع الأعلى تُبنى على حدود الساعة (مثل أي منصة)، لا من نهاية المصفوفة (كانت حدودها تنزاح مع كل شمعة).
// تُستبعد الشمعة الأعلى الأولى إن كانت ناقصة البداية، والأخيرة إن لم ينتهِ وقتها بعد.
function resample(cs, k, tf) {
  if (!(tf > 0)) throw new Error('resample: tf مطلوب صراحةً');
  const P = tf * k, out = [];
  if (!cs.length) return out;
  const lastEnd = cs[cs.length - 1].t + tf;
  let g = null;
  for (const x of cs) {
    const b = Math.floor(x.t / P) * P;
    if (!g || g.t !== b) {
      if (g && !(out.length === 0 && g.first !== g.t)) out.push({ t: g.t, o: g.o, h: g.h, l: g.l, c: g.c });
      g = { t: b, o: x.o, h: x.h, l: x.l, c: x.c, first: x.t };
    } else { if (x.h > g.h) g.h = x.h; if (x.l < g.l) g.l = x.l; g.c = x.c; }
  }
  if (g && g.t + P <= lastEnd && !(out.length === 0 && g.first !== g.t)) out.push({ t: g.t, o: g.o, h: g.h, l: g.l, c: g.c });
  return out;
}
function htfTrend(cs, k, tf) {
  const h = resample(cs, k, tf);
  if (h.length < 25) return 0;
  const c = h.map(x => x.c), e9 = ema(c, 9), e21 = ema(c, 21), n = c.length - 1;
  return e9[n] > e21[n] ? 1 : e9[n] < e21[n] ? -1 : 0;
}

// ================= أنماط الشموع =================
function patterns(cs) {
  const n = cs.length, a = cs[n - 3], b = cs[n - 2], c = cs[n - 1];
  const down = cs[n - 5].c > b.c, upt = cs[n - 5].c < b.c;
  if (bear(b) && bull(c) && c.o <= b.c && c.c >= b.o && body(c) > body(b)) return [1, 'ابتلاع صاعد'];
  if (bull(b) && bear(c) && c.o >= b.c && c.c <= b.o && body(c) > body(b)) return [-1, 'ابتلاع هابط'];
  if (bear(a) && body(a) > .5 * rng(a) && body(b) < .3 * rng(b) && bull(c) && c.c > (a.o + a.c) / 2) return [1, 'نجمة الصباح'];
  if (bull(a) && body(a) > .5 * rng(a) && body(b) < .3 * rng(b) && bear(c) && c.c < (a.o + a.c) / 2) return [-1, 'نجمة المساء'];
  if (body(c) < .35 * rng(c) && low(c) >= 2 * body(c) && upw(c) < .25 * rng(c) && down) return [.8, 'مطرقة'];
  if (body(c) < .35 * rng(c) && upw(c) >= 2 * body(c) && low(c) < .25 * rng(c) && upt) return [-.8, 'نجمة الرماية'];
  if ([a, b, c].every(x => bull(x) && body(x) > .5 * rng(x)) && a.c < b.c && b.c < c.c) return [.6, 'ثلاثة جنود'];
  if ([a, b, c].every(x => bear(x) && body(x) > .5 * rng(x)) && a.c > b.c && b.c > c.c) return [-.6, 'ثلاثة غربان'];
  return [0, ''];
}
function levels(cs, n = 60) {
  const seg = cs.slice(-n, -3), hi = [], lo = [];
  for (let i = 2; i < seg.length - 2; i++) {
    const w = seg.slice(i - 2, i + 3);
    if (seg[i].h === Math.max(...w.map(x => x.h))) hi.push(seg[i].h);
    if (seg[i].l === Math.min(...w.map(x => x.l))) lo.push(seg[i].l);
  }
  return [lo, hi];
}
function heikin(cs) {
  const w = cs.slice(-30), out = [];
  let po = w[0].o, pc = w[0].c;
  for (const x of w) {
    const c = (x.o + x.h + x.l + x.c) / 4, o = (po + pc) / 2;
    out.push({ o, c, h: Math.max(x.h, o, c), l: Math.min(x.l, o, c) });
    po = o; pc = c;
  }
  return out;
}
function swings(cs, k = 2) {
  const hi = [], lo = [];
  for (let i = k; i < cs.length - k; i++) {
    let h = true, l = true;
    for (let j = 1; j <= k; j++) {
      if (!(cs[i].h > cs[i - j].h && cs[i].h >= cs[i + j].h)) h = false;
      if (!(cs[i].l < cs[i - j].l && cs[i].l <= cs[i + j].l)) l = false;
    }
    if (h) hi.push({ i, p: cs[i].h });
    if (l) lo.push({ i, p: cs[i].l });
  }
  return { hi, lo };
}
// هيكل السوق: قمم أعلى + قيعان أعلى = +1 ، قمم أدنى + قيعان أدنى = -1 ، متضارب = 0
function structOf(sw) {
  if (sw.hi.length < 2 || sw.lo.length < 2) return 0;
  const h1 = sw.hi[sw.hi.length - 2].p, h2 = sw.hi[sw.hi.length - 1].p, l1 = sw.lo[sw.lo.length - 2].p, l2 = sw.lo[sw.lo.length - 1].p;
  return (h2 > h1 ? .5 : h2 < h1 ? -.5 : 0) + (l2 > l1 ? .5 : l2 < l1 ? -.5 : 0);
}
function adxOf(cs, n = 14) {
  if (cs.length < 2 * n + 2) return null;
  const pd = [], md = [], tr = [];
  for (let i = 1; i < cs.length; i++) {
    const x = cs[i], p = cs[i - 1], up = x.h - p.h, dn = p.l - x.l;
    pd.push(up > dn && up > 0 ? up : 0); md.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(x.h - x.l, Math.abs(x.h - p.c), Math.abs(x.l - p.c)));
  }
  let sp = 0, sm = 0, st = 0;
  for (let i = 0; i < n; i++) { sp += pd[i]; sm += md[i]; st += tr[i]; }
  const dx = []; let dip = 0, dim = 0;
  for (let i = n; i < pd.length; i++) {
    sp = sp - sp / n + pd[i]; sm = sm - sm / n + md[i]; st = st - st / n + tr[i];
    dip = st ? 100 * sp / st : 0; dim = st ? 100 * sm / st : 0;
    const s = dip + dim; dx.push(s ? 100 * Math.abs(dip - dim) / s : 0);
  }
  if (dx.length < n) return null;
  let a = dx.slice(0, n).reduce((x, y) => x + y, 0) / n;
  for (let i = n; i < dx.length; i++) a = (a * (n - 1) + dx[i]) / n;
  return { adx: a, dip, dim };
}
// اتجاه إطار واحد: EMA سريع/بطيء + ميل + هيكل القمم والقيعان
module.exports = { ema, rsiVal, rsiSeries, rsi, atr, atrBase, hl, eff, body, rng, bull, bear, upw, low, bb, resample, htfTrend, patterns, levels, heikin, swings, structOf, adxOf };
},
/* ---- core/learning.js ---- */
"core/learning": function (module, exports, require) {
'use strict';
// النواة — التعلّم: أوزان الاستراتيجيات من نتائجها (محلي لكل أصل + عام عبر الأصول)، البوابة، مقارنة النسخ والمدد.
// مصنع createLearner(env) يحقن صراحةً كل ما تحتاجه هذه الوحدة، ولا شيء غيره:
//   env.cfg         الإعدادات (قراءة فقط)
//   env.book        دفتر الإحصاءات { [مفتاح الأصل@الإطار]: { s, b, e, z } } (قراءة فقط هنا؛ الكتابة في المحرك)
//   env.isLoading() هل نعيد تشغيل التاريخ الآن (يمنع استخدام الحي/الأصول الأخرى أثناءه: لا تسرّب للمستقبل)
//   env.sv()        النسخة المعتمدة لكل استراتيجية لها نسخة معدّلة
//   env.BE(asset)   نقطة التعادل للأصل
// لا DOM، لا تخزين، لا ساعة.
const { wil, nw, blank } = require('./stats');
const { IMP, STR } = require('./strategies');
const { HZ, RGS, hzLabel, qk } = require('./catalog');
const tfOfKey = k => { const i = k.lastIndexOf('@'); return i < 0 ? 60 : (+k.slice(i + 1) || 60); };
const assetOfKey = k => { const i = String(k).lastIndexOf('@'); return i < 0 ? k : k.slice(0, i); };
const emptyBook = () => ({ s: {}, b: {}, e: blank(), z: {} });

function createLearner(env) {
  const CFG = env.cfg;
  // عرض ضيق للقراءة فقط بنفس أسماء الحقول التي تستخدمها الدوال أدناه
  const S = Object.freeze({ get A() { return env.book; }, get loading() { return env.isLoading(); }, get sv() { return env.sv(); } });
  const BE = a => env.BE(a);
  const BEA = A => BE(A && A.k ? assetOfKey(A.k) : null);
  const vk = k => (IMP[k] && S.sv && S.sv[k] === 'new') ? k + '+' : k;
  function poolS(key) {
    const o = { ln: 0, lw: 0, hn: 0, hw: 0 };
    for (const a in S.A) {
      if (tfOfKey(a) !== CFG.tf) continue;
      const x = S.A[a].s[key];
      if (x) { o.ln += x.ln; o.lw += x.lw; o.hn += x.hn; o.hw += x.hw; }
    }
    return o;
  }
  // حكم المقارنة بين القديمة والمعدّلة: النتائج الحية إن كفت (≥100 لكل منهما) وإلا التاريخية. اختبار نسبتين (غير مقترن = متحفظ لأن العينتين متداخلتان)
  function variantVerdict(k) {
    const a = poolS(k), b = poolS(k + '+');
    let src = 'حي', no = a.ln, wo = a.lw, nn = b.ln, wn = b.lw;
    if (no < 100 || nn < 100) { src = 'تاريخي'; no = a.hn; wo = a.hw; nn = b.hn; wn = b.hw; }
    const eo = Math.max(wo, no - wo), en = Math.max(wn, nn - wn); // الدقة الفعلية: المعكوسة المثبتة تُستخدم معكوسة كما في grade()
    const base = { k, src, no, wo: eo, nn, wn: en };
    if (no < 100 || nn < 100) return { ...base, ok: false, better: false, worse: false, why: 'عينة غير كافية (' + no + ' / ' + nn + ' من 100)' };
    const po = eo / no, pn = en / nn, se = Math.sqrt(po * (1 - po) / no + pn * (1 - pn) / nn) || 1e-9, z = (pn - po) / se;
    const cov = nn / no;
    const better = pn - po >= .01 && z >= CFG.zStrat && cov >= .25; // v3.4: كان z ≥ 1 (≈16% إيجابيات كاذبة لكل فحص)
    const worse = z <= -1;
    const why = better ? 'أفضل بفارق ' + ((pn - po) * 100).toFixed(1) + '% (z=' + z.toFixed(2) + ')' : worse ? 'أسوأ (z=' + z.toFixed(2) + ')' : cov < .25 && pn > po ? 'أدق لكنها تقلل التغطية كثيرًا (' + Math.round(cov * 100) + '%)' : 'لا فرق مثبت (z=' + z.toFixed(2) + ')';
    return { ...base, ok: true, po, pn, z, cov, better, worse, why };
  }
  // خلية = (استراتيجية، مدة بالشمعات، حالة سوق) على أصل واحد؛ إن قلّت العينة تُجمع من بقية الأصول (نفس الإطار الزمني)
  function cellOf(A, k, h, rg) {
    const rs = rg && rg !== '-' ? [rg] : RGS;
    let n = 0, w = 0, gn = 0, gw = 0;
    for (const r of rs) {
      const key = qk(k, h, r), z = A.z[key];
      if (z) { n += z.ln + z.hn; w += z.lw + z.hw; }
      const g = zAgg(key); gn += g.ln + g.hn; gw += g.lw + g.hw;
    }
    return n >= CFG.minLocal ? { n, w, src: 'محلي' } : gn > n ? { n: gn, w: gw, src: 'عام' } : { n, w, src: 'محلي' };
  }
  // أنسب مدة لهذه الحالة: تجمع خلايا الاستراتيجيات المصوّتة مع الاتجاه (المعكوسة تُحسب معكوسة) وتختار أعلى حد أدنى للدقة
  function bestHz(A, rg, items, dir) {
    if (!A || S.loading) return null;
    const act = items.filter(x => x.v * dir > 0);
    let res = null;
    for (const h of HZ) {
      let n = 0, w = 0;
      for (const x of act) { const c = cellOf(A, x.ak, h, rg); n += c.n; w += x.inv ? c.n - c.w : c.w; }
      if (n < 60) continue;
      const lb = wil(n, w, 1.28);
      if (!res || lb > res.lb) res = { h, lb, acc: w / n, n };
    }
    return res;
  }
  // A يُمرَّر صراحةً (قراءة فقط): كانت getA(asset) تُنشئ سجلًا فارغًا في الحالة لمجرد العرض.
  function stratMatrix(asset, rg, A) {
    A = A || emptyBook();
    const be = BE(asset);
    return STR.map(([k, kind]) => {
      const ak = vk(k), cells = HZ.map(h => cellOf(A, ak, h, rg));
      const lbs = cells.map(c => c.n >= 30 ? wil(c.n, c.w, CFG.zStrat) : -1);
      const bi = lbs.reduce((b, x, i) => x > lbs[b] ? i : b, 0);
      const c1 = cells[0], p1 = c1.n ? c1.w / c1.n : 0;
      let st = 'غير مثبتة', cls = 'm';
      if (lbs[0] > be) { st = 'مختارة للمدة الحالية'; cls = 'u'; }
      else if (lbs[bi] > be) { st = 'تصلح لمدة ' + hzLabel(HZ[bi], CFG.tf); cls = 'g'; }
      else if (c1.n >= 30 && wil(c1.n, c1.n - c1.w, CFG.zStrat) > be) { st = 'عكسية'; cls = 'g'; }
      else if (c1.n >= 80 && p1 < .47) { st = 'مستبعدة'; cls = 'd'; }
      return { k, ak, cells, bi: lbs[bi] > -1 ? bi : -1, st, cls };
    });
  }

  // ================= التعلّم: محلي لكل أصل + عام عبر كل الأصول =================
  // بيانات التاريخ (hn/hw) = تدريب فقط. النتائج الحية (ln/lw) = اختبار خارج العينة، وهي الوحيدة التي تُستخدم في البوابة.
  function statOf(A, k) {
    // أثناء إعادة تشغيل التاريخ نستخدم إحصاء التاريخ المتراكم حتى تلك اللحظة فقط (بدون نتائج حية أو أصول أخرى): منع تسرب المستقبل
    const local = A.s[k] ? (S.loading ? [A.s[k].hn, A.s[k].hw] : nw(A.s[k])) : [0, 0];
    if (S.loading || local[0] >= CFG.minLocal) return { n: local[0], w: local[1], src: 'محلي' };
    let gn = 0, gw = 0;
    for (const a in S.A) {
      if (tfOfKey(a) !== CFG.tf) continue;
      const o = S.A[a].s[k];
      if (o) { const [x, y] = nw(o); gn += x; gw += y; }
    }
    if (gn > local[0]) return { n: gn, w: gw, src: 'عام' };
    return { n: local[0], w: local[1], src: 'محلي' };
  }
  // تقييم عيّنة (n, w) → وزن ونمط. gp = متوسط أداء الاستراتيجية على بقية الأصول (يُنكمش نحوه بدل 50%)
  function grade(n, w, src, gp = .5, be = BE()) {
    if (!n) return { w: .25, mode: 'جديدة', inv: false, p: .5, n: 0, src, lb: 0 };
    const p = w / n;
    const lb = wil(n, w, CFG.zStrat);
    if (n < CFG.minLocal) return { w: .25, mode: 'تتعلم', inv: false, p, n, src, lb };
    const ps = (w + CFG.prior * gp) / (n + CFG.prior); // انكماش نحو أداء بقية الأصول للعينات الصغيرة
    if (n >= CFG.minTrust && lb > be) return { w: Math.min(1.2, .4 + (ps - .5) * 4), mode: 'رابحة', inv: false, p, n, src, lb };
    if (n >= CFG.minTrust && wil(n, n - w, CFG.zStrat) > be) return { w: Math.min(1.2, .4 + (.5 - ps) * 4), mode: 'عكسية', inv: true, p, n, src, lb };
    // v3.4: «معطلة» فقط إذا ثبت إحصائيًا أنها أسوأ من العشوائي (الحد الأعلى للدقة < 50% بنفس z). كان يكفي p<47% على 80 عينة:
    // ضمن مدى الضوضاء (الخطأ المعياري ≈ 5.6%)، فكانت ~10% من الاستراتيجيات تُعطَّل صدفة على بيانات عشوائية.
    if (n >= CFG.minTrust && 1 - wil(n, n - w, CFG.zStrat) < .5) return { w: 0, mode: 'معطلة', inv: false, p, n, src, lb };
    return { w: .2, mode: 'محايدة', inv: false, p, n, src, lb };
  }
  // متوسط أداء الاستراتيجية (أو مفتاح نظام) على الأصول الأخرى، بنفس الإطار الزمني
  function gpOf(A, k) {
    if (S.loading) return .5;
    let gn = 0, gw = 0;
    for (const a in S.A) {
      if (S.A[a] === A || tfOfKey(a) !== CFG.tf) continue;
      const o = S.A[a].s[k];
      if (o) { const [x, y] = nw(o); gn += x; gw += y; }
    }
    return gn >= 100 ? gw / gn : .5;
  }
  function wt(A, k) {
    const { n, w, src } = statOf(A, k);
    return grade(n, w, src, src === 'محلي' ? gpOf(A, k) : .5, BEA(A));
  }
  // وزن حسب حالة السوق الحالية: إذا توفرت عيّنة كافية لهذه الاستراتيجية في هذه الحالة على هذا الأصل، تُحكم عليها وحدها
  function wtR(A, k, regime) {
    let W = wt(A, k);
    if (regime && regime !== '-') {
      const rk = k + '#' + regime, s = statOf(A, rk);
      if (s.n >= CFG.minRegime) {
        const R = grade(s.n, s.w, s.src, s.src === 'محلي' ? gpOf(A, rk) : .5, BEA(A));
        R.rg = true;
        W = R;
      }
    }
    return drift(A, k, W);
  }
  // كشف التدهور: آخر driftN نتيجة حية. إن كان الحد الأعلى لدقتها الفعلية أقل من التعادل يُخفَّض الوزن إلى الربع حتى تتعافى
  function drift(A, k, W) {
    if (S.loading) return W;
    const o = A.s[k], rc = o && o.rc ? o.rc : [], N = CFG.driftN;
    if (rc.length < N) return W;
    const ws = rc.slice(-N).reduce((a, x) => a + x, 0);
    const ew = W.inv ? N - ws : ws;
    W.rp = ew / N;
    const upper = 1 - wil(N, N - ew, CFG.driftZ);
    if ((W.mode === 'رابحة' || W.mode === 'عكسية') && upper < BEA(A)) return { ...W, w: W.w * .25, mode: 'متدهورة' };
    return W;
  }
  function bestBucket(A) {
    let best = null;
    for (const k in A.b) {
      const n = A.b[k].ln, w = A.b[k].lw;
      if (n < CFG.minLive) continue;
      const lb = wil(n, w, CFG.gateZ);
      if (!best || lb > best.lb) best = { k, lb, n, acc: w / n };
    }
    return best;
  }

  function zAgg(key) {
    const o = { ln: 0, lw: 0, hn: 0, hw: 0 };
    for (const a in S.A) {
      if (tfOfKey(a) !== CFG.tf) continue;
      const z = S.A[a].z && S.A[a].z[key];
      if (z) { o.ln += z.ln; o.lw += z.lw; o.hn += z.hn; o.hw += z.hw; }
    }
    return o;
  }
  function expReady(e) {
    if (e.ref || e.k === 'base') return { ok: false, why: 'مرجع' };
    const x = zAgg('x|' + e.k), b = zAgg('x|base'), n = x.ln, w = x.lw;
    if (n < CFG.minLive) return { ok: false, why: 'عينة حية ' + n + '/' + CFG.minLive };
    const lb = wil(n, w, CFG.gateZ);
    if (lb <= BE()) return { ok: false, why: 'الحد الأدنى ' + Math.round(lb * 100) + '% ≤ التعادل' };
    if (b.ln >= 30 && w / n < b.lw / b.ln + .02) return { ok: false, why: 'ليست أفضل من الأساس بفارق 2%' };
    return { ok: true, why: 'جاهزة للاعتماد' };
  }
  const sameCfg = e => Object.keys(e.o).every(k => JSON.stringify(CFG[k]) === JSON.stringify(e.o[k]));
  // بوابة الإثبات: النتائج الحية فقط
  function gate(r, A) {
    if (!r || r.d === 'none') return { ok: false, why: 'لا توجد إشارة' };
    const b = A.b[r.bk];
    if (!b) return { ok: false, why: 'لا بيانات لفئة هذه الثقة' };
    const n = b.ln, w = b.lw;
    if (n < CFG.minLive) return { ok: false, why: 'عينة حية ' + n + '/' + CFG.minLive };
    const lb = wil(n, w, CFG.gateZ), be = BEA(A);
    if (lb <= be) return { ok: false, why: 'الحد الأدنى للدقة ' + (lb * 100).toFixed(0) + '% ≤ التعادل' };
    const rc = b.rc || [];
    if (rc.length < CFG.recentN) return { ok: false, why: 'تأكيد حديث ' + rc.length + '/' + CFG.recentN };
    const rp = rc.slice(-CFG.recentN).reduce((a, x) => a + x, 0) / CFG.recentN;
    if (rp < be) return { ok: false, why: 'آخر ' + CFG.recentN + ' إشارة: ' + (rp * 100).toFixed(0) + '% < التعادل' };
    return { ok: true, why: 'مثبتة حيًا (' + (w / n * 100).toFixed(0) + '% من ' + n + ')' };
  }
  return { vk, poolS, variantVerdict, cellOf, bestHz, stratMatrix, statOf, grade, gpOf, wt, wtR, drift, bestBucket, zAgg, expReady, sameCfg, gate };
}
module.exports = { createLearner, tfOfKey, assetOfKey, emptyBook };
},
/* ---- core/quality.js ---- */
"core/quality": function (module, exports, require) {
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
},
/* ---- core/stats.js ---- */
"core/stats": function (module, exports, require) {
'use strict';
// النواة — أدوات إحصائية بحتة (بلا حالة، بلا DOM، بلا ساعة).
const clamp = (v, a = -1, b = 1) => Math.max(a, Math.min(b, v));
// ================= الإحصاء =================
const blank = () => ({ hn: 0, hw: 0, ln: 0, lw: 0, rc: [] });
const slot = (o, k) => o[k] || (o[k] = blank());
const nw = o => [o.hn + o.ln, o.hw + o.lw];
const rec = (o, win, live) => {
  if (live) {
    o.ln++; if (win) o.lw++;
    const r = o.rc || (o.rc = []);
    r.push(win ? 1 : 0);
    if (r.length > 50) r.shift();
  } else { o.hn++; if (win) o.hw++; }
};
const wil = (n, w, z = 1.64) => {
  if (!n) return 0;
  const p = w / n, d = 1 + z * z / n;
  return (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
};
const bucket = conf => String(Math.floor(conf / 5) * 5);
module.exports = { clamp, blank, slot, nw, rec, wil, bucket };
},
/* ---- core/strategies.js ---- */
"core/strategies": function (module, exports, require) {
'use strict';
// النواة — الاستراتيجيات الـ17 ونسخها المعدّلة. كل استراتيجية دالة بحتة (cs, c, X) → [صوت بين −1 و+1، وصف].
// هذه الوحدة «تصوّت» فقط؛ الأوزان (التعلّم) في learning.js والقرار في decision.js.
const { ema, eff, hl, bb, body, rng, bull, bear, upw, low, patterns, levels, heikin, rsi, atr } = require('./indicators');
const { clamp } = require('./stats');
// ================= الاستراتيجيات (17) =================
const NM = {
  trend: 'ترند EMA', rsi: 'RSI', boll: 'بولينجر', macd: 'MACD', stoch: 'ستوكاستك',
  candles: 'أنماط الشموع', sr: 'دعم/مقاومة', break: 'اختراق', ha: 'هايكن آيش', cci: 'CCI',
  willr: 'ويليامز %R', mom: 'الزخم', lin: 'انحدار خطي', streak: 'إنهاك التتابع',
  pin: 'شمعة الرفض', squeeze: 'انفجار الانضغاط', kelt: 'كيلتنر'
};
// v2.5: مجموعات المؤشرات المترابطة. المؤشرات داخل المجموعة تقيس سلوكًا متقاربًا فلا تُعدّ أصواتًا مستقلة.
const GRP = {
  trend: 'T', macd: 'T', mom: 'T', lin: 'T', ha: 'T',
  rsi: 'O', stoch: 'O', cci: 'O', willr: 'O', boll: 'O', kelt: 'O',
  break: 'K', squeeze: 'K', candles: 'P', pin: 'P', sr: 'S', streak: 'X'
};
const STR = [
  // v3.4: نفس القيم السابقة تمامًا عند عدم التساوي؛ التساوي (سوق ساكن) كان يُحسب هابطًا (−1) وأصبح 0
  ['trend', 'T', (cs, c) => { const e9 = ema(c, 9), e21 = ema(c, 21), e50 = ema(c, 50), n = c.length - 1, sg = Math.sign; return [clamp((sg(e9[n] - e21[n]) + sg(e21[n] - e50[n]) + sg(e9[n] - e9[n - 3])) / 3), '']; }],
  // v2.5.1: لا ارتداد ضد اتجاه قوي + لا دخول إلا بعد أن تبدأ الشمعة بالانعكاس فعلًا (تأكيد)
  ['rsi', 'R', (cs, c, X) => {
    const l = cs[cs.length - 1];
    if (eff(c) > .35) return [0, ''];
    if (X.rsi < 30 && bull(l)) return [X.rsi < 25 ? 1 : .6, ''];
    if (X.rsi > 70 && bear(l)) return [X.rsi > 75 ? -1 : -.6, ''];
    return [0, ''];
  }],
  ['boll', 'R', (cs, c) => { const [m, sd] = bb(c, c.length - 1), z = (c[c.length - 1] - m) / sd; return [z < -2 ? 1 : z > 2 ? -1 : z < -1.5 ? .4 : z > 1.5 ? -.4 : 0, '']; }],
  ['macd', 'T', (cs, c) => {
    const e12 = ema(c, 12), e26 = ema(c, 26), m = e12.map((v, i) => v - e26[i]), sg = ema(m, 9), n = m.length - 1;
    const h = m[n] - sg[n], hp = m[n - 1] - sg[n - 1];
    return [h > 0 ? (h > hp ? .8 : .3) : h < 0 ? (h < hp ? -.8 : -.3) : 0, ''];
  }],
  ['stoch', 'R', cs => { const [h, l] = hl(cs, 14), k = h === l ? 50 : (cs[cs.length - 1].c - l) / (h - l) * 100; return [k < 15 ? 1 : k > 85 ? -1 : 0, '']; }],
  ['candles', 'N', cs => { const [v, n] = patterns(cs); return [v, n]; }],
  ['sr', 'R', (cs, c, X) => {
    const [lo, hi] = levels(cs), p = c[c.length - 1], l = cs[cs.length - 1];
    if (lo.some(v => Math.abs(p - v) < .5 * X.atr) && low(l) > body(l)) return [.9, 'ارتداد دعم'];
    if (hi.some(v => Math.abs(p - v) < .5 * X.atr) && upw(l) > body(l)) return [-.9, 'ارتداد مقاومة'];
    return [0, ''];
  }],
  ['break', 'T', (cs, c) => { const w = cs.slice(-21, -1), hh = Math.max(...w.map(x => x.h)), ll = Math.min(...w.map(x => x.l)), p = c[c.length - 1]; return [p > hh ? .9 : p < ll ? -.9 : 0, '']; }],
  ['ha', 'T', cs => {
    const h = heikin(cs), a = h.slice(-3);
    if (a.every(x => x.c > x.o)) return [Math.abs(a[2].l - Math.min(a[2].o, a[2].c)) < 1e-12 ? .9 : .6, ''];
    if (a.every(x => x.c < x.o)) return [Math.abs(a[2].h - Math.max(a[2].o, a[2].c)) < 1e-12 ? -.9 : -.6, ''];
    return [0, ''];
  }],
  ['cci', 'R', cs => {
    const w = cs.slice(-20).map(x => (x.h + x.l + x.c) / 3), m = w.reduce((a, b) => a + b) / 20;
    const md = w.reduce((a, b) => a + Math.abs(b - m), 0) / 20 || 1e-12, v = (w[19] - m) / (.015 * md);
    // v2.5.1: نفس فكرة RSI: فلتر اتجاه قوي + تأكيد انعكاس الشمعة
    const l = cs[cs.length - 1];
    if (eff(cs.map(x => x.c)) > .35) return [0, ''];
    if (v < -100 && bull(l)) return [v < -150 ? 1 : .6, ''];
    if (v > 100 && bear(l)) return [v > 150 ? -1 : -.6, ''];
    return [0, ''];
  }],
  ['willr', 'R', cs => { const [h, l] = hl(cs, 14), v = h === l ? -50 : (h - cs[cs.length - 1].c) / (h - l) * -100; return [v < -90 ? 1 : v < -80 ? .5 : v > -10 ? -1 : v > -20 ? -.5 : 0, '']; }],
  ['mom', 'T', (cs, c, X) => [clamp((c[c.length - 1] - c[c.length - 6]) / (X.atr * 2.5)), '']],
  ['lin', 'T', (cs, c, X) => {
    const w = c.slice(-20), n = 20, mx = 9.5, my = w.reduce((a, b) => a + b) / n;
    let num = 0, den = 0;
    w.forEach((v, i) => { num += (i - mx) * (v - my); den += (i - mx) ** 2; });
    return [clamp(num / den / X.atr * 3), ''];
  }],
  ['streak', 'R', cs => {
    const sd = x => Math.sign(x.c - x.o), d0 = sd(cs[cs.length - 1]), dir = d0 > 0;
    if (!d0) return [0, '']; // دوجي يقطع التتابع
    let k = 0;
    for (let i = cs.length - 1; i >= 0 && sd(cs[i]) === d0; i--) k++;
    return [k >= 5 ? (dir ? -.9 : .9) : k === 4 ? (dir ? -.6 : .6) : 0, k >= 4 ? 'تتابع ' + k : ''];
  }],
  ['pin', 'N', cs => {
    const x = cs[cs.length - 1], r = rng(x);
    if (low(x) >= 2 * body(x) && low(x) > .5 * r && (x.c - x.l) / r > .6) return [.7, 'رفض سفلي'];
    if (upw(x) >= 2 * body(x) && upw(x) > .5 * r && (x.h - x.c) / r > .6) return [-.7, 'رفض علوي'];
    return [0, ''];
  }],
  // v3.4: الانضغاط يُقاس حتى الشمعة السابقة. كان يشمل شمعة الاختراق نفسها فيتسع الانحراف فيبطل شرط الانضغاط دائمًا تقريبًا.
  ['squeeze', 'T', (cs, c) => {
    const n = c.length - 1, ws = [];
    for (let i = n - 50; i <= n - 1; i++) { const [, sd] = bb(c, i); ws.push(sd); }
    const cur = ws[ws.length - 1], rank = ws.filter(v => v < cur).length / ws.length;
    const [m, sd] = bb(c, n - 1);
    if (rank <= .25) {
      if (c[n] > m + 2 * sd) return [.8, 'انضغاط واختراق ↑'];
      if (c[n] < m - 2 * sd) return [-.8, 'انضغاط واختراق ↓'];
    }
    return [0, ''];
  }],
  // v2.5.1: كيلتنر — فلتر اتجاه قوي + تأكيد انعكاس الشمعة (الحد 1.5 ATR بدل 2 لأن التأكيد يقلل الإشارات الكاذبة)
  ['kelt', 'R', (cs, c, X) => {
    const e = ema(c, 20), n = c.length - 1, l = cs[n];
    if (eff(c) > .35) return [0, ''];
    if (c[n] > e[n] + 1.5 * X.atr && bear(l)) return [-.7, ''];
    if (c[n] < e[n] - 1.5 * X.atr && bull(l)) return [.7, ''];
    return [0, ''];
  }]
];
const SK = STR.map(s => s[0]);

// ================= v3.2: نسخ محسّنة للاستراتيجيات + اختبار قبل الاعتماد =================
// كل استراتيجية معدّلة تعمل بجانب نسختها القديمة (الأصل لا يُحذف). النسختان تُسجَّلان على نفس الشموع:
// القديمة تحت المفتاح k والمعدّلة تحت k+. لا تُستخدم المعدّلة في القرار إلا إذا أثبتت تفوقًا (evalVariants)، وتُعاد للقديمة إن تدهورت.
const IMP = {
  // بولينجر: لا ارتداد ضد اتجاه قوي + تأكيد انعكاس الشمعة (كان يرتد بلا تأكيد وبلا فلتر اتجاه)
  boll: (cs, c) => {
    const n = c.length - 1, [m, sd] = bb(c, n), z = (c[n] - m) / sd, l = cs[n];
    if (eff(c) > .35) return [0, ''];
    if (z < -1.5 && bull(l)) return [z < -2 ? 1 : .4, ''];
    if (z > 1.5 && bear(l)) return [z > 2 ? -1 : -.4, ''];
    return [0, ''];
  },
  // MACD: منطقة ميتة (تقاطع بلا قوة نسبة إلى ATR لا يُعدّ صوتًا) + تخفيض الصوت المعاكس لجهة خط MACD
  macd: (cs, c, X) => {
    const e12 = ema(c, 12), e26 = ema(c, 26), m = e12.map((v, i) => v - e26[i]), sg = ema(m, 9), n = m.length - 1;
    const h = m[n] - sg[n], hp = m[n - 1] - sg[n - 1];
    if (!(Math.abs(h) / X.atr >= .03)) return [0, '']; // v3.4: يشمل ATR=0 (كانت 0/0=NaN تمرّ وتعطي صوتًا هابطًا في السوق الساكن)
    const up = h > 0, grow = up ? h > hp : h < hp;
    let v = grow ? .8 : .3;
    if ((up && m[n] < 0) || (!up && m[n] > 0)) v *= .7;
    return [up ? v : -v, ''];
  },
  // ستوكاستك: يحتاج تقاطع %K/%D داخل منطقة التشبع (لا مجرد الوصول إليها) + فلتر اتجاه قوي
  stoch: (cs, c) => {
    if (eff(c) > .35) return [0, ''];
    const n = cs.length - 1;
    const kAt = i => { const w = cs.slice(i - 13, i + 1), h = Math.max(...w.map(x => x.h)), l = Math.min(...w.map(x => x.l)); return h === l ? 50 : (cs[i].c - l) / (h - l) * 100; };
    const k0 = kAt(n), k1 = kAt(n - 1), k2 = kAt(n - 2), k3 = kAt(n - 3), d0 = (k0 + k1 + k2) / 3, d1 = (k1 + k2 + k3) / 3;
    if (k0 < 20 && k0 > d0 && k1 <= d1) return [k0 < 10 ? 1 : .8, ''];
    if (k0 > 80 && k0 < d0 && k1 >= d1) return [k0 > 90 ? -1 : -.8, ''];
    if (k0 < 15 && bull(cs[n])) return [.5, ''];
    if (k0 > 85 && bear(cs[n])) return [-.5, ''];
    return [0, ''];
  },
  // ويليامز %R: نفس منطق RSI (فلتر اتجاه + تأكيد انعكاس)
  willr: (cs, c) => {
    if (eff(c) > .35) return [0, ''];
    const l = cs[cs.length - 1], [h, lo] = hl(cs, 14), v = h === lo ? -50 : (h - l.c) / (h - lo) * -100;
    if (v < -90 && bull(l)) return [1, ''];
    if (v < -80 && bull(l)) return [.5, ''];
    if (v > -10 && bear(l)) return [-1, ''];
    if (v > -20 && bear(l)) return [-.5, ''];
    return [0, ''];
  },
  // اختراق: إغلاق خلف القمة/القاع بهامش 0.1 ATR + جسم ≥40% من المدى + ذيل رفض ≤40% (يستبعد الاختراق الوهمي بذيل)
  break: (cs, c, X) => {
    const w = cs.slice(-21, -1), hh = Math.max(...w.map(x => x.h)), ll = Math.min(...w.map(x => x.l)), l = cs[cs.length - 1], p = c[c.length - 1];
    if (p > hh + .1 * X.atr && body(l) >= .4 * rng(l) && upw(l) <= .4 * rng(l)) return [.9, ''];
    if (p < ll - .1 * X.atr && body(l) >= .4 * rng(l) && low(l) <= .4 * rng(l)) return [-.9, ''];
    return [0, ''];
  },
  // إنهاك التتابع: لا يُعاكس التتابع إلا إذا ضعف جسم آخر شمعة (الزخم بدأ يخبو) وإلا فالاتجاه مستمر
  streak: cs => {
    const l = cs[cs.length - 1], p = cs[cs.length - 2], sd = x => Math.sign(x.c - x.o), d0 = sd(l), dir = d0 > 0;
    if (!d0) return [0, ''];
    let k = 0;
    for (let i = cs.length - 1; i >= 0 && sd(cs[i]) === d0; i--) k++;
    if (k < 4 || !(body(l) < .8 * body(p))) return [0, ''];
    return [k >= 5 ? (dir ? -.9 : .9) : (dir ? -.6 : .6), 'تتابع ' + k];
  }
};
const IMPK = Object.keys(IMP);

// أصوات كل الاستراتيجيات على شموع معطاة. useNew(k) يحدد النسخة المعتمدة لكل استراتيجية لها نسخة معدّلة.
// onErr(k, e): الخطأ داخل استراتيجية لا يُبتلع — صوتها 0 ويُبلَّغ المستدعي (المحرك يسجّله).
// يعيد: raw (كل الأصوات الخام بما فيها النسخ المعدّلة k+)، list (صوت النسخة المعتمدة لكل استراتيجية مع نوعها ووصفها).
function evaluate(cs, c, X, useNew, onErr) {
  const raw = {}, list = [];
  for (const [k, kind, fn] of STR) {
    let v = 0, n = '';
    try { [v, n] = fn(cs, c, X); } catch (e) { if (onErr) onErr(k, e); }
    if (!Number.isFinite(v)) v = 0;
    raw[k] = v;
    let ak = k, det = n;
    if (IMP[k]) {
      let v2 = 0, n2 = '';
      try { [v2, n2] = IMP[k](cs, c, X); } catch (e) { if (onErr) onErr(k + '+', e); }
      if (!Number.isFinite(v2)) v2 = 0;
      raw[k + '+'] = v2;
      if (useNew && useNew(k)) { v = v2; ak = k + '+'; det = n2; }
    }
    list.push({ k, kind, ak, v, det });
  }
  return { raw, list };
}
// قراءات الاستراتيجيات الخام (تُستخدم أيضًا في اختبار ثبات القراءات بعد إغلاق الشمعة)
function rawVotes(cs, onErr) {
  const c = cs.map(x => x.c), X = { rsi: rsi(c), atr: atr(cs) };
  return evaluate(cs, c, X, null, onErr).raw;
}
module.exports = { NM, GRP, STR, SK, IMP, IMPK, evaluate, rawVotes };
},
/* ---- engine/commands.js ---- */
"engine/commands": function (module, exports, require) {
'use strict';
// المحرك — الأوامر: القناة الوحيدة التي تغيّر بها الواجهة حالة المحرك. كل أمر يطابق ما كان يفعله زر الواجهة في v3.5 حرفيًا،
// لكنه الآن في المحرك (قابل للاختبار) بدل أن تعدّل الواجهة S وCFG مباشرة.
// لا يوجد أي أمر تنفيذ مالي: «الدخول الآلي» هنا صفقات افتراضية فقط، ولا يُحفظ تفعيله.
const { clamp } = require('../core/stats');
const { KEYS } = require('./state');

module.exports = function install(E) {
  const { S, CFG } = E;
  const [saveState, saveCfg, LSset, killSwitch, setPayout, payoutOf, setTf, adoptExp, resetCfg, buildExport, importData, resetLearning, norm] =
    E.use('saveState', 'saveCfg', 'LSset', 'killSwitch', 'setPayout', 'payoutOf', 'setTf', 'adoptExp', 'resetCfg', 'buildExport', 'importData', 'resetLearning', 'norm');
  const cmd = {
    // الدخول الآلي الافتراضي (محاكاة فقط). التشغيل يبدأ جلسة محاكاة جديدة (صافي 0، يرفع الإيقاف).
    setAuto(on) {
      if (!on) { CFG.auto = false; saveState(); return false; }
      CFG.auto = true; S.halted = false; S.haltWhy = ''; S.net = 0; S.unkRow = 0; S.failRow = 0;
      saveState();
      return true;
    },
    toggleAuto() { return cmd.setAuto(!CFG.auto); },
    kill() { killSwitch('إيقاف طارئ'); },
    clearErrors() { S.errors = []; S.trace = []; LSset(KEYS.ERR, []); },
    toggleGate() { CFG.gate = !CFG.gate; saveCfg(); return CFG.gate; },
    setMinConf(v) { CFG.minConf = +v; saveCfg(); return CFG.minConf; },
    // العائد للأصل الحالي (نسبة مئوية من الواجهة)
    setPayoutPct(pct) { setPayout(S.cur, clamp(+pct, 60, 98) / 100); return Math.round(payoutOf(S.cur) * 100); },
    setTf(v) { return setTf(+v); },
    // قفل التحليل على أصل: الأصل المعروض في الصفحة إن عُرف، وإلا الأصل الحالي. shown تمرّره طبقة المنصة.
    toggleLock(shown) {
      const hit = shown && Object.keys(S.candles).find(a => norm(a) === norm(shown));
      S.lock = S.lock ? null : (hit || S.cur);
      return S.lock;
    },
    adopt(k) { return adoptExp(k); },
    resetRules() { resetCfg(); },
    exportMemory() { return buildExport(); },
    importMemory(text) { importData(text); },
    resetLearning() { resetLearning(); }
  };
  E.cmd = cmd;
};
},
/* ---- engine/context.js ---- */
"engine/context": function (module, exports, require) {
'use strict';
// سياق المحرك: يربط أجزاءه (التخزين، المحاكاة، المختبر، المسجّل، العرض) دون متغيرات عامة.
// - كل جزء يسجّل دواله بـ provide({...}) ويعلن صراحةً ما يحتاجه من غيره بـ use('name', ...).
//   الربط متأخر (عند الاستدعاء)، فلا يهم ترتيب تركيب الأجزاء، وأي اعتماد ناقص يظهر كخطأ صريح لا كـ undefined.
// - البيئة env تُحقن من الخارج: الساعة now()، التخزين storage (واجهة localStorage)، indexedDB، وconsole.
//   في المتصفح تأتي من window؛ في الاختبارات من بدائل مضبوطة.
function createContext(env) {
  const fn = {};
  const listeners = {};
  const E = {
    env,
    fn,
    clock: env.now || (() => Date.now()),
    provide(obj) {
      for (const k in obj) {
        if (Object.prototype.hasOwnProperty.call(fn, k)) throw new Error('engine: duplicate provider for ' + k);
        fn[k] = obj[k];
      }
    },
    use(...names) {
      return names.map(n => (...a) => {
        const f = fn[n];
        if (typeof f !== 'function') throw new Error('engine: missing dependency ' + n);
        return f(...a);
      });
    },
    // ناقل أحداث بسيط: المحرك يُصدر، الواجهة والمسجّل يستمعان. خطأ مستمع لا يوقف المحرك.
    on(type, f) { (listeners[type] = listeners[type] || []).push(f); return () => { listeners[type] = listeners[type].filter(x => x !== f); }; },
    emit(type, payload) {
      for (const f of listeners[type] || []) { try { f(payload); } catch (e) { try { env.console && env.console.warn('[wsnf] listener', type, e); } catch (_) {} } }
    }
  };
  return E;
}
module.exports = { createContext };
},
/* ---- engine/engine.js ---- */
"engine/engine": function (module, exports, require) {
'use strict';
// المحرك — من التيك إلى القرار: بناء الشموع، إغلاقها، تسوية نتائج الشمعة السابقة، التحليل، الصفقات الظلّية والافتراضية.
// يقرأ ويكتب حالة المحرك فقط. لا DOM ولا WebSocket (طبقة المنصة تستدعي feedTick/loadHistory/connOpen/connLost).
// يُصدر الأحداث: 'candle' (إغلاق شمعة)، 'ws'، 'history'، 'stale'، 'tf' — يستمع لها المسجّل والواجهة.
const { rec, slot, blank } = require('../core/stats');
const { rawVotes } = require('../core/strategies');
const { liveBlock } = require('../core/quality');
const { analyze, noneR } = require('../core/decision');
const { assetOfKey, tfOfKey } = require('../core/learning');
const { KEYS } = require('./state');

module.exports = function install(E) {
  const { S, CFG } = E, clock = E.clock;
  const [logErr, save, saveCfg, saveState, LSset, settleShadows, registerShadows, evalVariants, isOwn, settle, settleTie, maybeTrade, confirmOrder, finishOpen, failPending, voidTrade] = E.use('logErr', 'save', 'saveCfg', 'saveState', 'LSset', 'settleShadows', 'registerShadows', 'evalVariants', 'isOwn', 'settle', 'settleTie', 'maybeTrade', 'confirmOrder', 'finishOpen', 'failPending', 'voidTrade');
  // العائد يختلف من أصل لآخر: نقطة التعادل = 1 / (1 + العائد)
  const payoutOf = a => { const v = a && CFG.payoutBy ? CFG.payoutBy[a] : undefined; return Number.isFinite(v) ? v : CFG.payout; };
  const BE = a => 1 / (1 + payoutOf(a));
  const BEA = A => BE(A && A.k ? assetOfKey(A.k) : null); // assetOfKey من learning.js
  // المفتاح يتضمن مدة الشمعة حتى لا تختلط إحصاءات أطر زمنية مختلفة
  const AK = a => CFG.tf === 60 ? a : a + '@' + CFG.tf;
  const getAK = k => S.A[k] || (S.A[k] = { k, s: {}, b: {}, e: blank(), z: {} });
  const getA = a => getAK(AK(a));
  const stratErrAt = {};
  function stratErr(k, e) {
    const now = clock();
    if (stratErrAt[k] && now - stratErrAt[k] < 6e5) return;
    stratErrAt[k] = now;
    logErr('STRAT_ERR', k + ': ' + String(e && e.message || e));
  }
  // ================= الشموع من التيك =================
  function feedTick(asset, ts, p) {
    if (!Number.isFinite(ts) || !Number.isFinite(p) || p <= 0) return;
    if (S.lock && asset !== S.lock) return;
    const t = Math.floor(ts / CFG.tf) * CFG.tf;
    const arr = S.candles[asset] || (S.candles[asset] = []);
    const c = arr[arr.length - 1];
    if (c && c.t > t) return; // تيك قديم/خارج الترتيب
    if (!S.loading) { S.lastRx[asset] = clock(); S.lastPx[asset] = p; S.tickTs[asset] = ts; }
    if (!c || c.t < t) {
      if (c) onClose(asset, arr, t, ts);
      // sl/sh: هل وصلت الشمعة تيكات حية/تاريخية · mg: أكبر فجوة بين تيكين · rx0: ساعة الجهاز عند أول تيك حي (لكشف الانقطاع أثناءها)
      arr.push({ t, o: p, h: p, l: p, c: p, ft: ts, lt: ts, nt: 1, sl: !S.loading, sh: S.loading, mg: 0, rx0: S.loading ? 0 : clock() });
      if (arr.length > CFG.maxCandles) arr.shift();
    } else if (ts < c.lt) {
      // v3.4: تيك متأخر داخل الشمعة نفسها: حدث فعلًا فيدخل في القمة/القاع، لكنه ليس آخر سعر فلا يغيّر الإغلاق
      c.h = Math.max(c.h, p); c.l = Math.min(c.l, p); c.nt++;
      if (S.loading) c.sh = true; else { c.sl = true; if (!c.rx0) c.rx0 = clock(); }
    } else {
      if (ts - c.lt > (c.mg || 0)) c.mg = ts - c.lt;
      c.h = Math.max(c.h, p); c.l = Math.min(c.l, p); c.c = p; c.lt = ts; c.nt++;
      if (S.loading) c.sh = true; else { c.sl = true; if (!c.rx0) c.rx0 = clock(); }
    }
    S.cur = asset; S.ticks++; S.lastTs[asset] = ts;
    if (!S.loading) {
      const pd = S.pending;
      if (pd && pd.asset === asset && ts > pd.sendTs) confirmOrder(p, ts);
      const o = S.open;
      if (o && o.asset === asset && ts >= o.expTs) finishOpen(p, ts);
    }
  }
  function onClose(asset, arr, tNew, tsNow) {
    const c = arr[arr.length - 1], A = getA(asset), live = !S.loading, pd = S.P[asset];
    const tol = Math.max(5, CFG.edgeTol * CFG.tf);
    // الشمعة المكتملة: أول تيك قريب من بدايتها وآخر تيك قريب من نهايتها
    const complete = (c.ft - c.t) <= tol && (c.t + CFG.tf - c.lt) <= tol;
    // تدقيق عدم استخدام المستقبل: لا نحلّل إلا شمعة أُغلقت فعلًا وبترتيب زمني سليم
    const aud = S.audit;
    aud.n++;
    let bad = '';
    if (tNew !== undefined && !(c.t < tNew)) bad = 'الشمعة المحللة لم تُغلق بعد';
    else if (tsNow !== undefined && tsNow < c.t + CFG.tf) bad = 'تحليل شمعة قبل انتهاء وقتها';
    else if (arr.length > 1 && !(arr[arr.length - 2].t < c.t)) bad = 'ترتيب الشموع الزمني مختل';
    if (bad) { aud.bad++; aud.last = bad; logErr('LOOKAHEAD', asset + ': ' + bad); }
    // المسجّل: الشمعة أُغلقت للتو (وصل تيك بعد نهايتها). لا يؤثر على التحليل التالي.
    E.emit('candle', { asset, c, complete, tsClose: tsNow, bad, live, tf: CFG.tf, wsCloseAt: S.wsCloseAt });
    settleShadows(asset, A, c, complete, live);
    const nextOK = !!pd && c.t - pd.ct === CFG.tf && pd.ok === true && complete;
    if (pd && pd.log && pd.log.win === null && !pd.log.tie && !isOwn(pd.log) && !nextOK) pd.log.stale = true;
    if (nextOK && c.c === pd.entry && pd.log && !isOwn(pd.log)) settleTie(pd.log, c.c);
    if (nextOK && c.c !== pd.entry) {
      const up = c.c > pd.entry;
      for (const k in pd.raw) if (pd.raw[k] !== 0) { // v3.4: كل صوت مستخدم في القرار يُقيَّم (كانت الأصوات < 0.5 تُستخدم ولا تُقيَّم)
        const ok1 = (pd.raw[k] > 0) === up;
        rec(slot(A.s, k), ok1, live);
        if (pd.regime && pd.regime !== '-') rec(slot(A.s, k + '#' + pd.regime), ok1, live); // أداء الاستراتيجية في هذه الحالة على هذا الأصل
      }
      if (pd.dir !== 'none') {
        const win = (pd.dir === 'call') === up;
        if (pd.log) pd.log.candleWin = win; // نتيجة «إغلاق مقابل إغلاق» (ما يتعلّم منه البوت) تُحفظ بجانب نتيجة الصفقة الافتراضية
        rec(A.e, win, live);
        rec(slot(A.b, pd.bk), win, live);
        if (pd.log && !isOwn(pd.log)) settle(pd.log, c.c, win);
      }
    }
    // اختبار ثبات القراءات: نعيد حساب قراءات الشمعة السابقة بعد إغلاقها ونقارنها بما استُخدم وقت القرار
    if (nextOK && live && pd.raw && Object.keys(pd.raw).length && aud.n % 6 === 0) {
      const i = arr.length - 2;
      if (i >= 0 && arr[i].t === pd.ct) {
        const re = rawVotes(arr.slice(Math.max(0, i + 1 - CFG.window), i + 1), stratErr);
        aud.tests++;
        if (Object.keys(pd.raw).some(k => Math.abs((re[k] || 0) - pd.raw[k]) > 1e-9)) { aud.testBad++; aud.last = 'تغيّرت قراءة مؤشر بعد إغلاق الشمعة'; logErr('LOOKAHEAD', asset + ': ' + aud.last); }
      }
    }
    const blk = liveBlock(arr, tNew, { live, wsUp: S.wsUp, tf: CFG.tf, contigN: CFG.contigN });
    // asOf = وقت التيك الذي أغلق الشمعة: المحلّل يرفض أي شمعة في النافذة تنتهي بعده (عقد الشموع المغلقة)
    let r = blk ? noneR(blk) : analyzeWindow(arr.slice(-CFG.window), A, asset, tsNow);
    if (bad) r = { ...r, d: 'none', conf: Math.min(r.conf, 59), abst: [bad], comp: false, sd: 0 };
    S.sigBy[asset] = r;
    S.P[asset] = { entry: c.c, ct: c.t, raw: r.raw, dir: r.d, bk: r.bk, log: null, ok: complete, regime: r.regime, at: live ? clock() : 0, atr: r.atr };
    E.clusters.trackCorr(r.rawA || r.raw, asset);
    S.ncl = (S.ncl || 0) + 1;
    if (S.ncl % 25 === 0) { try { E.clusters.rebuildClusters(); if (live) evalVariants(); } catch (e) { logErr('VAR_ERR', String(e && e.message || e)); } }
    if (r.sd) S.sdh[asset] = (S.sdh[asset] || []).concat([r.sd]).slice(-5);
    registerShadows(asset, c, r, complete, live);
    if (live) {
      save();
      if (complete && r.d !== 'none' && r.conf >= CFG.minConf) { try { maybeTrade(asset, r, c, A); } catch (e) { logErr('SIM_ERR', String(e && e.message || e)); } }
    }
  }
  function watchdog() {
    const now = clock(), pd = S.pending;
    // v3.4: تقادم السعر: إن توقف التيك تُلغى الإشارة المعروضة (لا تبقى إشارة قديمة كأنها حالية)
    for (const a in S.sigBy) {
      const r = S.sigBy[a];
      if (!r || r.stale || S.loading || !S.lastRx[a]) continue;
      const age = now - S.lastRx[a];
      if (age > CFG.maxTickAgeMs) {
        S.sigBy[a] = { ...noneR('بيانات قديمة: لا سعر منذ ' + Math.round(age / 1000) + ' ث — التحليل متوقف', r.regime), stale: true };
        E.emit('stale', { asset: a, age: Math.round(age / 1000) });
        if (S.P[a]) S.P[a].ok = false;
      }
    }
    if (pd && now - pd.at > CFG.confirmMs) failPending('لم يتأكد فتح الصفقة (لم تصل بيانات بعد الإرسال)');
    const e = S.open;
    if (e && now - e.openAt > (e.dur + 25) * 1000) {
      S.pausedUntil = Math.max(S.pausedUntil, now + CFG.staleRestMs);
      voidTrade(e, 'لم تصل نتيجة الصفقة');
    }
  }
  function onWsDown() {
    E.emit('ws', { up: false });
    if (S.pending) failPending('انقطاع الاتصال قبل التأكيد');
    if (S.open) voidTrade(S.open, 'انقطاع الاتصال أثناء الصفقة');
  }
  function setTf(v) {
    if (![15, 30, 60].includes(+v)) return false;
    if (S.pending) failPending('تغيير مدة الشمعة');
    if (S.open) voidTrade(S.open, 'تغيير مدة الشمعة', false);
    if (+v !== CFG.tf) E.emit('tf', { from: CFG.tf, to: +v });
    CFG.tf = +v; S.candles = {}; S.P = {}; S.sigBy = {}; S.fired = {}; S.SH = {}; S.sdh = {}; S.dq = {};
    saveCfg();
    return true;
  }
  function resetLearning() {
    if (S.pending) failPending('مسح التعلّم');
    if (S.open) voidTrade(S.open, 'مسح التعلّم', false);
    for (const a in S.A) delete S.A[a];
    S.log = []; S.net = 0; S.lossRow = 0; S.halted = false; S.haltWhy = ''; S.unkRow = 0; S.failRow = 0;
    S.corr = {};
    S.journal = []; S.SH = {}; S.sdh = {};
    LSset(KEYS.LIVE, {}); LSset(KEYS.LOG, []); LSset(KEYS.JOURNAL, []); saveState();
    try { E.fn.IDB.del('bak').catch(() => {}); } catch (e) {}
  }
  // سبب الإشارة بصيغة مقروءة (يُحفظ مع كل إدخال في السجل)

  // تحليل نافذة شموع مغلقة: كل مدخلات النواة تُمرَّر صراحةً من الحالة هنا (النواة لا تقرأ الحالة بنفسها).
  function analyzeWindow(cs, A, asset, asOf, allowOpen) {
    return analyze(cs, {
      cfg: CFG, A, learner: E.learner, clusters: E.clusters, asOf, allowOpen,
      useNew: k => !!(S.sv && S.sv[k] === 'new'),
      sdh: S.sdh[asset],
      tickAgeMs: (!S.loading && asset && S.lastRx[asset]) ? clock() - S.lastRx[asset] : null,
      onQuality: dq => { if (asset) S.dq[asset] = dq; },
      onStratErr: stratErr,
      onError: (code, msg) => logErr(code, msg)
    });
  }
  // تحميل التاريخ الذي ترسله المنصة: إعادة تشغيل زمنية للتيكات مع تصفير إحصاء التدريب لهذا الأصل (لا عدّ مزدوج)
  function loadHistory(a, history) {
    S.loading = true;
    S.candles[a] = []; S.P[a] = null;
    const A = getA(a);
    for (const k in A.s) A.s[k].hn = A.s[k].hw = 0;
    for (const k in A.b) A.b[k].hn = A.b[k].hw = 0;
    for (const k in A.z) A.z[k].hn = A.z[k].hw = 0;
    S.SH[a] = []; S.sdh[a] = []; S.corrH[a] = {};
    A.e.hn = A.e.hw = 0;
    history.forEach(x => feedTick(a, +x[0], +x[1]));
    S.loading = false;
    S.loadedCount = history.length;
    E.emit('history', { asset: a, ticks: history.length });
    try { E.clusters.rebuildClusters(); evalVariants(); } catch (e) { logErr('VAR_ERR', String(e && e.message || e)); }
  }
  // حالة الاتصال (تُبلَّغ من طبقة المنصة)
  function connOpen() {
    if (S.wsUp === false) E.emit('ws', { up: true });
    S.wsUp = true; S.wsUpAt = clock();
  }
  function connLost() {
    S.wsUp = false;          // نوقف التحليل والدخول فورًا
    S.wsCloseAt = clock();   // المسجّل يرفض أي شمعة حية كانت مفتوحة لحظة الانقطاع
  }
  E.provide({ payoutOf, BE, BEA, AK, tfOfKey, getAK, getA, stratErr, feedTick, onClose, watchdog, onWsDown, setTf, resetLearning, analyzeWindow, loadHistory, connOpen, connLost });
};
},
/* ---- engine/index.js ---- */
"engine/index": function (module, exports, require) {
'use strict';
// إنشاء محرك كامل ومستقل من بيئة محقونة. يمكن إنشاء أكثر من محرك في نفس العملية (لا حالة عامة على مستوى الوحدات).
// env: { now(), storage (واجهة localStorage), indexedDB?, IDBKeyRange?, console?, recMem? (للاختبارات فقط) }
const { createContext } = require('./context');
const { createState } = require('./state');
const { createLearner } = require('../core/learning');
const { createClusters } = require('../core/clusters');

function createEngine(env) {
  const E = createContext(env);
  const { CFG, S } = createState();
  E.S = S; E.CFG = CFG;
  // النواة: تُحقن بعرض ضيق من الحالة (قراءة)، فلا تعرف عن بقية المحرك شيئًا
  E.learner = createLearner({ cfg: CFG, book: S.A, isLoading: () => S.loading, sv: () => S.sv, BE: a => E.fn.BE(a) });
  E.clusters = createClusters({ cfg: CFG, corr: () => S.corr, corrH: () => S.corrH, isLoading: () => S.loading });
  require('./persist')(E);
  require('./paper')(E);
  require('./lab')(E);
  require('./engine')(E);
  require('./viewmodel')(E);
  require('./commands')(E);
  require('../recorder/recorder')(E);
  return E;
}
// تهيئة الجلسة بنفس ترتيب v3.5: استعادة الذاكرة ← النسخ المعتمدة ← المسجّل ← الدخول الآلي متوقف ← النسخة الثانية
function startEngine(E) {
  const f = E.fn;
  f.restore();
  f.loadSV();
  f.recInit();
  E.CFG.auto = false; // كل جلسة تبدأ والدخول الآلي الافتراضي متوقف
  f.idbRestore();
  return E;
}
module.exports = { createEngine, startEngine };
},
/* ---- engine/lab.js ---- */
"engine/lab": function (module, exports, require) {
'use strict';
// المحرك — المختبر: صفقات ظلّية (تجارب قواعد القرار، مدد انتهاء متعددة، إشارات محجوبة) واختيار النسخ المعدّلة.
// يكتب في دفتر الإحصاء (A.z) والدفتر؛ لا يؤثر على القرار الفعلي إلا عند اعتماد صريح (adoptExp) أو ثبوت تفوّق نسخة (evalVariants).
const { KEYS } = require('./state');
const { rec, slot } = require('../core/stats');
const { IMPK } = require('../core/strategies');
const { HZ, EXPS, DEFAULTS, qk } = require('../core/catalog');
const { decide } = require('../core/decision');

module.exports = function install(E) {
  const { S, CFG } = E, clock = E.clock;
  const L = () => E.learner;
  const [LSget, LSset, saveCfg] = E.use('LSget', 'LSset', 'saveCfg');
  function loadSV() {
    const o = LSget(KEYS.SV, {});
    S.sv = {}; S.svLog = [];
    for (const k of IMPK) S.sv[k] = o && o.sv && o.sv[k] === 'new' ? 'new' : 'old';
    if (o && Array.isArray(o.log)) S.svLog = o.log.slice(0, 20);
  }
  function evalVariants() {
    let ch = false;
    for (const k of IMPK) {
      const v = L().variantVerdict(k), cur = S.sv[k] || 'old';
      if (cur === 'old' && v.ok && v.better) { S.sv[k] = 'new'; ch = true; S.svLog.unshift({ t: clock(), k, to: 'new', why: v.why }); }
      else if (cur === 'new' && v.ok && v.worse) { S.sv[k] = 'old'; ch = true; S.svLog.unshift({ t: clock(), k, to: 'old', why: v.why }); }
    }
    if (ch) { S.svLog = S.svLog.slice(0, 20); LSset(KEYS.SV, { sv: S.sv, log: S.svLog }); }
    return ch;
  }

  // ---- صفقات ظلّية: تجارب + مدد انتهاء متعددة + إشارات محجوبة + ممتنع عنها ----
  function settleShadows(asset, A, c, complete, live) {
    const L = S.SH[asset];
    if (!L || !L.length) return;
    const maxH = HZ[HZ.length - 1], keep = [];
    for (const p of L) {
      const dt = c.t - p.ct, k = Math.round(dt / CFG.tf);
      if (dt <= 0) { keep.push(p); continue; }
      if (k > maxH) continue;
      // تُحتسب النتيجة فقط عند شمعة مكتملة وعلى بُعد دقيق من الدخول، وإلا تُهمل بدل تخمينها
      if (k * CFG.tf === dt && complete && c.c !== p.entry) {
        const win = (c.c > p.entry) === (p.dir > 0);
        if (k === 1) p.tags.forEach(t => rec(slot(A.z, t), win, live));
        if (p.sv && HZ.includes(k)) { const up = c.c > p.entry; for (const [sk, sd] of p.sv) rec(slot(A.z, qk(sk, k, p.rg)), (sd > 0) === up, live); }
        if (p.hz && HZ.includes(k)) {
          rec(slot(A.z, 'h|' + k), win, live);
          rec(slot(A.z, 'hr|' + k + '|' + p.rg), win, live);
          if (p.j) p.j.o[k] = win ? 1 : 0;
        }
      }
      if (k < maxH) keep.push(p);
    }
    S.SH[asset] = keep;
  }
  function registerShadows(asset, c, r, complete, live) {
    if (!r.comp || !r.sd || !complete) return;
    const base = decide(r, null, CFG), baseOK = base.ok && r.conf0 >= CFG.minConf, tags = [];
    for (const e of EXPS) {
      const mc = e.o.minConf !== undefined ? e.o.minConf : CFG.minConf;
      if (decide(r, e.o, CFG).ok && r.conf0 >= mc) tags.push('x|' + e.k);
    }
    if (decide(r, { veto: false }, CFG).ok && r.conf0 >= CFG.minConf) r.vetoes.forEach(v => tags.push('v|' + v));
    if (r.ctx && decide(r, { useCtx: false }, CFG).ok && r.conf0 >= CFG.minConf) tags.push('c|' + r.ctx.kind);
    if (!baseOK) tags.push('ab|all');
    let j = null;
    if (live && (baseOK || r.vetoes.length)) {
      j = { t: clock(), a: asset, ct: c.t, rg: r.regime, cf: r.conf0, d: r.sd, ok: baseOK ? 1 : 0, v: r.vetoes.slice(), ab: baseOK ? '' : (base.why[0] || ''), o: {} };
      S.journal.push(j);
      if (S.journal.length > CFG.journalMax) S.journal.shift();
    }
      const sv = [];
    for (const k in r.raw) if (r.raw[k] !== 0) sv.push([k, r.raw[k] > 0 ? 1 : -1]);
    (S.SH[asset] || (S.SH[asset] = [])).push({ ct: c.t, entry: c.c, dir: r.sd, tags, hz: baseOK, rg: r.regime, j, sv });
  }

  function adoptExp(k) {
    const e = EXPS.find(x => x.k === k);
    if (!e || !L().expReady(e).ok) return false;
    for (const f in e.o) CFG[f] = Array.isArray(e.o[f]) ? e.o[f].slice() : e.o[f];
    S.adopted.unshift({ t: clock(), k });
    S.adopted = S.adopted.slice(0, 20);
    saveCfg();
    return true;
  }
  function resetCfg() {
    Object.assign(CFG, DEFAULTS);
    S.adopted = [];
    saveCfg();
  }
  E.provide({ loadSV, evalVariants, settleShadows, registerShadows, adoptExp, resetCfg });
};
},
/* ---- engine/paper.js ---- */
"engine/paper": function (module, exports, require) {
'use strict';
// المحرك — المحاكاة فقط (Paper Trading): دورة حياة الصفقة الافتراضية وحدود المخاطرة.
// لا يوجد هنا ولا في أي مكان آخر كود ينقر أزرار المنصة أو يرسل أوامر. النتائج تُحسب من أسعار التيك.
// يُصدر الأحداث: 'signal' (كل إشارة مسجّلة) و'result' (نتيجة إشارة/صفقة افتراضية).

module.exports = function install(E) {
  const { S, CFG } = E, clock = E.clock;
  const [saveLog, saveState, saveAll, logErr, simTrace] = E.use('saveLog', 'saveState', 'saveAll', 'logErr', 'simTrace');
  // صفقة محاكاة أو محاولة محاكاة: لا تُسوّى بطريقة الشمعة
  const isOwn = l => !!l && !!(l.try || l.auto || l.failed || l.voided);
  function settle(e, exit, win) {
    e.exit = exit; e.win = win;
    if (e.auto) {
      if (S.open === e) S.open = null;
      S.unkRow = 0;
      S.net += win ? CFG.payout : -1;
      S.lossRow = win ? 0 : S.lossRow + 1;
      if (S.lossRow >= CFG.maxLossRow) { S.pausedUntil = clock() + CFG.pauseMs; S.lossRow = 0; }
      if (S.net <= -CFG.maxDD) { S.halted = true; S.haltWhy = 'حد الخسارة'; }
      simTrace('settled', { asset: e.asset, win, net: +S.net.toFixed(2) });
      saveState();
    }
    saveLog();
    if (!S.loading) E.emit('result', win); // الواجهة تستمع؛ المحرك لا يعرف من يعرض
  }
  function settleTie(e, exit) {
    e.exit = exit; e.tie = true;
    if (e.auto) { if (S.open === e) S.open = null; S.unkRow = 0; simTrace('tie', { asset: e.asset }); saveState(); }
    saveLog();
  }
  // ================= المحاكاة: دورة حياة الأمر الافتراضي =================
  // الإرسال لا يُعدّ نجاحًا: الصفقة لا تُفتح إلا عند وصول تيك جديد بعد الإرسال (تأكيد)،
  // والنتيجة لا تُحسب إلا من تيك عند/بعد وقت الانتهاء. أي شيء آخر يصبح "ملغاة/غير مؤكدة" ولا يدخل التعلم ولا الربح/الخسارة.
  function preflight(asset) {
    const age = clock() - (S.lastRx[asset] || 0);
    if (age > CFG.maxTickAgeMs) return { ok: false, why: 'بيانات قديمة (' + Math.round(age / 1000) + 'ث)' };
    if (S.wsUp === false) return { ok: false, why: 'انقطاع اتصال البيانات' };
    if (!Number.isFinite(S.lastPx[asset]) || !Number.isFinite(S.tickTs[asset])) return { ok: false, why: 'لا يوجد سعر حالي' };
    return { ok: true };
  }
  function placeOrder(e, asset, r, c) {
    S.fired[asset] = c.t;
    S.cdUntil = clock() + CFG.cooldownCandles * CFG.tf * 1000;
    e.try = true; e.sendTs = S.tickTs[asset];
    S.pending = { e, asset, dir: r.d, sendTs: e.sendTs, at: clock() };
    simTrace('order_sent', { asset, dir: r.d });
    if (S.simBroker && S.simBroker.reject) failPending('رفض من وسيط المحاكاة');
  }
  function confirmOrder(px, ts) {
    const pd = S.pending;
    if (!pd) return;
    if (ts - pd.sendTs > CFG.confirmMs / 1000) { failPending('تأخر التأكيد'); return; }
    S.pending = null;
    const e = pd.e;
    e.auto = true; e.confirmed = 'sim'; e.dur = CFG.tf; e.entryPx = px; e.entryTs = ts; e.expTs = ts + CFG.tf; e.openAt = clock();
    S.open = e; S.hourly.push(clock()); S.failRow = 0;
    simTrace('order_confirmed', { asset: e.asset, dir: e.dir, px });
    saveLog(); saveState();
  }
  function failPending(why) {
    const pd = S.pending;
    if (!pd) return;
    S.pending = null;
    const e = pd.e;
    e.failed = true; e.reason = why;
    S.failRow++;
    logErr('ORDER_FAILED', why, { asset: pd.asset, dir: pd.dir });
    simTrace('order_failed', { asset: pd.asset, why });
    if (S.failRow >= CFG.maxFail) { S.halted = true; S.haltWhy = 'فشل أوامر المحاكاة المتكرر'; }
    saveLog(); saveState();
  }
  function voidTrade(e, why, countUnk = true) {
    if (!e || e.voided || e.tie || e.win !== null) return;
    e.fin = true; e.voided = true; e.stale = true; e.reason = why;
    if (S.open === e) S.open = null;
    if (S.pending && S.pending.e === e) S.pending = null;
    if (countUnk) {
      S.unkRow++;
      if (S.unkRow >= CFG.maxUnk) { S.halted = true; S.haltWhy = 'نتائج غير معروفة ×' + S.unkRow; }
    }
    logErr('VOID', why, { asset: e.asset });
    simTrace('order_void', { asset: e.asset, why });
    saveLog(); saveState();
  }
  function finishOpen(px, ts) {
    const e = S.open;
    if (!e || e.fin) return;
    if (ts - e.expTs > CFG.lateTolS) { voidTrade(e, 'تيك الانتهاء متأخر (فجوة بيانات)'); return; }
    e.fin = true;
    if (px === e.entryPx) settleTie(e, px);
    else settle(e, px, (e.dir === 'call') === (px > e.entryPx));
  }
  function killSwitch(why) {
    CFG.auto = false; S.halted = true; S.haltWhy = why || 'إيقاف طارئ';
    if (S.pending) { const e = S.pending.e; S.pending = null; e.failed = true; e.reason = 'إيقاف طارئ'; }
    if (S.open) voidTrade(S.open, 'إيقاف طارئ', false);
    logErr('KILL', 'إيقاف طارئ يدوي');
    saveAll();
  }
  function reasonsOf(r) {
    const out = ['قوة ' + r.conf + ' · ' + (r.d === 'call' ? 'صعود' : 'هبوط') + ' · حالة ' + r.regime];
    if (r.ctx) out.push('سياق: ' + r.ctx.label + ' ' + r.ctx.clarity + '%');
    out.push('اتفاق ' + r.agree + ' عناقيد · أصوات معاكسة ' + Math.round((r.opp || 0) * 100) + '%');
    (r.notes || []).filter(n => !/^حالة:|^أطر /.test(n)).slice(0, 6).forEach(n => out.push(n));
    return out.map(x => String(x).slice(0, 80));
  }
  // كل إشارة تُسجَّل. الصفقة الافتراضية تُفتح فقط إذا كان الدخول الآلي الافتراضي مفعّلًا واجتازت كل حدود المخاطرة.
  function maybeTrade(asset, r, c, A) {
    const g = E.learner.gate(r, A), now = clock(), skip = [];
    if (!CFG.auto) skip.push('الدخول الآلي الافتراضي متوقف (إشارة فقط)');
    if (S.halted) skip.push('المحاكاة موقوفة' + (S.haltWhy ? ': ' + S.haltWhy : ''));
    if (now < S.pausedUntil) skip.push('استراحة بعد خسائر متتالية');
    if (now < S.cdUntil) skip.push('تهدئة بعد صفقة');
    if (S.open || S.pending) skip.push('توجد صفقة افتراضية مفتوحة');
    if (S.hourly.filter(t => now - t < 36e5).length >= CFG.maxPerHour) skip.push('بلغ حد الصفقات بالساعة (' + CFG.maxPerHour + ')');
    if (S.fired[asset] === c.t) skip.push('دخلت هذه الإشارة سابقًا');
    if (CFG.gate && !g.ok) skip.push('البوابة: ' + g.why);
    const pf = preflight(asset);
    if (!pf.ok) skip.push(pf.why);
    const e = { t: now, asset, dir: r.d, conf: r.conf, entry: c.c, ct: c.t, exit: null, win: null, auto: false, proven: g.ok,
      virtual: true, why: reasonsOf(r), skip: CFG.auto ? skip : [], candleWin: null };
    S.log.unshift(e);
    if (S.log.length > 200) S.log.pop();
    if (S.P[asset]) S.P[asset].log = e;
    if (CFG.auto && !skip.length) placeOrder(e, asset, r, c);
    S.decision = { t: now, asset, dir: r.d, conf: r.conf, entered: !!(e.try && !e.failed), why: skip, ctx: r.ctx ? r.ctx.label + ' ' + r.ctx.clarity + '%' : '' };
    saveLog();
    E.emit('signal', e);
  }

  function simSummary() {
    const sim = S.log.filter(e => e.try);
    return {
      tried: sim.length,
      w: sim.filter(e => e.auto && e.win === true).length,
      l: sim.filter(e => e.auto && e.win === false).length,
      tie: sim.filter(e => e.tie).length,
      bad: sim.filter(e => e.failed || e.voided).length
    };
  }
  E.provide({ isOwn, settle, settleTie, preflight, placeOrder, confirmOrder, failPending, voidTrade, finishOpen, killSwitch, reasonsOf, maybeTrade, simSummary });
};
},
/* ---- engine/persist.js ---- */
"engine/persist": function (module, exports, require) {
'use strict';
// المحرك — الحفظ والاستعادة (ذاكرة التعلّم، السجل، الإعدادات، الدفتر، النسخة الثانية في IndexedDB)، وسجل الأخطاء.
// التخزين محقون (E.env.storage بواجهة localStorage، E.env.indexedDB). المفاتيح كما في v3.5 دون تغيير.
const { KEYS, VERSION } = require('./state');
const { clamp, blank, slot } = require('../core/stats');
const { RGS, HZ } = require('../core/catalog');

module.exports = function install(E) {
  const { S, CFG } = E, clock = E.clock;
  const storage = E.env.storage;
  const [getAK, isOwn] = E.use('getAK', 'isOwn');
  const LSget = (k, d) => { try { const v = storage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } };
  const LSset = (k, v) => { try { storage.setItem(k, JSON.stringify(v)); return true; } catch (e) { S.storeErr = true; return false; } };
  // ================= الحفظ الدائم =================
  function snapshot() {
    const out = {};
    for (const a in S.A) {
      const A = S.A[a];
      out[a] = { e: [A.e.ln, A.e.lw, A.e.hn, A.e.hw], s: {}, b: {} };
      for (const k in A.s) out[a].s[k] = [A.s[k].ln, A.s[k].lw, A.s[k].hn, A.s[k].hw, k.indexOf('#') < 0 ? (A.s[k].rc || []).join('') : ''];
      for (const k in A.b) out[a].b[k] = [A.b[k].ln, A.b[k].lw, A.b[k].hn, A.b[k].hw, (A.b[k].rc || []).join('')];
      out[a].z = {};
      for (const k in A.z) out[a].z[k] = [A.z[k].ln, A.z[k].lw, A.z[k].hn, A.z[k].hw];
    }
    return out;
  }
  const sane = (n, w) => { n = Math.max(0, +n | 0); w = Math.min(Math.max(0, +w | 0), n); return [n, w]; };
  function applySnapshot(d) {
    for (const a in d) {
      const v = d[a];
      if (!v || typeof v !== 'object') continue;
      const A = getAK(a);
      const e = Array.isArray(v.e) ? v.e : [0, 0, 0, 0];
      [A.e.ln, A.e.lw] = sane(e[0], e[1]);
      [A.e.hn, A.e.hw] = sane(e[2], e[3]);
      for (const k in v.s || {}) {
        const x = v.s[k]; if (!Array.isArray(x)) continue;
        const o = slot(A.s, k);
        [o.ln, o.lw] = sane(x[0], x[1]); [o.hn, o.hw] = sane(x[2], x[3]);
        o.rc = typeof x[4] === 'string' ? x[4].split('').filter(ch => ch === '0' || ch === '1').map(Number).slice(-50) : [];
      }
      for (const k in v.b || {}) {
        const x = v.b[k]; if (!Array.isArray(x)) continue;
        const o = slot(A.b, k);
        [o.ln, o.lw] = sane(x[0], x[1]); [o.hn, o.hw] = sane(x[2], x[3]);
        o.rc = typeof x[4] === 'string' ? x[4].split('').filter(ch => ch === '0' || ch === '1').map(Number).slice(-50) : [];
      }
      for (const k in v.z || {}) {
        const x = v.z[k]; if (!Array.isArray(x)) continue;
        const o = slot(A.z, k);
        [o.ln, o.lw] = sane(x[0], x[1]); [o.hn, o.hw] = sane(x[2], x[3]);
      }
    }
  }
  function saveState() {
    const now = clock();
    LSset(KEYS.STATE, {
      net: S.net, lossRow: S.lossRow, pausedUntil: S.pausedUntil, halted: S.halted, haltWhy: S.haltWhy,
      hourly: S.hourly.filter(t => now - t < 36e5), unkRow: S.unkRow, failRow: S.failRow, cdUntil: S.cdUntil
    });
  }
  function cfgSnap() {
    return { minConf: CFG.minConf, tf: CFG.tf, payout: CFG.payout, payoutBy: CFG.payoutBy, gate: CFG.gate, minAgree: CFG.minAgree, minScore: CFG.minScore, useHtf: CFG.useHtf, veto: CFG.veto, regimes: CFG.regimes, useCtx: CFG.useCtx, minClarity: CFG.minClarity, dyn: CFG.dyn, adopted: S.adopted };
  }
  function applyCfg(c) {
    CFG.auto = false; // الدخول الآلي (الافتراضي) لا يُستعاد أبدًا بعد إعادة التحميل
    if (!c || typeof c !== 'object') return;
    if (Number.isFinite(+c.minConf)) CFG.minConf = clamp(+c.minConf, 50, 90);
    if ([15, 30, 60].includes(+c.tf)) CFG.tf = +c.tf;
    if (Number.isFinite(+c.payout)) CFG.payout = clamp(+c.payout, .6, .98);
    CFG.gate = c.gate !== false;
    CFG.payoutBy = {};
    if (c.payoutBy && typeof c.payoutBy === 'object') for (const a in c.payoutBy) { const v = +c.payoutBy[a]; if (Number.isFinite(v)) CFG.payoutBy[String(a).slice(0, 40)] = clamp(v, .6, .98); }
    if (Number.isFinite(+c.minAgree)) CFG.minAgree = Math.round(clamp(+c.minAgree, 2, 6));
    if (Number.isFinite(+c.minScore)) CFG.minScore = clamp(+c.minScore, .1, .6);
    if (typeof c.useHtf === 'boolean') CFG.useHtf = c.useHtf;
    if (typeof c.veto === 'boolean') CFG.veto = c.veto;
    if (typeof c.useCtx === 'boolean') CFG.useCtx = c.useCtx;
    if (typeof c.dyn === 'boolean') CFG.dyn = c.dyn;
    if (Number.isFinite(+c.minClarity)) CFG.minClarity = Math.round(clamp(+c.minClarity, 20, 90));
    CFG.regimes = Array.isArray(c.regimes) ? c.regimes.filter(x => RGS.includes(x)) : null;
    if (CFG.regimes && !CFG.regimes.length) CFG.regimes = null;
    if (Array.isArray(c.adopted)) S.adopted = c.adopted.filter(x => x && typeof x.k === 'string' && Number.isFinite(+x.t)).slice(0, 20).map(x => ({ t: +x.t, k: x.k.slice(0, 20) }));
  }
  function saveCfg() { LSset(KEYS.CFG, cfgSnap()); }
  function setPayout(asset, v) {
    v = +v; if (!Number.isFinite(v)) return false;
    if (v > 1) v /= 100;
    v = clamp(v, .6, .98);
    if (asset) CFG.payoutBy[asset] = v; else CFG.payout = v;
    saveCfg();
    return true;
  }
  function saveLog() { LSset(KEYS.LOG, S.log.slice(0, 200)); }
  function save() {
    LSset(KEYS.LIVE, snapshot());
    LSset(KEYS.META, { v: VERSION, at: clock() });
    saveState(); saveCfg(); saveJournal(); mirror();
  }
  function saveAll() { save(); saveLog(); saveJournal(true); mirror(true); }

  function cleanLog(a) {
    if (!Array.isArray(a)) return [];
    const num = v => (v === null || v === undefined || !Number.isFinite(+v)) ? null : +v;
    return a.slice(0, 200).filter(x => x && typeof x === 'object' && Number.isFinite(+x.t)).map(x => ({
      t: +x.t, asset: String(x.asset || ''), dir: x.dir === 'put' ? 'put' : 'call',
      conf: Math.max(0, Math.min(100, +x.conf | 0)), entry: num(x.entry) || 0, ct: num(x.ct) || 0,
      exit: num(x.exit), win: x.win === true ? true : x.win === false ? false : null,
      auto: !!x.auto, try: !!x.try, proven: !!x.proven, tie: !!x.tie, failed: !!x.failed,
      voided: !!x.voided, stale: !!x.stale, reason: x.reason ? String(x.reason).slice(0, 80) : undefined,
      virtual: true, candleWin: x.candleWin === true ? true : x.candleWin === false ? false : null,
      why: Array.isArray(x.why) ? x.why.slice(0, 10).map(v => String(v).slice(0, 80)) : ['(سجل بلا سبب محفوظ)'],
      skip: Array.isArray(x.skip) ? x.skip.slice(0, 10).map(v => String(v).slice(0, 80)) : []
    }));
  }

  function restore() {
    applyCfg(LSget(KEYS.CFG, null));
    const d = LSget(KEYS.LIVE, null);
    if (d && typeof d === 'object') applySnapshot(d);
    // لا ترحيل من v3.3 وما قبله: إحصاءاتها حُسبت بمؤشرات فيها أخطاء (انظر docs/AUDIT_REPORT.md). البيانات القديمة لا تُحذف.
    const st = LSget(KEYS.STATE, null);
    if (st && typeof st === 'object') {
      const n = v => Number.isFinite(+v) ? +v : 0;
      S.net = n(st.net); S.lossRow = n(st.lossRow) | 0; S.pausedUntil = n(st.pausedUntil);
      S.halted = st.halted === true; S.haltWhy = String(st.haltWhy || '');
      S.hourly = Array.isArray(st.hourly) ? st.hourly.filter(Number.isFinite) : [];
      S.unkRow = n(st.unkRow) | 0; S.failRow = n(st.failRow) | 0; S.cdUntil = n(st.cdUntil);
    }
    S.log = cleanLog(LSget(KEYS.LOG, []));
    S.journal = cleanJournal(LSget(KEYS.JOURNAL, []));
    const er = LSget(KEYS.ERR, []); S.errors = Array.isArray(er) ? er.slice(0, 100) : [];
    // نتائج لم تكتمل في الجلسة السابقة: لا يمكن إكمالها بعد إعادة التحميل، فتُعلَّم بدل تركها معلّقة
    S.log.forEach(e => {
      if (e.win === null && !e.tie && !e.voided && !e.failed) {
        if (isOwn(e)) { e.voided = true; e.reason = 'إعادة تحميل الصفحة'; } else e.stale = true;
      }
    });
  }
  // ================= سجل الأخطاء والتتبع =================
  function logErr(code, msg, data) {
    const e = { t: clock(), code, msg, data: data === undefined ? null : data };
    S.errors.unshift(e);
    if (S.errors.length > 200) S.errors.pop();
    LSset(KEYS.ERR, S.errors.slice(0, 100));
    try { E.env.console && E.env.console.warn('[wsnf]', code, msg, data === undefined ? '' : data); } catch (_) {}
  }
  function simTrace(name, data) {
    let raw = ''; try { raw = JSON.stringify(data); } catch (e) {}
    S.trace.unshift({ t: clock(), dir: 'sim', name, raw: (name + ' ' + raw).slice(0, 400) });
    if (S.trace.length > 40) S.trace.pop();
  }
  // ---- الذاكرة: دفتر التجارب + نسخة ثانية في IndexedDB تنجو من مسح التخزين المحلي ----
  function cleanJournal(a) {
    if (!Array.isArray(a)) return [];
    return a.slice(-CFG.journalMax).filter(x => x && typeof x === 'object' && Number.isFinite(+x.t)).map(x => ({
      t: +x.t, a: String(x.a || ''), ct: +x.ct || 0, rg: String(x.rg || ''), cf: +x.cf || 0, d: x.d > 0 ? 1 : -1, ok: x.ok ? 1 : 0,
      v: Array.isArray(x.v) ? x.v.map(String).slice(0, 6) : [], ab: x.ab ? String(x.ab).slice(0, 80) : '',
      o: x.o && typeof x.o === 'object' ? Object.fromEntries(Object.entries(x.o).filter(([k, v]) => HZ.includes(+k) && (v === 0 || v === 1))) : {}
    }));
  }
  function saveJournal(force) {
    const now = clock();
    if (!force && now - S.lastJ < 30000) return;
    S.lastJ = now;
    LSset(KEYS.JOURNAL, S.journal);
  }
  const IDB = {
    db: null,
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((res, rej) => {
        const idbf = E.env.indexedDB;
        if (!idbf) return rej(new Error('no idb'));
        const q = idbf.open('wsnf33s', 1);
        q.onupgradeneeded = () => { q.result.createObjectStore('kv'); };
        q.onsuccess = () => { this.db = q.result; res(q.result); };
        q.onerror = () => rej(q.error);
      });
    },
    async get(k) { const db = await this.open(); return new Promise((res, rej) => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
    async set(k, v) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(true); t.onerror = () => rej(t.error); }); },
    async del(k) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = () => res(true); t.onerror = () => rej(t.error); }); }
  };
  function mirror(force) {
    const now = clock();
    if (!S.idbReady || S.idbErr || (!force && now - S.lastMir < 60000)) return;
    S.lastMir = now;
    IDB.set('bak', { at: now, live: snapshot(), journal: S.journal, log: S.log.slice(0, 200), cfg: cfgSnap() })
      .then(() => { S.idbAt = now; }).catch(() => { S.idbErr = true; });
  }
  // عند بدء التشغيل: إن كان التخزين المحلي فارغًا (مسحه المتصفح) نستعيد من النسخة الثانية. لا ننسخ قبل انتهاء هذا الفحص.
  async function idbRestore() {
    try {
      const bak = await IDB.get('bak');
      const have = Object.keys(S.A).length > 0 && LSget(KEYS.LIVE, null);
      if (bak && bak.live && !have) {
        applySnapshot(bak.live);
        S.journal = cleanJournal(bak.journal);
        if (!S.log.length) S.log = cleanLog(bak.log);
        applyCfg(bak.cfg);
        save(); saveJournal(true);
        logErr('RESTORED', 'استُعيدت الذاكرة من النسخة الثانية (IndexedDB)');
      } else if (bak) S.idbAt = bak.at;
    } catch (e) { S.idbErr = true; }
    S.idbReady = !S.idbErr;
  }

  function buildExport() { return { app: 'wsnf smart bot', v: VERSION, at: clock(), live: snapshot(), log: S.log.slice(0, 200), journal: S.journal, cfg: cfgSnap() }; }
  function importData(text) {
    const d = JSON.parse(text);
    if (!d || d.app !== 'wsnf smart bot' || !d.live || typeof d.live !== 'object') throw new Error('ملف غير صالح');
    if (S.open || S.pending) throw new Error('أوقف الصفقة المفتوحة أولًا');
    for (const a in S.A) delete S.A[a];
    applySnapshot(d.live);
    S.log = cleanLog(d.log);
    if (Array.isArray(d.journal)) S.journal = cleanJournal(d.journal);
    if (d.cfg) applyCfg(d.cfg);
    saveAll();
  }
  E.provide({ LSget, LSset, snapshot, applySnapshot, saveState, cfgSnap, applyCfg, saveCfg, setPayout, saveLog, save, saveAll, cleanLog, restore, logErr, simTrace, cleanJournal, saveJournal, IDB, mirror, idbRestore, buildExport, importData });
};
},
/* ---- engine/state.js ---- */
"engine/state": function (module, exports, require) {
'use strict';
// حالة المحرك وإعداداته. كل محرك يُنشئ نسخته الخاصة (لا حالة عامة على مستوى الوحدة).
// المفاتيح والإصدار لم تتغير عن v3.5: لا ترحيل بيانات في المرحلة C (انظر docs/ENGINE.md).
const SIM_ONLY = true;
const VERSION = 5;
const SCRIPT_VERSION = '3.6.0';
const KEYS = Object.freeze({
  LIVE: 'wsnf33s_live', LOG: 'wsnf33s_log', UI: 'wsnf33s_ui', META: 'wsnf33s_meta', ERR: 'wsnf33s_err', CFG: 'wsnf33s_cfg',
  STATE: 'wsnf33s_state', SV: 'wsnf33s_sv', JOURNAL: 'wsnf33s_journal', RECCFG: 'wsnf33s_rec_cfg'
});
function createState() {
  const CFG = {
    tf: 60, minConf: 65, minAgree: 3, payout: .92,
    auto: false, gate: true,
    maxLossRow: 3, pauseMs: 6e5, maxPerHour: 12, maxDD: 6,
    maxCandles: 5000, window: 300, minLive: 100, minLocal: 30, minTrust: 50, minRegime: 60, driftN: 30, driftZ: 1,
    minScore: .15, veto: true, useHtf: true, regimes: null, minQ: 60, journalMax: 1500, useCtx: true, minClarity: 45, dyn: true,
    cooldownCandles: 2, htfK: 5, maxGap: .05,
    gateZ: 2.5, zStrat: 2.3, prior: 20, recentN: 40, edgeTol: .15,
    maxTickAgeMs: 8000, maxDriftAtr: 1, confirmMs: 4000, lateTolS: 5, staleRestMs: 12e4, maxUnk: 3, maxFail: 3,
    contigN: 30, payoutBy: {},
    recMaxPerSeries: 500000, recMaxGapFrac: .5
  };
  const S = {
    candles: {}, P: {}, A: {}, sigBy: {}, lastTs: {},
    cur: null, lock: null, ticks: 0, loading: false, loadedCount: 0,
    open: null, log: [], net: 0, lossRow: 0, pausedUntil: 0, halted: false,
    hourly: [], exp: null, cdUntil: 0, unkRow: 0, haltWhy: '',
    lastRx: {}, lastPx: {}, tickTs: {}, fired: {}, pending: null,
    errors: [], trace: [], wsUp: null, failRow: 0, decision: null,
    corr: {}, simBroker: { reject: false }, storeErr: false,
    SH: {}, sdh: {}, dq: {}, journal: [], adopted: [], audit: { n: 0, bad: 0, tests: 0, testBad: 0, last: '' },
    idbReady: false, idbErr: false, idbAt: 0, lastJ: 0, lastMir: 0,
    onFlash: null, onResult: null,
    corrH: {}
  };
  return { CFG, S };
}
module.exports = { SIM_ONLY, VERSION, SCRIPT_VERSION, KEYS, createState };
},
/* ---- engine/viewmodel.js ---- */
"engine/viewmodel": function (module, exports, require) {
'use strict';
// المحرك — نموذج العرض (قراءة فقط). يحوّل حالة المحرك إلى بيانات بسيطة (أرقام، نصوص، قوائم) تعرضها الواجهة كما هي.
// قواعد هذه الوحدة:
//  1) لا تكتب في الحالة أبدًا. (v3.5 كانت getA(asset) أثناء العرض تُنشئ سجل إحصاء فارغًا: أُزيل — peekA لا يُنشئ.)
//  2) تعيد نسخًا لا مراجع للحالة القابلة للتغيير، فلا تستطيع الواجهة تعديل المحرك عبرها.
//  3) كل حساب إحصائي (Wilson، الأوزان، البوابة، الألوان المشتقة منها) يتم هنا؛ الواجهة لا تحسب شيئًا.
const { wil, nw } = require('../core/stats');
const { ema } = require('../core/indicators');
const { NM, GRP, SK, STR, IMPK } = require('../core/strategies');
const { verifyCandles } = require('../core/quality');
const { CTX_LBL, CTX_KINDS } = require('../core/context');
const { HZ, RGS, VETOS, EXPS, hzLabel } = require('../core/catalog');
const { tfOfKey, emptyBook } = require('../core/learning');
const { KEYS, SIM_ONLY, SCRIPT_VERSION } = require('./state');

const copy = x => x === undefined ? undefined : JSON.parse(JSON.stringify(x));
const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
// مقارنة الأصل المعروض في الصفحة (تقرؤه طبقة المنصة وتمرّره) مع أصل التحليل — بحتة
function activeCheck(asset, shown, lock) {
  if (!shown) return lock === asset ? { ok: true, why: 'الأصل مقفول يدويًا (تعذّرت قراءة الاسم)' } : { ok: false, why: 'تعذّر قراءة الأصل المعروض' };
  return norm(asset) === norm(shown) ? { ok: true, why: shown } : { ok: false, why: 'المعروض "' + shown + '" ≠ ' + asset };
}

module.exports = function install(E) {
  const { S, CFG } = E, clock = E.clock;
  const [AK, BE, payoutOf, simSummary, LSget] = E.use('AK', 'BE', 'payoutOf', 'simSummary', 'LSget');
  const L = () => E.learner;
  const peekA = asset => (asset ? S.A[AK(asset)] : null) || null;

  // الصفحة الرئيسية + الاستراتيجيات + السجل + الذاكرة
  function view(shown) {
    const asset = S.cur, A = peekA(asset), r = asset ? S.sigBy[asset] : null;
    const arr = asset ? S.candles[asset] || [] : [];
    const g = L().gate(r, A || { b: {} }), be = BE(asset);
    const vq = arr.length >= 60 ? verifyCandles(arr.slice(-CFG.window), CFG.tf, CFG.maxGap) : { ok: false, why: 'لا يكفي' };
    const now = clock();
    const curRg = r && r.regime ? r.regime : '-';
    const strat = (A ? STR.map(([k, kind]) => {
      const ak = L().vk(k), W = L().wtR(A, ak, curRg), [n, w] = A.s[ak] ? nw(A.s[ak]) : [0, 0];
      return { k, ak, kind, n, w, p: n ? w / n : 0, W };
    }).sort((a, b) => b.W.w - a.W.w) : []).map(s => ({
      name: NM[s.k], improved: s.ak !== s.k, kind: s.kind, n: s.n, p: s.p, lb: s.W.lb, w: s.W.w, mode: s.W.mode, src: s.W.src,
      rg: s.W.rg ? curRg : '', rp: s.W.rp,
      cls: s.W.mode === 'رابحة' ? 'u' : s.W.mode === 'عكسية' ? 'g' : s.W.mode === 'معطلة' || s.W.mode === 'متدهورة' ? 'd' : 'm'
    }));
    const bks = A ? Object.keys(A.b).sort().map(k => {
      const n = A.b[k].ln, w = A.b[k].lw;
      return { k, n, acc: n ? w / n : 0, ok: n >= CFG.minLive && wil(n, w, CFG.gateZ) > be };
    }) : [];
    const log = S.log.slice(0, 60).map(copy);
    const [en, ew] = A ? nw(A.e) : [0, 0];
    const sessW = S.log.filter(e => e.win === true).length, sessL = S.log.filter(e => e.win === false).length;
    let lifeW = 0, lifeL = 0;
    // v3.4: الإجمالي = نتائج الإشارات الحية فقط. نتائج إعادة تشغيل التاريخ تدريب داخل العينة ولا تُخلط بها.
    for (const a in S.A) { if (tfOfKey(a) !== CFG.tf) continue; lifeW += S.A[a].e.lw; lifeL += S.A[a].e.ln - S.A[a].e.lw; }
    const cd = asset && S.lastTs[asset] && arr.length ? Math.max(0, CFG.tf - (S.lastTs[asset] - arr[arr.length - 1].t)) : null;
    const paused = now < S.pausedUntil, cooling = now < S.cdUntil;
    const best = A ? L().bestBucket(A) : null;
    const ageMs = asset && S.lastRx[asset] ? now - S.lastRx[asset] : null;
    const ac = asset ? activeCheck(asset, shown, S.lock) : { ok: false, why: 'لا أصل' };
    const checks = [
      { ok: arr.length >= 60, t: 'شموع كافية (' + arr.length + '/60)' },
      { ok: vq.ok, t: 'جودة البيانات: ' + vq.why },
      { ok: !!r && r.d !== 'none', t: 'إشارة موجودة' + (r && r.d === 'none' && r.abst && r.abst[0] ? ' — ' + r.abst[0] : '') },
      { ok: !!r && r.d !== 'none' && r.htfOK && r.htf !== 0, t: 'توافق مع الإطار الأعلى' },
      { ok: g.ok, t: 'بوابة الإثبات: ' + g.why },
      { ok: ageMs !== null && ageMs <= CFG.maxTickAgeMs && S.wsUp !== false, t: 'بيانات حديثة واتصال سليم' + (ageMs !== null ? ' (' + Math.round(ageMs / 1000) + 'ث)' : '') },
      { ok: ac.ok, t: 'الأصل المعروض (معلومة): ' + ac.why },
      { ok: !cooling && !paused && !S.halted, t: 'لا تهدئة ولا إيقاف' }
    ];
    const meta = LSget(KEYS.META, null);
    const ss = simSummary();
    const n = A ? A.e.ln : 0, w = A ? A.e.lw : 0, po = payoutOf(asset);
    return {
      asset, r: r ? copy({ d: r.d, conf: r.conf, regime: r.regime, abst: r.abst, notes: r.notes, stale: r.stale }) : null,
      g, n: arr.length, strat, bks, log, en, ew, acc: en ? ew / en : 0, be, cd,
      liveN: n, liveW: w, liveLb: n ? wil(n, w, 1.64) : 0,
      // إحصاء صادق: فاصل ثقة 95% والتوقع الرياضي (يُعرض فقط من 30 إشارة حية)
      lo95: n ? wil(n, w, 1.96) : 0, hi95: n ? 1 - wil(n, n - w, 1.96) : 0, payout: po,
      price: arr.length ? arr[arr.length - 1].c : null, checks, paused, cooling,
      loaded: S.loadedCount, sessW, sessL, lifeW, lifeL, best, savedAt: meta && meta.at, stale: !!(r && r.stale),
      histN: A ? A.e.hn : 0, histW: A ? A.e.hw : 0,
      logCount: S.log.length, sim: ss, errRate: ss.tried ? ss.bad / ss.tried : 0,
      dq: asset && S.dq[asset] ? copy(S.dq[asset]) : null,
      st: {
        cur: S.cur, lock: S.lock, net: S.net, halted: S.halted, haltWhy: S.haltWhy, unkRow: S.unkRow, wsUp: S.wsUp,
        pending: !!S.pending, open: S.open ? { asset: S.open.asset } : null, storeErr: S.storeErr,
        hourly: S.hourly.filter(t => now - t < 36e5).length, decision: copy(S.decision),
        errors: S.errors.slice(0, 60).map(copy), trace: S.trace.map(copy)
      },
      cfg: { tf: CFG.tf, auto: CFG.auto, gate: CFG.gate, minConf: CFG.minConf, minLive: CFG.minLive, gateZ: CFG.gateZ, recentN: CFG.recentN, minQ: CFG.minQ, maxPerHour: CFG.maxPerHour, driftN: CFG.driftN },
      simOnly: SIM_ONLY, version: SCRIPT_VERSION
    };
  }

  // صفحة المختبر — كل الأرقام والأحكام محسوبة هنا
  function lab() {
    const asset = S.cur, dq = asset ? S.dq[asset] : null, be = BE(), au = S.audit, tf = CFG.tf, zAgg = L().zAgg;
    const hz = HZ.map(h => ({ h, label: hzLabel(h, tf), z: zAgg('h|' + h) }));
    const live = hz.filter(x => x.z.ln >= 30), pool = live.length ? live : hz.filter(x => x.z.hn >= 30);
    const sc = x => live.length ? wil(x.z.ln, x.z.lw, 1.64) : wil(x.z.hn, x.z.hw, 1.64);
    const best = pool.length ? pool.reduce((a, b) => sc(b) > sc(a) ? b : a).h : null;
    hz.forEach(x => { x.lbPct = x.z.ln ? Math.round(wil(x.z.ln, x.z.lw) * 100) : null; x.best = best === x.h; });
    const rm = { cols: HZ.map(h => hzLabel(h, tf)), rows: RGS.map(g => ({ g, cells: HZ.map(x => { const z = zAgg('hr|' + x + '|' + g); return { n: z.ln + z.hn, w: z.lw + z.hw }; }) })) };
    const vetos = VETOS.map(name => {
      const z = zAgg('v|' + name), n = z.ln + z.hn, w = z.lw + z.hw;
      return { name, n, w, useful: n >= 30 && 1 - wil(n, n - w, 1.64) < be, harmful: n >= 30 && wil(n, w, 1.64) > be };
    });
    const cx = CTX_KINDS.map(k => {
      const z = zAgg('c|' + k), n = z.ln + z.hn, w = z.lw + z.hw;
      return { label: CTX_LBL[k], n, w, lose: n >= 30 && 1 - wil(n, n - w, 1.64) < be, win: n >= 30 && wil(n, w, 1.64) > be };
    });
    const cSig = asset ? S.sigBy[asset] : null, cRg = cSig && cSig.regime && cSig.regime !== '-' ? cSig.regime : '-';
    let matrix = null;
    if (asset) {
      const beA = BE(asset);
      matrix = {
        cols: HZ.map(h => hzLabel(h, tf)),
        rows: L().stratMatrix(asset, cRg, peekA(asset) || emptyBook()).map(r => ({
          name: NM[r.k], improved: r.ak !== r.k, st: r.st, cls: r.cls,
          cells: r.cells.map((c, i) => {
            const lb = c.n >= 30 ? wil(c.n, c.w, CFG.zStrat) : 0;
            return { n: c.n, w: c.w, general: c.src === 'عام', best: r.bi === i, cls: !c.n ? '' : lb > beA ? 'w' : (c.n >= 30 && wil(c.n, c.n - c.w, CFG.zStrat) > beA) ? 'l' : '' };
          })
        })),
        note: 'الأصل: ' + asset + ' · الحالة: ' + (cRg === '-' ? 'كل الحالات' : cRg) + ' · ★ = أنسب مدة للاستراتيجية · «عام» = عينة مجمّعة من بقية الأصول لقلّة بيانات هذا الأصل'
      };
    }
    const variants = IMPK.map(k => ({ name: NM[k], cur: S.sv[k] === 'new', ...L().variantVerdict(k) }));
    const svLog = (S.svLog || []).slice(0, 3).map(x => ({ name: NM[x.k], to: x.to, t: x.t }));
    const clm = {};
    SK.forEach(k => { const g = E.clusters.clusterOf(k); (clm[g] = clm[g] || []).push(k); });
    const clusters = Object.keys(clm).map(g => ({ names: clm[g].map(k => NM[k]), merged: new Set(clm[g].map(k => GRP[k])).size }));
    const pairs = E.clusters.corrReport(100, .85).slice(0, 5).map(p => ({ names: p.pair.split('|').map(x => NM[x] || x), agree: p.agree }));
    const zb = zAgg('x|base'), zf = zAgg('x|forced'), za = zAgg('ab|all');
    const exps = EXPS.map(e => {
      const z = zAgg('x|' + e.k), rd = L().expReady(e), cur = e.k !== 'base' && !e.ref && L().sameCfg(e);
      return { k: e.k, n: e.n, base: e.k === 'base', ref: !!e.ref, cur, ready: rd.ok, why: rd.why, z, lbPct: z.ln ? Math.round(wil(z.ln, z.lw, CFG.gateZ) * 100) : null };
    });
    return {
      dq: dq ? copy(dq) : null, minQ: CFG.minQ, audit: copy(au), hz, hzNote: best === null ? 'تحتاج 30 صفقة ظلّية على الأقل لكل مدة' : '', bestLive: live.length > 0,
      rm, vetos, cx, matrix, variants, svLog, clusters, pairs,
      ab: { zf, zb, za, be }, exps,
      journal: { n: S.journal.length, done: S.journal.filter(e => Object.keys(e.o).length).length, idbErr: S.idbErr, idbAt: S.idbAt, idbReady: S.idbReady, adopted: S.adopted.slice(0, 20).map(copy) }
    };
  }

  // صفحة المسجّل
  function recorder() {
    const R = E.fn.REC;
    return {
      on: R.on, ready: R.ready, err: R.err, kind: R.kind, queue: R.q.size, sess: copy(R.sess),
      series: Object.values(R.series).map(copy), scan: copy(R.scan), events: R.events.slice(0, 40).map(copy), bytesPer: E.fn.REC_BYTES
    };
  }

  // الشارت: آخر 90 شمعة + المتوسطات محسوبة على كل الشموع المتاحة + علامات الإشارات
  function chart() {
    const all = S.candles[S.cur] || [], arr = all.slice(-90).map(c => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c }));
    const closes = all.map(c => c.c);
    const lines = arr.length < 3 ? [] : [[9, '#f5c45e'], [21, '#7aa2ff']].map(([n, col]) => ({ col, v: ema(closes, n).slice(-arr.length) }));
    const marks = S.log.filter(e => e.asset === S.cur).map(e => ({ i: arr.findIndex(c => c.t === e.ct + CFG.tf), dir: e.dir, entry: e.entry, win: e.win })).filter(m => m.i >= 0);
    return { arr, lines, marks };
  }

  // إعدادات تحتاجها الواجهة عند البناء فقط
  function settings() { return { tf: CFG.tf, minConf: CFG.minConf, payout: CFG.payout, payoutCur: payoutOf(S.cur), beCur: BE(S.cur), cur: S.cur, lock: S.lock }; }

  E.provide({ view, lab, recorder, chart, settings, activeCheck, norm });
};
module.exports.activeCheck = activeCheck;
module.exports.norm = norm;
},
/* ---- main.js ---- */
"main": function (module, exports, require) {
'use strict';
// نقطة الدخول في المتصفح: تبني البيئة من window، تُنشئ المحرك، تركّب طبقة المنصة والواجهة، وتربطها.
// الترتيب مطابق لـ v3.5: مستمعو الحفظ ← المؤقتات ← اعتراض WebSocket ← تهيئة المحرك ← الواجهة.
const { createEngine, startEngine } = require('./engine/index');
const { SIM_ONLY, SCRIPT_VERSION } = require('./engine/state');
const { createHandler, installSocketTap } = require('./platform/ws');
const { readShownAsset, downloadText } = require('./platform/dom');
const { buildUI } = require('./ui/ui');
const core = {
  stats: require('./core/stats'), indicators: require('./core/indicators'), strategies: require('./core/strategies'),
  quality: require('./core/quality'), context: require('./core/context'), decision: require('./core/decision'), catalog: require('./core/catalog'),
  format: require('./recorder/format')
};

const win = window;
const TEST = win.__WSNF_TEST === true;
let idbf = null;
try { idbf = win.indexedDB || null; } catch (e) { idbf = null; }
const env = {
  now: () => Date.now(),
  // يُقرأ localStorage عند كل استدعاء (قد يرمي خطأ في بعض السياقات؛ LSget/LSset تلتقطه)
  storage: { getItem: k => win.localStorage.getItem(k), setItem: (k, v) => win.localStorage.setItem(k, v) },
  indexedDB: idbf,
  IDBKeyRange: win.IDBKeyRange || null,
  console: win.console,
  recMem: TEST ? win.__WSNF_REC_MEM : undefined
};
const E = createEngine(env);
const F = E.fn, S = E.S, CFG = E.CFG;

const flushNow = () => { try { F.saveAll(); } catch (e) {} try { F.recFlush(); } catch (e) {} };
win.addEventListener('beforeunload', flushNow);
win.addEventListener('pagehide', flushNow);
try { document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNow(); }); } catch (e) {}
setInterval(() => { try { F.watchdog(); } catch (err) {} }, 1000);
setInterval(() => { try { F.recFlush(); } catch (err) {} }, 5000);

const handle = createHandler(E);
installSocketTap(win, E, handle, { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: t => clearTimeout(t) });
startEngine(E);

const readShown = () => readShownAsset(document);
function diagnostics() {
  return {
    app: 'wsnf diag', v: SCRIPT_VERSION, at: Date.now(), simOnly: SIM_ONLY, errors: S.errors, trace: S.trace, decision: S.decision,
    cfg: CFG, audit: S.audit, adopted: S.adopted, corr: E.clusters.corrReport(100, .8), simSummary: F.simSummary(),
    rec: { on: F.REC.on, kind: F.REC.kind, err: F.REC.err, ready: F.REC.ready, queue: F.REC.q.size, series: Object.values(F.REC.series), sess: F.REC.sess },
    sim: { auto: CFG.auto, open: !!S.open, pending: !!S.pending, paused: Date.now() < S.pausedUntil, hourly: S.hourly.length },
    state: { halted: S.halted, why: S.haltWhy, wsUp: S.wsUp, shown: readShown(), cur: S.cur, lock: S.lock, net: S.net, storeErr: S.storeErr }
  };
}
// كل ما تراه الواجهة من المحرك
const app = {
  win, doc: document,
  vm: { view: F.view, lab: F.lab, recorder: F.recorder, chart: F.chart, settings: F.settings },
  cmd: E.cmd,
  rec: { setOn: F.recSetOn, exportFile: F.recExport, importFile: F.recImport, scanGaps: F.recScanGaps, clear: F.recClear },
  on: E.on,
  readShown, diagnostics,
  downloadText: (name, text, mime) => downloadText(win, name, text, mime),
  prefs: { get: F.LSget, set: F.LSset }
};
let uiHandle = null;
const build = () => { if (!win.__WSNF25_NOUI) uiHandle = buildUI(app); };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
else build();

// الواجهة الداخلية تُكشف للاختبارات فقط (السكربت يعمل عند document-start قبل سكربتات الصفحة، فلا تستطيع الصفحة ضبط هذا العلم مسبقًا).
// لا توجد فيها أي دالة تنفيذ: لا يوجد كود تنفيذ أصلًا. الدوال ذات توقيعات v3.5 أغلفة رفيعة فوق الوحدات الجديدة.
if (TEST) {
  const Ln = E.learner, Cl = E.clusters, Q = core.quality, D = core.decision, X = core.context, I = core.indicators;
  const peek = a => S.A[F.AK(a)] || null;
  win.__WSNF25 = {
    SIM_ONLY, S, CFG, E, core, app, get ui() { return uiHandle; },
    on: E.on, cmd: E.cmd,
    feedTick: F.feedTick, onClose: F.onClose, handle, getA: F.getA, AK: F.AK,
    // تحليل نافذة «كما في لحظة إغلاق آخر شمعة فيها» (asOf صريح)
    analyze: (cs, A, asset) => F.analyzeWindow(cs, A, asset, cs.length ? cs[cs.length - 1].t + CFG.tf : undefined),
    analyzeWindow: F.analyzeWindow,
    gate: Ln.gate, wt: Ln.wt, grade: Ln.grade, statOf: Ln.statOf, wtR: Ln.wtR, bestBucket: Ln.bestBucket, vk: Ln.vk, variantVerdict: Ln.variantVerdict,
    poolS: Ln.poolS, cellOf: Ln.cellOf, bestHz: Ln.bestHz, stratMatrix: (asset, rg) => Ln.stratMatrix(asset, rg, peek(asset)), zAgg: Ln.zAgg, expReady: Ln.expReady,
    dampen: Cl.dampen, corrReport: Cl.corrReport, corrHistTotal: Cl.corrHistTotal, rebuildClusters: Cl.rebuildClusters, pairRho: Cl.pairRho, clusterOf: Cl.clusterOf,
    verifyCandles: cs => Q.verifyCandles(cs, CFG.tf, CFG.maxGap),
    dataQuality: (cs, asset) => Q.dataQuality(cs, CFG.tf, (!S.loading && asset && S.lastRx[asset]) ? Date.now() - S.lastRx[asset] : null, CFG.maxTickAgeMs),
    liveBlock: (asset, arr, tNew, live) => Q.liveBlock(arr, tNew, { live, wsUp: S.wsUp, tf: CFG.tf, contigN: CFG.contigN }),
    decide: (r, o) => D.decide(r, o, CFG), falseSignals: (cs, Xv, dir, items, asset) => D.falseSignals(cs, Xv, dir, items, S.sdh[asset]),
    marketContext: cs => X.marketContext(cs, { tf: CFG.tf, htfK: CFG.htfK }), ctxPermit: X.ctxPermit, breakoutScan: X.breakoutScan, reversalScan: X.reversalScan,
    adxOf: I.adxOf, swings: I.swings,
    rawVotes: cs => core.strategies.rawVotes(cs, F.stratErr),
    resample: (cs, k) => I.resample(cs, k, CFG.tf),
    IND: { ema: I.ema, rsi: I.rsi, rsiSeries: I.rsiSeries, atr: I.atr, atrBase: I.atrBase, eff: I.eff, bb: I.bb, hl: I.hl, heikin: I.heikin, resample: (cs, k) => I.resample(cs, k, CFG.tf) },
    GRP: core.strategies.GRP, IMP: core.strategies.IMP, IMPK: core.strategies.IMPK, EXPS: core.catalog.EXPS, HZ: core.catalog.HZ, qk: core.catalog.qk,
    wil: core.stats.wil,
    maybeTrade: F.maybeTrade, placeOrder: F.placeOrder, confirmOrder: F.confirmOrder, watchdog: F.watchdog, finishOpen: F.finishOpen, settle: F.settle,
    voidTrade: F.voidTrade, failPending: F.failPending, onWsDown: F.onWsDown, killSwitch: F.killSwitch, setTf: F.setTf, resetLearning: F.resetLearning,
    saveAll: F.saveAll, buildExport: F.buildExport, importData: F.importData, simSummary: F.simSummary, reasonsOf: F.reasonsOf,
    view: () => F.view(readShown()), labView: F.lab, diagnostics, restore: F.restore,
    BE: F.BE, BEA: F.BEA, payoutOf: F.payoutOf, setPayout: F.setPayout,
    evalVariants: F.evalVariants, loadSV: F.loadSV, adoptExp: F.adoptExp, resetCfg: F.resetCfg,
    cleanJournal: F.cleanJournal, cleanLog: F.cleanLog, idbRestore: F.idbRestore, mirror: F.mirror, IDB: F.IDB,
    snapshot: F.snapshot, applySnapshot: F.applySnapshot, applyCfg: F.applyCfg, cfgSnap: F.cfgSnap,
    REC: F.REC, RECF: core.format.RECF, recCheck: core.format.recCheck, recMake: core.format.recMake, recDecide: core.format.recDecide, recGaps: core.format.recGaps,
    recParse: core.format.recParse, fnv1a: core.format.fnv1a,
    recOnCandle: F.recOnCandle, recEnqueue: F.recEnqueue, recFlush: F.recFlush, recScanGaps: F.recScanGaps, recExport: F.recExport, recImport: F.recImport,
    recClear: F.recClear, recSetOn: F.recSetOn, recInit: F.recInit, recRefreshSeries: F.recRefreshSeries, recMemBackend: F.recMemBackend
  };
}
},
/* ---- platform/dom.js ---- */
"platform/dom": function (module, exports, require) {
'use strict';
// طبقة المنصة — قراءات من صفحة المنصة (للعرض فقط) وتنزيل الملفات. لا نقر على أي عنصر من عناصر المنصة.
const ASSET_SEL = ['.current-symbol', '.pair-name', '.chart-item .pair', '.symbol-name', '[class*="current-symbol"]', '[class*="symbol-name"]'];
function readShownAsset(doc) {
  try { for (const s of ASSET_SEL) { const el = doc.querySelector(s); const t = el && (el.textContent || '').trim(); if (t) return t; } } catch (e) {}
  return null;
}
// تنزيل ملف ينشئه البوت نفسه (رابط مؤقت يُنقر ثم يُزال) — النقر الوحيد على رابط، وهو عنصر يملكه البوت
function downloadText(win, name, text, mime) {
  const doc = win.document, blob = new win.Blob([text], { type: mime || 'text/plain' });
  const url = win.URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url; a.download = name;
  doc.body.appendChild(a); a.click(); a.remove(); // تنزيل ملف فقط
  win.setTimeout(() => win.URL.revokeObjectURL(url), 5000);
}
module.exports = { readShownAsset, downloadText, ASSET_SEL };
},
/* ---- platform/ws.js ---- */
"platform/ws": function (module, exports, require) {
'use strict';
// طبقة المنصة — اعتراض WebSocket للقراءة فقط وترجمة رسائل المنصة إلى أوامر المحرك.
// هذه الوحدة وحدها تعرف صيغة رسائل المنصة (Socket.IO: 42[...] نصي، 451-[...] + إطار ثنائي).
// لا نعترض send ولا نرسل شيئًا إطلاقًا.
const WS_GRACE_MS = 3000; // مهلة قبل اعتبار الانقطاع حقيقيًا (إعادة اتصال المنصة العادية تستغرق ثوانٍ قليلة)

// ترجمة رسالة واحدة إلى استدعاءات المحرك (مكشوفة للاختبارات باسم handle)
function createHandler(E) {
  const [feedTick, loadHistory, logErr] = E.use('feedTick', 'loadHistory', 'logErr');
  return function handle(kind, j) {
    try {
      if (kind === 'stream' && Array.isArray(j)) j.forEach(x => { if (Array.isArray(x) && x.length >= 3) feedTick(String(x[0]), +x[1], +x[2]); });
      if (kind === 'hist' && j && j.asset && Array.isArray(j.history)) loadHistory(j.asset, j.history);
    } catch (e) { E.S.loading = false; logErr('HANDLE', String(e && e.message || e)); }
  };
}

// تركيب الاعتراض على window.WebSocket. win: كائن النافذة (أو بديل في الاختبار)، timers: { setTimeout, clearTimeout }.
function installSocketTap(win, E, handle, timers) {
  const [connOpen, connLost, onWsDown, logErr] = E.use('connOpen', 'connLost', 'onWsDown', 'logErr');
  let expect = null, expectWs = null, chain = Promise.resolve();
  const toText = d => (win.Blob && d instanceof win.Blob) ? d.text() : Promise.resolve(new TextDecoder().decode(d));
  const liveSockets = new Set();
  let wsDownTimer = null;
  function onMsg(ev) {
    const d = ev.data;
    if (typeof d === 'string') {
      if (/^45\d-/.test(d)) {
        expect = d.includes('updateStream') ? 'stream' : /updateHistoryNew/.test(d) ? 'hist' : null;
        expectWs = expect ? ev.target : null;
        return;
      }
      const m = /^42\d*(\[[\s\S]*)$/.exec(d);
      if (m) {
        try {
          const j = JSON.parse(m[1]);
          if (j[0] === 'updateStream') handle('stream', j[1]);
          else if (/^updateHistoryNew/.test(j[0])) handle('hist', j[1]);
        } catch (e) {}
      }
      return;
    }
    if (expect && (!expectWs || ev.target === expectWs)) {
      const kind = expect; expect = null; expectWs = null;
      chain = chain.then(() => toText(d)).then(t => handle(kind, JSON.parse(t))).catch(e => { logErr('WS_PARSE', String(e && e.message || e)); });
    }
  }
  const NativeWS = win.WebSocket;
  if (!NativeWS) return false;
  win.WebSocket = function (url, proto) {
    const ws = proto !== undefined ? new NativeWS(url, proto) : new NativeWS(url);
    ws.addEventListener('message', onMsg);
    ws.addEventListener('open', () => {
      liveSockets.add(ws);
      connOpen();
      if (wsDownTimer) { timers.clearTimeout(wsDownTimer); wsDownTimer = null; } // رجع الاتصال خلال المهلة: لا انقطاع فعلي
    });
    ws.addEventListener('close', () => {
      const wasLive = liveSockets.delete(ws);
      if (expectWs === ws) { expect = null; expectWs = null; } // لا نفسّر رسالة ثنائية قادمة من اتصال مغلق
      if (!wasLive) return;            // اتصال فشل قبل أن يفتح: ليس انقطاعًا جديدًا
      if (liveSockets.size) return;    // ما زال هناك اتصال حي آخر
      connLost();                      // نوقف التحليل والدخول فورًا
      if (wsDownTimer) return;         // الانقطاع مسجَّل قيد المهلة أصلًا
      wsDownTimer = timers.setTimeout(() => { // لا نسجّل خطأ ولا نُلغي صفقة إلا لو طال الانقطاع
        wsDownTimer = null;
        if (liveSockets.size) return;
        logErr('WS_DOWN', 'انقطع اتصال WebSocket');
        onWsDown();
      }, WS_GRACE_MS);
    });
    return ws; // لا نعترض send ولا نرسل شيئًا
  };
  win.WebSocket.prototype = NativeWS.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(k => { win.WebSocket[k] = NativeWS[k]; });
  return true;
}
module.exports = { createHandler, installSocketTap, WS_GRACE_MS };
},
/* ---- recorder/format.js ---- */
"recorder/format": function (module, exports, require) {
'use strict';
// المسجّل — القواعد والصيغ (بحتة): صحة السجل، قاعدة منع التكرار، الفجوات، JSONL/CSV، checksum.
// لم تتغير القواعد عن v3.5 (انظر docs/RECORDER_DESIGN.md). الفرق الوحيد: rx (ساعة الجهاز) يُمرَّر بدل قراءته هنا.
const REC_SCHEMA = 1;
const REC_DB = 'wsnf33s_rec';
// ترتيب الحقول ثابت: التصدير حتمي (نفس البيانات ⇒ نفس الملف ونفس الـchecksum)
const RECF = ['a', 'tf', 't', 'tc', 'o', 'h', 'l', 'c', 'n', 'ft', 'lt', 'mg', 'cts', 'src', 'rx', 'v'];
const REC_RANK = { hist: 1, mixed: 2, live: 3 };
const REC_EV_MAX = 6000;
const recKey = (a, tf) => a + '|' + tf;
const recPk = r => r.a + '|' + r.tf + '|' + r.t;
// FNV-1a 32-bit: للتحقق من سلامة الملفات المصدَّرة (اكتشاف التلف/التعديل، ليس تشفيرًا)
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return ('0000000' + h.toString(16)).slice(-8);
}

// ---- قواعد صحة السجل (نفسها للتسجيل الحي والاستيراد) ----
function recCheck(r) {
  if (!r || typeof r !== 'object') return 'سجل غير صالح';
  if (typeof r.a !== 'string' || !r.a || r.a.length > 40) return 'اسم أصل غير صالح';
  if (!Number.isInteger(r.tf) || r.tf < 1 || r.tf > 86400) return 'إطار زمني غير صالح';
  for (const f of ['t', 'tc', 'o', 'h', 'l', 'c', 'n', 'ft', 'lt', 'mg', 'cts']) if (!Number.isFinite(r[f])) return 'قيمة غير رقمية: ' + f;
  if (r.t % r.tf !== 0) return 'وقت افتتاح غير محاذٍ للإطار';
  if (r.tc !== r.t + r.tf) return 'وقت إغلاق غير متسق';
  if (!(r.l > 0) || r.h < r.l || r.h < Math.max(r.o, r.c) || r.l > Math.min(r.o, r.c)) return 'أسعار OHLC غير متسقة';
  if (!Number.isInteger(r.n) || r.n < 1) return 'عدد تيكات غير صالح';
  if (r.ft < r.t || r.lt < r.ft || r.lt >= r.tc) return 'توقيت التيكات خارج الشمعة';
  if (r.mg < 0 || r.mg > r.tf) return 'فجوة تيكات غير منطقية';
  if (r.cts < r.tc) return 'بيانات مستقبلية: الشمعة سُجّلت قبل انتهاء وقتها';
  if (!REC_RANK[r.src]) return 'مصدر غير معروف';
  if (r.v !== REC_SCHEMA) return 'إصدار مخطط غير مدعوم';
  return '';
}
// يبني السجل من الشمعة المبنية من التيكات. لا يضيف أي معلومة من خارج [t, t+tf).
// rx: ساعة الجهاز لحظة التسجيل (يمرّرها المستدعي؛ هذه الوحدة بلا ساعة)
function recMake(asset, c, tf, tsClose, rx) {
  return {
    a: asset, tf, t: c.t, tc: c.t + tf, o: c.o, h: c.h, l: c.l, c: c.c, n: c.nt, ft: c.ft, lt: c.lt,
    mg: +(c.mg || 0).toFixed(3), cts: tsClose, src: c.sl && c.sh ? 'mixed' : c.sl ? 'live' : 'hist', rx, v: REC_SCHEMA
  };
}
// قاعدة منع التكرار: المصدر الأعلى يستبدل الأدنى؛ غير ذلك يبقى الموجود (ويُعدّ تعارضًا إن اختلفت الأسعار)
function recDecide(ex, r) {
  if (!ex) return 'added';
  if (REC_RANK[r.src] > REC_RANK[ex.src]) return 'replaced';
  return ex.o === r.o && ex.h === r.h && ex.l === r.l && ex.c === r.c ? 'dup' : 'conflict';
}
const recDiff = (ex, r) => ex && ex.c ? Math.max(...['o', 'h', 'l', 'c'].map(f => Math.abs(r[f] - ex[f]) / Math.abs(ex.c))) : 0;
// الفجوات في سلسلة أوقات مرتبة
function recGaps(ts, tf) {
  const out = [];
  for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] > tf) out.push({ from: ts[i - 1] + tf, to: ts[i], n: (ts[i] - ts[i - 1]) / tf - 1 });
  return out;
}

const recLine = r => JSON.stringify(Object.fromEntries(RECF.map(f => [f, r[f]])));
const isoOf = s => new Date(s * 1000).toISOString();
const CSVF = ['asset', 'tf', 'open_time_utc', 'open_ts', 'close_ts', 'open', 'high', 'low', 'close', 'ticks', 'first_tick_ts', 'last_tick_ts', 'max_tick_gap_s', 'close_tick_ts', 'src', 'recorded_ms', 'schema'];
function recNormalize(x) {
  const num = v => (v === '' || v === null || v === undefined) ? NaN : +v;
  return { a: String(x.a == null ? '' : x.a), tf: num(x.tf), t: num(x.t), tc: num(x.tc), o: num(x.o), h: num(x.h), l: num(x.l), c: num(x.c), n: num(x.n),
    ft: num(x.ft), lt: num(x.lt), mg: num(x.mg), cts: num(x.cts), src: String(x.src || ''), rx: Number.isFinite(num(x.rx)) ? num(x.rx) : 0, v: num(x.v) };
}
function recParse(text) {
  const lines = String(text).split(/\r?\n/).filter(x => x.trim() !== '');
  if (!lines.length) throw new Error('الملف فارغ');
  const recs = [];
  if (lines[0].trim().startsWith('{')) {
    let head;
    try { head = JSON.parse(lines[0]); } catch (e) { throw new Error('سطر البيان غير صالح'); }
    if (!head || head.type !== 'wsnf-candles') throw new Error('ليس ملف شموع من wsnf');
    if (!(head.schema <= REC_SCHEMA)) throw new Error('إصدار مخطط أحدث من المدعوم: ' + head.schema);
    const body = lines.slice(1);
    if (head.checksum && head.checksum !== 'fnv1a32:' + fnv1a(body.join('\n'))) throw new Error('الـchecksum لا يطابق: الملف تالف أو معدّل، رُفض بالكامل');
    if (Number.isFinite(head.count) && head.count !== body.length) throw new Error('عدد الأسطر (' + body.length + ') لا يطابق البيان (' + head.count + ')');
    body.forEach((ln, i) => { try { recs.push(recNormalize(JSON.parse(ln))); } catch (e) { recs.push({ __bad: 'سطر JSON غير صالح ' + (i + 2) }); } });
    return { fmt: 'jsonl', recs };
  }
  const cols = lines[0].split(',').map(x => x.trim());
  const ix = f => cols.indexOf(f);
  if (ix('asset') < 0 || ix('open_ts') < 0 || ix('close') < 0) throw new Error('ترويسة CSV غير معروفة');
  const map = { a: 'asset', tf: 'tf', t: 'open_ts', tc: 'close_ts', o: 'open', h: 'high', l: 'low', c: 'close', n: 'ticks', ft: 'first_tick_ts', lt: 'last_tick_ts', mg: 'max_tick_gap_s', cts: 'close_tick_ts', src: 'src', rx: 'recorded_ms', v: 'schema' };
  lines.slice(1).forEach(ln => {
    const v = ln.split(','), o = {};
    for (const f in map) o[f] = ix(map[f]) >= 0 ? v[ix(map[f])] : undefined;
    recs.push(recNormalize(o));
  });
  return { fmt: 'csv', recs };
}
module.exports = { REC_SCHEMA, REC_DB, RECF, REC_RANK, REC_EV_MAX, recKey, recPk, fnv1a, recCheck, recMake, recDecide, recDiff, recGaps, recLine, isoOf, CSVF, recNormalize, recParse };
},
/* ---- recorder/recorder.js ---- */
"recorder/recorder": function (module, exports, require) {
'use strict';
// المسجّل — الحالة والتخزين (IndexedDB أو ذاكرة) والتصدير/الاستيراد.
// منفصل عن المحرك: يستمع لأحداثه فقط ('candle'، 'ws'، 'history'، 'stale'، 'tf') ولا يؤثر على التحليل أو القرار.
const { SCRIPT_VERSION, KEYS } = require('../engine/state');
const { REC_SCHEMA, REC_DB, RECF, REC_RANK, REC_EV_MAX, recKey, recPk, fnv1a, recCheck, recMake, recDecide, recDiff, recGaps, recLine, isoOf, CSVF, recNormalize, recParse } = require('./format');

module.exports = function install(E) {
  const { S, CFG } = E, clock = E.clock;
  const IDBR = { bound: (...a) => E.env.IDBKeyRange.bound(...a), lowerBound: (...a) => E.env.IDBKeyRange.lowerBound(...a) };
  const [LSget, LSset, logErr] = E.use('LSget', 'LSset', 'logErr');
  const REC = {
    on: true, ready: false, kind: '', err: '', backend: null, openP: null,
    q: new Map(), evq: [], flushing: null,
    series: {},            // a|tf → { a, tf, count, first, last, capped }
    pn: {},                // a|tf → سجلات في الانتظار أو قيد الحفظ (تُحتسب في حد السلسلة قبل حفظها)
    lastT: {},             // a|tf → آخر وقت افتتاح معروف (مخزَّن أو في الانتظار) لاكتشاف الفجوات الحية
    sess: { added: 0, replaced: 0, dup: 0, conflicts: 0, maxDiff: 0, rejected: 0, reasons: {}, gaps: 0, flushes: 0, lastFlush: 0, flushErr: '', dropped: 0 },
    events: [], scan: null
  };
  // ---- واجهتا تخزين بنفس الدوال: IndexedDB (المتصفح) وذاكرة (احتياط/اختبار) ----
  function recMemBackend(store) {
    const C = store.c || (store.c = new Map()), E = store.e || (store.e = []);
    const inSeries = (r, a, tf) => r.a === a && r.tf === tf;
    return {
      kind: 'memory',
      open: () => Promise.resolve(),
      putMany(recs) {
        return Promise.resolve(recs.map(r => {
          const ex = C.get(recPk(r)), d = recDecide(ex, r);
          if (d === 'added' || d === 'replaced') C.set(recPk(r), { ...r });
          return { d, ex: ex ? { ...ex } : null };
        }));
      },
      addEvents(evs) { E.push(...evs.map(e => ({ ...e }))); if (E.length > REC_EV_MAX) E.splice(0, E.length - REC_EV_MAX); return Promise.resolve(); },
      series() {
        const m = {};
        for (const r of C.values()) {
          const s = m[recKey(r.a, r.tf)] || (m[recKey(r.a, r.tf)] = { a: r.a, tf: r.tf, count: 0, first: r.t, last: r.t });
          s.count++; if (r.t < s.first) s.first = r.t; if (r.t > s.last) s.last = r.t;
        }
        return Promise.resolve(Object.values(m).sort((x, y) => x.a < y.a ? -1 : x.a > y.a ? 1 : x.tf - y.tf));
      },
      range(a, tf, from = -Infinity, to = Infinity) {
        return Promise.resolve([...C.values()].filter(r => inSeries(r, a, tf) && r.t >= from && r.t <= to).sort((x, y) => x.t - y.t).map(r => ({ ...r })));
      },
      times(a, tf) { return this.range(a, tf).then(rs => rs.map(r => r.t)); },
      events(limit = 200) { return Promise.resolve(E.slice(-limit).reverse().map(e => ({ ...e }))); },
      clear() { C.clear(); E.length = 0; return Promise.resolve(); }
    };
  }
  function recIdbBackend() {
    let db = null;
    const done = tx => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('abort')); });
    const KR = (a, tf, from = -Infinity, to = Infinity) => IDBR.bound([a, tf, from], [a, tf, to]);
    return {
      kind: 'indexeddb',
      open() {
        return new Promise((res, rej) => {
          const q = E.env.indexedDB.open(REC_DB, 1);
          q.onupgradeneeded = () => {
            const d = q.result;
            if (!d.objectStoreNames.contains('candles')) d.createObjectStore('candles', { keyPath: ['a', 'tf', 't'] });
            if (!d.objectStoreNames.contains('events')) d.createObjectStore('events', { autoIncrement: true });
          };
          q.onsuccess = () => { db = q.result; db.onversionchange = () => { try { db.close(); } catch (e) {} }; res(); };
          q.onerror = () => rej(q.error);
          q.onblocked = () => rej(new Error('IndexedDB blocked'));
        }).then(() => this.pruneEvents());
      },
      // القراءة ثم الكتابة داخل نفس المعاملة: لا يمكن لكتابتين متزامنتين أن تتجاوزا قاعدة منع التكرار
      putMany(recs) {
        const tx = db.transaction('candles', 'readwrite'), st = tx.objectStore('candles'), out = new Array(recs.length);
        recs.forEach((r, i) => {
          const g = st.get([r.a, r.tf, r.t]);
          g.onsuccess = () => { const ex = g.result || null, d = recDecide(ex, r); out[i] = { d, ex }; if (d === 'added' || d === 'replaced') st.put(r); };
        });
        return done(tx).then(() => out);
      },
      addEvents(evs) { const tx = db.transaction('events', 'readwrite'), st = tx.objectStore('events'); evs.forEach(e => st.add(e)); return done(tx); },
      pruneEvents() {
        const tx = db.transaction('events', 'readwrite'), st = tx.objectStore('events');
        const q = st.count();
        q.onsuccess = () => {
          let extra = q.result - REC_EV_MAX;
          if (extra <= 0) return;
          const cur = st.openCursor();
          cur.onsuccess = () => { const c = cur.result; if (c && extra-- > 0) { c.delete(); c.continue(); } };
        };
        return done(tx);
      },
      // السلاسل: نقفز من سلسلة إلى التالية بالمفتاح [a, tf, +∞] بدل المرور على كل الشموع
      series() {
        return new Promise((res, rej) => {
          const tx = db.transaction('candles'), st = tx.objectStore('candles'), out = [];
          const next = lower => {
            const r = st.openKeyCursor(lower ? IDBR.lowerBound(lower, true) : null);
            r.onsuccess = () => {
              const cur = r.result;
              if (!cur) return;
              const [a, tf, t] = cur.key, item = { a, tf, count: 0, first: t, last: t };
              out.push(item);
              const cq = st.count(KR(a, tf)); cq.onsuccess = () => { item.count = cq.result; };
              const lq = st.openKeyCursor(KR(a, tf), 'prev'); lq.onsuccess = () => { if (lq.result) item.last = lq.result.key[2]; };
              next([a, tf, Infinity]);
            };
          };
          next(null);
          done(tx).then(() => res(out), rej);
        });
      },
      range(a, tf, from, to) {
        return new Promise((res, rej) => {
          const tx = db.transaction('candles'), q = tx.objectStore('candles').getAll(KR(a, tf, from, to));
          q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
        });
      },
      times(a, tf) {
        return new Promise((res, rej) => {
          const tx = db.transaction('candles'), q = tx.objectStore('candles').getAllKeys(KR(a, tf));
          q.onsuccess = () => res(q.result.map(k => k[2])); q.onerror = () => rej(q.error);
        });
      },
      events(limit = 200) {
        return new Promise((res, rej) => {
          const tx = db.transaction('events'), out = [], q = tx.objectStore('events').openCursor(null, 'prev');
          q.onsuccess = () => { const c = q.result; if (c && out.length < limit) { out.push(c.value); c.continue(); } };
          done(tx).then(() => res(out), rej);
        });
      },
      clear() { const tx = db.transaction(['candles', 'events'], 'readwrite'); tx.objectStore('candles').clear(); tx.objectStore('events').clear(); return done(tx); }
    };
  }

  // ---- الحالة والأحداث ----
  function recEvent(e) {
    const ev = { at: clock(), ...e };
    REC.events.unshift(ev);
    if (REC.events.length > 200) REC.events.pop();
    REC.evq.push(ev);
    if (ev.type === 'gap') REC.sess.gaps++;
  }
  function recSetOn(on) { REC.on = !!on; LSset(KEYS.RECCFG, { on: REC.on }); recEvent({ type: on ? 'rec_on' : 'rec_off' }); }
  function recRefreshSeries() {
    return REC.backend.series().then(list => {
      const m = {};
      for (const s of list) {
        const k = recKey(s.a, s.tf);
        m[k] = { ...s, capped: s.count >= CFG.recMaxPerSeries };
        if (REC.lastT[k] === undefined || s.last > REC.lastT[k]) REC.lastT[k] = s.last;
      }
      REC.series = m;
      return list;
    });
  }
  function recInit() {
    const c = LSget(KEYS.RECCFG, null);
    REC.on = !(c && c.on === false);
    let be;
    if (E.env.recMem) be = recMemBackend(E.env.recMem); // مخزن ذاكرة مشترك تحقنه الاختبارات فقط
    else if (E.env.indexedDB && E.env.IDBKeyRange) be = recIdbBackend();
    else { be = recMemBackend({}); REC.err = 'IndexedDB غير متاح: التسجيل في الذاكرة فقط وسيضيع عند إعادة التحميل'; }
    REC.backend = be; REC.kind = be.kind;
    REC.openP = be.open()
      .catch(e => {
        REC.err = 'تعذّر فتح IndexedDB (' + String(e && e.message || e) + '): التسجيل في الذاكرة فقط وسيضيع عند إعادة التحميل';
        logErr('REC_OPEN', REC.err);
        REC.backend = recMemBackend({}); REC.kind = 'memory';
      })
      .then(() => recRefreshSeries())
      .then(() => { REC.ready = true; recEvent({ type: 'start', store: REC.kind }); return recFlush(); })
      .catch(e => { REC.err = 'خطأ في تهيئة المسجّل: ' + String(e && e.message || e); logErr('REC_INIT', REC.err); });
    return REC.openP;
  }

  // ---- التسجيل: يُستدعى من onClose بعد انتهاء الشمعة فقط ----
  function recReject(asset, tf, t, why, live) {
    REC.sess.rejected++;
    REC.sess.reasons[why] = (REC.sess.reasons[why] || 0) + 1;
    if (live) recEvent({ type: 'reject', a: asset, tf, t, why });
  }
  // يُستدعى عبر حدث المحرك 'candle' لحظة إغلاق الشمعة (وصول تيك بعد نهايتها). الحمولة تحمل كل ما يلزم.
  function recOnCandle(asset, c, complete, tsClose, auditBad, ctx) {
    if (!REC.on || tsClose === undefined) return;
    const tf = ctx.tf, live = ctx.live;
    let why = '';
    if (auditBad) why = 'فشل تدقيق المستقبل: ' + auditBad;
    else if (!complete) why = 'شمعة ناقصة (أول/آخر تيك بعيد عن حدودها)';
    else if ((c.mg || 0) > tf * CFG.recMaxGapFrac) why = 'فجوة تيكات داخل الشمعة';
    else if (c.sl && ctx.wsCloseAt && c.rx0 && ctx.wsCloseAt >= c.rx0) why = 'انقطاع الاتصال أثناء الشمعة';
    const r = recMake(asset, c, tf, tsClose, clock());
    if (!why) why = recCheck(r);
    const k = recKey(asset, tf), sr = REC.series[k];
    if (!why && ((sr ? sr.count : 0) + (REC.pn[k] || 0) >= CFG.recMaxPerSeries) && !REC.q.has(recPk(r))) why = 'بلغت السلسلة الحد الأقصى (' + CFG.recMaxPerSeries + ')';
    if (why) { recReject(asset, tf, c.t, why, live); return; }
    const last = REC.lastT[k];
    if (live && last !== undefined && r.t > last + tf) recEvent({ type: 'gap', a: asset, tf, from: last + tf, to: r.t, n: (r.t - last) / tf - 1 });
    recEnqueue(r);
    if (live) recFlush();
  }
  function recEnqueue(r) {
    const pk = recPk(r), ex = REC.q.get(pk);
    if (ex) {
      const d = recDecide(ex, r);
      if (d === 'replaced') REC.q.set(pk, r);
      else { REC.sess[d === 'dup' ? 'dup' : 'conflicts']++; if (d === 'conflict') REC.sess.maxDiff = Math.max(REC.sess.maxDiff, recDiff(ex, r)); }
    } else {
      if (REC.q.size >= 100000) { REC.sess.dropped++; return; } // حماية الذاكرة إن تعطّل التخزين طويلًا
      REC.q.set(pk, r);
      REC.pn[recKey(r.a, r.tf)] = (REC.pn[recKey(r.a, r.tf)] || 0) + 1;
    }
    const k = recKey(r.a, r.tf);
    if (REC.lastT[k] === undefined || r.t > REC.lastT[k]) REC.lastT[k] = r.t;
  }
  // الحفظ: دفعات متسلسلة (لا تتداخل)، وعند الفشل تعود السجلات إلى قائمة الانتظار
  function recFlush() {
    const prev = REC.flushing || Promise.resolve();
    if (!REC.ready || (!REC.q.size && !REC.evq.length)) return prev;
    const batch = [...REC.q.values()], evs = REC.evq.splice(0);
    REC.q.clear();
    const be = REC.backend;
    let more = [];
    const p = prev.then(() => be.putMany(batch)).then(res => {
      const S2 = REC.sess;
      res.forEach((x, i) => {
        const r = batch[i], k = recKey(r.a, r.tf);
        REC.pn[k] = Math.max(0, (REC.pn[k] || 0) - 1);
        if (x.d === 'added') {
          const s = REC.series[k] || (REC.series[k] = { a: r.a, tf: r.tf, count: 0, first: r.t, last: r.t, capped: false });
          s.count++; if (r.t < s.first) s.first = r.t; if (r.t > s.last) s.last = r.t;
          if (s.count >= CFG.recMaxPerSeries && !s.capped) { s.capped = true; recEvent({ type: 'cap', a: r.a, tf: r.tf, n: s.count }); }
          S2.added++;
        } else if (x.d === 'replaced') S2.replaced++;
        else if (x.d === 'dup') S2.dup++;
        else { S2.conflicts++; S2.maxDiff = Math.max(S2.maxDiff, recDiff(x.ex, r)); }
      });
      more = REC.evq.splice(0);
      const all = evs.concat(more);
      return all.length ? be.addEvents(all) : null;
    }).then(() => { REC.sess.flushes++; REC.sess.lastFlush = clock(); REC.sess.flushErr = ''; }, e => {
      REC.sess.flushErr = String(e && e.message || e);
      logErr('REC_FLUSH', REC.sess.flushErr);
      // إعادة المحاولة لاحقًا: إن كانت الشموع قد حُفظت فعلًا فستُحسب «مكررة» ولن تتكرر في التخزين
      batch.forEach(r => { if (!REC.q.has(recPk(r))) REC.q.set(recPk(r), r); else { const k = recKey(r.a, r.tf); REC.pn[k] = Math.max(0, (REC.pn[k] || 0) - 1); } });
      REC.evq.unshift(...evs, ...more);
    }).then(() => { if (REC.flushing === p) REC.flushing = null; });
    REC.flushing = p;
    return p;
  }
  // فحص الفجوات من البيانات المخزّنة نفسها (المرجع الموثوق، يشمل ما قبل إعادة التحميل)
  function recScanGaps() {
    return recFlush().then(() => Promise.all(Object.values(REC.series).map(s => REC.backend.times(s.a, s.tf).then(ts => {
      const g = recGaps(ts, s.tf);
      return { a: s.a, tf: s.tf, gaps: g.length, missing: g.reduce((x, y) => x + y.n, 0), largest: g.reduce((x, y) => Math.max(x, y.n), 0) };
    })))).then(out => { REC.scan = { at: clock(), out }; return out; });
  }

  // ---- التصدير والاستيراد ----
  function recExport(fmt = 'jsonl', a = null, tf = null) {
    let list = [];
    // نختار السلاسل بعد انتهاء الحفظ (وإلا تُستبعد شموع كانت في قائمة الانتظار لحظة الطلب)
    return recFlush().then(() => {
      list = Object.values(REC.series).filter(s => (!a || s.a === a) && (!tf || s.tf === tf))
        .sort((x, y) => x.a < y.a ? -1 : x.a > y.a ? 1 : x.tf - y.tf);
      return Promise.all(list.map(s => REC.backend.range(s.a, s.tf)));
    }).then(all => {
      const series = [], rows = [];
      all.forEach((recs, i) => {
        const g = recGaps(recs.map(r => r.t), list[i].tf);
        series.push({ a: list[i].a, tf: list[i].tf, count: recs.length, first: recs.length ? recs[0].t : null, last: recs.length ? recs[recs.length - 1].t : null, gaps: g.length, missing: g.reduce((x, y) => x + y.n, 0) });
        recs.forEach(r => rows.push(r));
      });
      let text;
      if (fmt === 'csv') {
        text = CSVF.join(',') + '\n' + rows.map(r => [r.a, r.tf, isoOf(r.t), r.t, r.tc, r.o, r.h, r.l, r.c, r.n, r.ft, r.lt, r.mg, r.cts, r.src, r.rx, r.v].join(',')).join('\n') + (rows.length ? '\n' : '');
      } else {
        const body = rows.map(recLine).join('\n');
        const head = { type: 'wsnf-candles', schema: REC_SCHEMA, app: 'wsnf smart bot', version: SCRIPT_VERSION, exportedAt: new Date(clock()).toISOString(),
          time: 'unix seconds (UTC, platform clock)', fields: RECF, count: rows.length, series, checksum: 'fnv1a32:' + fnv1a(body) };
        text = JSON.stringify(head) + '\n' + body + (rows.length ? '\n' : '');
      }
      return { text, count: rows.length, series, fmt };
    });
  }
  // تحويل سطر مستورد إلى سجل بأنواع صحيحة (أي حقل ناقص يجعله يفشل في recCheck)
  function recImport(text) {
    let parsed;
    try { parsed = recParse(text); } catch (e) { return Promise.reject(e); }
    const out = { fmt: parsed.fmt, read: parsed.recs.length, valid: 0, rejected: 0, reasons: {}, added: 0, replaced: 0, dup: 0, conflicts: 0 };
    const good = [];
    for (const r of parsed.recs) {
      const why = r.__bad || recCheck(r);
      if (why) { out.rejected++; out.reasons[why] = (out.reasons[why] || 0) + 1; } else good.push(r);
    }
    out.valid = good.length;
    const uniq = new Map();
    for (const r of good) { const ex = uniq.get(recPk(r)); if (!ex || recDecide(ex, r) === 'replaced') uniq.set(recPk(r), r); else out.dup++; }
    const list = [...uniq.values()], CH = 2000;
    let chain = (REC.openP || Promise.resolve()).then(() => recFlush());
    for (let i = 0; i < list.length; i += CH) {
      const part = list.slice(i, i + CH);
      chain = chain.then(() => REC.backend.putMany(part)).then(res => res.forEach(x => { out[x.d === 'conflict' ? 'conflicts' : x.d]++; }));
    }
    return chain.then(() => recRefreshSeries()).then(() => {
      recEvent({ type: 'import', fmt: out.fmt, read: out.read, added: out.added, rejected: out.rejected });
      return recFlush();
    }).then(() => out);
  }
  function recClear() {
    REC.q.clear(); REC.evq = []; REC.pn = {};
    return (REC.flushing || Promise.resolve()).then(() => REC.backend.clear()).then(() => {
      REC.series = {}; REC.lastT = {}; REC.pn = {}; REC.scan = null; REC.events = [];
      recEvent({ type: 'clear' });
      return recFlush();
    });
  }
  // تقدير الحجم: يُقاس فعليًا في اختبار المتصفح (navigator.storage.estimate)؛ هنا تقدير للعرض فقط
  const REC_BYTES = 300;
  // الاشتراك في أحداث المحرك (بنفس ترتيب الاستدعاءات المباشرة في v3.5)
  E.on('candle', x => { try { recOnCandle(x.asset, x.c, x.complete, x.tsClose, x.bad, x); } catch (e) { logErr('REC_ERR', String(e && e.message || e)); } });
  E.on('ws', x => recEvent({ type: x.up ? 'ws_up' : 'ws_down' }));
  E.on('history', x => { recEvent({ type: 'hist', a: x.asset, ticks: x.ticks }); recFlush(); });
  E.on('stale', x => recEvent({ type: 'stale', a: x.asset, age: x.age }));
  E.on('tf', x => recEvent({ type: 'tf', from: x.from, to: x.to }));
  E.provide({ REC, recMemBackend, recIdbBackend, recEvent, recSetOn, recRefreshSeries, recInit, recReject, recOnCandle, recEnqueue, recFlush, recScanGaps, recExport, recImport, recClear, REC_BYTES });
};
},
/* ---- ui/ui.js ---- */
"ui/ui": function (module, exports, require) {
'use strict';
// الواجهة — عرض فقط. لا تحسب أي مؤشر أو إحصاء ولا تكتب في حالة المحرك مباشرة:
// تقرأ بيانات جاهزة من نموذج العرض (engine/viewmodel.js) وتنفّذ أوامر صريحة (engine/commands.js).
// لا يوجد فيها أي زر أو كود تنفيذ على المنصة. النقرات الوحيدة: رابط تنزيل وحقلا اختيار ملف يملكهما البوت.
const UI_KEY = 'wsnf33s_ui';
const ESC = s => String(s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const pc = (x, d = 0) => (x * 100).toFixed(d) + '%';
const cellAcc = (n, w) => n ? Math.round(w / n * 1000) / 10 + '%' : '-';
function resLabel(e) {
  if (e.win === null) return e.failed ? 'فشل (افتراضي)' : e.voided ? 'ملغاة' : e.stale ? 'غير معروفة' : e.tie ? 'تعادل' : '...';
  return (e.win ? 'ربح' : 'خسارة') + ' افتراضي';
}
const kindLabel = e => e.auto ? 'صفقة افتراضية' : e.try ? 'محاولة افتراضية' : 'إشارة فقط';
const EV_LABEL = { start: 'بدء', gap: 'فجوة', ws_down: 'انقطاع الاتصال', ws_up: 'عودة الاتصال', stale: 'تقادم السعر', reject: 'رفض شمعة', hist: 'تاريخ من المنصة', tf: 'تغيير الإطار', cap: 'بلوغ الحد', import: 'استيراد', clear: 'مسح', rec_on: 'تشغيل التسجيل', rec_off: 'إيقاف التسجيل' };
const utc = s => s === null || s === undefined ? '-' : new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ');

const CSS = `
:host{all:initial}*{box-sizing:border-box;margin:0}
.full{position:fixed;inset:0;z-index:2147483647;overflow:auto;direction:rtl;font:13px/1.6 "Segoe UI",Tahoma,sans-serif;color:#e8ecff;background:#070b1ef7;padding:18px;animation:fin .5s ease both}
.full::before{content:"";position:fixed;inset:-20%;background:radial-gradient(600px 400px at 80% 10%,#4b5bff33,transparent 70%),radial-gradient(500px 380px at 10% 90%,#3ddbb022,transparent 70%);animation:drift 18s ease-in-out infinite alternate;pointer-events:none;z-index:-1}
@keyframes drift{from{transform:translate(0,0)}to{transform:translate(40px,-30px)}}
@keyframes fin{from{opacity:0;transform:scale(.985)}to{opacity:1;transform:none}}
.full.hide{display:none}
.splash{position:fixed;inset:0;z-index:2147483647;display:grid;place-content:center;justify-items:center;gap:18px;background:radial-gradient(circle at 50% 40%,#1b2a7a,#070b1e 70%);direction:rtl;transition:opacity .8s ease,visibility .8s}
.splash.out{opacity:0;visibility:hidden}
.sp-ring{position:absolute;width:260px;height:260px;border-radius:50%;border:2px solid transparent;border-top-color:#7aa2ff;border-right-color:#3ddbb0;animation:spin 1.6s linear infinite;opacity:.8}
.sp-ring.r2{width:200px;height:200px;border-top-color:#3ddbb0;border-right-color:transparent;animation-duration:1.1s;animation-direction:reverse}
@keyframes spin{to{transform:rotate(360deg)}}
.sp-logo{position:relative;font-size:46px;font-weight:900;letter-spacing:2px;display:flex;gap:2px;direction:ltr}
.sp-logo .ch{display:inline-block;background:linear-gradient(180deg,#fff,#7aa2ff 55%,#3ddbb0);-webkit-background-clip:text;background-clip:text;color:transparent;opacity:0;transform:translateY(-40px) scale(.6);animation:drop .7s cubic-bezier(.2,1.4,.4,1) forwards;animation-delay:calc(var(--i) * .08s + .2s)}
.sp-logo .sp{width:14px}
@keyframes drop{to{opacity:1;transform:none}}
.sp-sub{position:relative;color:#8fa0d6;font-size:13px;letter-spacing:1px;opacity:0;animation:fadeup .6s ease forwards 1.4s}
.sp-bar{position:relative;width:260px;height:4px;border-radius:4px;background:#1f2a60;overflow:hidden;opacity:0;animation:fadeup .4s ease forwards 1.2s}
.sp-bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#7aa2ff,#3ddbb0);box-shadow:0 0 12px #3ddbb0;animation:load 1.6s ease forwards 1.2s}
@keyframes load{to{width:100%}}
@keyframes fadeup{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px;padding:10px 14px;border:1px solid #1f2a60;border-radius:16px;background:linear-gradient(90deg,#0e1538cc,#0b1230cc)}
.brand{font-size:20px;font-weight:900;display:flex;gap:2px;align-items:center;letter-spacing:.5px;direction:ltr}
.brand .ch{display:inline-block;background:linear-gradient(180deg,#ffffff,#7aa2ff 60%,#3ddbb0);-webkit-background-clip:text;background-clip:text;color:transparent;animation:wave 2.6s ease-in-out infinite;animation-delay:calc(var(--i) * .09s)}
.brand .sp{width:6px}
.brand .dot{width:10px;height:10px;border-radius:50%;background:#3ddbb0;box-shadow:0 0 14px #3ddbb0;animation:pl 1.6s infinite;margin-inline-start:8px}
.brand small{color:#7f8cc4;font-weight:500;font-size:11.5px;margin-inline-start:8px;letter-spacing:0;direction:rtl}
@keyframes wave{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
@keyframes pl{50%{opacity:.35;transform:scale(.7)}}
.nav{display:flex;gap:6px;flex-wrap:wrap}
.nav button{border-radius:12px;padding:7px 14px;background:transparent;border:1px solid #26336e;color:#9fb0e6}
.nav button.on{background:linear-gradient(135deg,#3b4fd6,#1fa98a);color:#fff;border-color:transparent;box-shadow:0 6px 18px #3b4fd655}
.chips{display:flex;gap:8px;flex-wrap:wrap}
.chip{padding:2px 10px;border-radius:20px;font-size:11.5px;border:1px solid #26336e;background:#131c42;white-space:nowrap}
.c-u{color:#3ddbb0;border-color:#3ddbb066}.c-d{color:#ff6b7a;border-color:#ff6b7a66}.c-g{color:#f5c45e;border-color:#f5c45e66}.c-m{color:#8d9ad0}
button,select,input{font:inherit;color:#e8ecff;background:#131c42;border:1px solid #26336e;border-radius:10px;padding:6px 12px;cursor:pointer;transition:transform .15s,background .2s,border-color .2s,box-shadow .2s}
button:hover{transform:translateY(-1px);border-color:#4a5bb0;box-shadow:0 4px 14px #0006}
button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #f5c45e}
.page{display:none;animation:fin .35s ease both}
.page.on{display:grid;gap:14px}
.p-home{grid-template-columns:340px 1fr}
.p-chart,.p-log{grid-template-columns:1fr}
.p-strat{grid-template-columns:1.3fr 1fr}
@media(max-width:1000px){.p-home,.p-strat{grid-template-columns:1fr}}
.card{background:linear-gradient(160deg,#16204bd9,#0c1334d9);border:1px solid #1f2a60;border-radius:18px;padding:14px;box-shadow:0 14px 34px #0007;animation:fin .5s ease both;position:relative;overflow:hidden}
.card h3{font-size:12.5px;color:#8fa0d6;font-weight:700;margin-bottom:10px;letter-spacing:.3px;display:flex;justify-content:space-between;align-items:center;gap:8px}
.hero{text-align:center;transition:box-shadow .5s,border-color .5s}
.hero.u{border-color:#3ddbb0;box-shadow:0 0 44px #3ddbb033}
.hero.d{border-color:#ff6b7a;box-shadow:0 0 44px #ff6b7a33}
.gw{position:relative;width:190px;height:190px;margin:6px auto}
.gw svg{width:100%;height:100%;transform:rotate(-90deg)}
.gw circle{fill:none;stroke-width:10;stroke-linecap:round}
.gbg{stroke:#1f2a60}
.gfg{stroke:#8d9ad0;stroke-dasharray:326.7;stroke-dashoffset:326.7;transition:stroke-dashoffset 1s cubic-bezier(.2,.8,.2,1),stroke .4s;filter:drop-shadow(0 0 6px currentColor)}
.gm{position:absolute;inset:0;display:grid;place-content:center}
.gm b{font-size:30px;font-weight:900}
.arrow{font-size:34px;line-height:1;transition:transform .4s}
.hero.u .arrow{animation:bob 1.2s ease-in-out infinite}
.hero.d .arrow{animation:bob 1.2s ease-in-out infinite reverse}
@keyframes bob{50%{transform:translateY(-5px)}}
.dirT{font-size:19px;font-weight:800;margin:6px 0}
.notes{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin:8px 0}
.cdb{height:6px;border-radius:6px;background:#1f2a60;overflow:hidden;margin-top:8px}
.cdb i{display:block;height:100%;width:0;background:linear-gradient(90deg,#7aa2ff,#3ddbb0);transition:width 1s linear}
.row{display:flex;gap:8px;align-items:center;justify-content:space-between;margin:8px 0;flex-wrap:wrap}
.tgl{min-width:130px;font-weight:700}
.tgl.on{background:linear-gradient(135deg,#3ddbb0,#1fa98a)!important;color:#06281f!important;border-color:transparent!important}
.checks{list-style:none;padding:0;display:grid;gap:6px}
.checks li{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;padding:6px 8px;border-radius:10px;background:#0a0f2a88;border:1px solid #1f2a60}
.checks li b{width:16px;text-align:center;flex:none}
.checks li.ok b{color:#3ddbb0}.checks li.no b{color:#ff6b7a}
.checks li.ok{border-color:#3ddbb044}
.score{display:flex;align-items:center;justify-content:space-around;gap:10px;padding:6px 0}
.score div{text-align:center}
.score b{display:block;font-size:44px;font-weight:900;line-height:1;text-shadow:0 0 22px currentColor}
.score span{color:#8fa0d6;font-size:12px}
.score .vs{font-size:30px;color:#3b4a88;text-shadow:none}
.wr{height:10px;border-radius:10px;background:#1f2a60;overflow:hidden;margin-top:12px}
.wr i{display:block;height:100%;width:0;background:linear-gradient(90deg,#ff6b7a,#f5c45e,#3ddbb0);transition:width .8s cubic-bezier(.2,.8,.2,1)}
.wrt{display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;font-size:11.5px;color:#8fa0d6;margin-top:4px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.st{background:#0a0f2a99;border:1px solid #1f2a60;border-radius:12px;padding:8px 10px}
.st span{color:#8fa0d6;font-size:11px;display:block}
.st b{display:block;font-size:17px}
.st small{font-size:11px;color:#8fa0d6}
.mem{display:grid;gap:8px;font-size:12px}
.mem .row{margin:0}
canvas{width:100%;height:420px;display:block;border-radius:12px;background:#0a0f29}
table{width:100%;border-collapse:collapse;font-size:12px}
th{color:#8fa0d6;font-weight:600;text-align:right;padding:6px 5px;position:sticky;top:0;background:#0f1638}
td{padding:6px 5px;border-top:1px solid #1f2a6088}
tbody tr{transition:background .2s}tbody tr:hover{background:#1a2456aa}
.wb{display:block;height:6px;border-radius:6px;background:linear-gradient(90deg,#7aa2ff,#3ddbb0)}
.w{color:#3ddbb0}.l{color:#ff6b7a}
.scroll{max-height:480px;overflow:auto}
.note{color:#8fa0d6;font-size:11.5px;line-height:1.8}
.warn{color:#f5c45e}
.btn-danger{color:#ff8a95;border-color:#ff6b7a55}
.modal{position:fixed;inset:0;display:none;place-items:center;background:#020510aa;z-index:2147483647;direction:rtl;font:13px/1.6 "Segoe UI",Tahoma,sans-serif;color:#e8ecff}
.modal.show{display:grid}
.mbox{width:min(460px,92vw);padding:18px;border-radius:20px;background:linear-gradient(160deg,#16204b,#0c1334);border:2px solid #4a5bb0;box-shadow:0 20px 60px #000c;animation:fin .25s ease both}
.mbox h2{font-size:17px;margin-bottom:10px}
.mok{background:linear-gradient(135deg,#3b4fd6,#1fa98a);border-color:transparent;font-weight:800}
.mok:disabled{opacity:.35;cursor:not-allowed}
.exbtns{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.ex{padding:14px 8px;font-size:16px;font-weight:900;border-radius:14px;letter-spacing:.3px}
.ex.call:not(:disabled){background:linear-gradient(135deg,#3ddbb0,#1fa98a);color:#06281f;border-color:transparent}
.ex.put:not(:disabled){background:linear-gradient(135deg,#ff6b7a,#d63a4b);color:#2a060b;border-color:transparent}
.ex:disabled{opacity:.35;cursor:not-allowed;transform:none;box-shadow:none}
.ex:not(:disabled){animation:pl 1.4s infinite}
.shine::after{content:"";position:absolute;inset:0;background:linear-gradient(110deg,transparent 30%,#ffffff12 50%,transparent 70%);transform:translateX(-100%);animation:shine 5s ease-in-out infinite;pointer-events:none}
@keyframes shine{0%,60%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
.flash{position:fixed;inset:0;display:none;place-items:center;pointer-events:none;z-index:2147483646}
.flash.show{display:grid}
.fbox{padding:26px 38px;border-radius:24px;text-align:center;background:#0b1230e6;border:2px solid;box-shadow:0 0 60px currentColor;animation:pop 2.2s ease forwards}
.fbox b{display:block;font-size:44px;font-weight:900;letter-spacing:1px}
.fbox span{font-size:14px;color:#c9d3ff}
.flash.call .fbox,.flash.win .fbox{color:#3ddbb0}
.flash.put .fbox,.flash.loss .fbox{color:#ff6b7a}
@keyframes pop{0%{opacity:0;transform:scale(.4) rotate(-6deg)}12%{opacity:1;transform:scale(1.08) rotate(0)}22%{transform:scale(1)}78%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(.96)}}
.tick{display:flex;gap:6px;overflow:hidden;white-space:nowrap;flex-wrap:wrap}
.tick span{padding:3px 10px;border-radius:8px;font-size:11.5px;animation:slide .6s ease both;border:1px solid #26336e}
@keyframes slide{from{transform:translateY(-8px);opacity:0}to{transform:none;opacity:1}}
.mini{position:fixed;z-index:2147483647;width:74px;height:74px;border-radius:20px;display:none;place-content:center;text-align:center;cursor:pointer;user-select:none;touch-action:none;background:linear-gradient(160deg,#1b2556,#0f1638);border:2px solid #26336e;color:#e8ecff;font:12px/1.3 "Segoe UI",Tahoma,sans-serif;box-shadow:0 8px 28px #0009;transition:border-color .4s,box-shadow .4s;animation:fin .4s ease both}
.mini.show{display:grid}
.mini b{font-size:24px;display:block}
.mini.u{border-color:#3ddbb0;box-shadow:0 0 22px #3ddbb055}
.mini.d{border-color:#ff6b7a;box-shadow:0 0 22px #ff6b7a55}
.mini .ad{position:absolute;top:6px;right:6px;width:9px;height:9px;border-radius:50%;background:#3ddbb0;display:none}
.mini.auto .ad{display:block;animation:pl 1.2s infinite}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;
const NAME = 'wsnf smart bot';
const letters = s => [...s].map((ch, i) => ch === ' ' ? '<span class="sp"></span>' : `<span class="ch" style="--i:${i}">${ch}</span>`).join('');
const HTML = `
<div class="splash" id="splash">
  <div class="sp-ring"></div><div class="sp-ring r2"></div>
  <div class="sp-logo">${letters(NAME)}</div>
  <div class="sp-sub">تحليل • تعلّم • محاكاة</div>
  <div class="sp-bar"><i></i></div>
</div>
<div class="full" id="full">
<header>
  <div class="brand">${letters(NAME)}<i class="dot"></i><small>v3.6 · محاكاة فقط</small></div>
  <nav class="nav" id="nav">
    <button data-p="home" class="on">الرئيسية</button>
    <button data-p="chart">الشارت</button>
    <button data-p="strat">الاستراتيجيات</button>
    <button data-p="lab">المختبر</button>
    <button data-p="log">السجل</button>
    <button data-p="rec">المسجّل</button>
    <button data-p="mem">الذاكرة</button>
    <button data-p="err">الأخطاء</button>
  </nav>
  <div class="chips" id="chips"></div>
  <button id="min">تصغير ▾</button>
</header>
<section class="page p-home on" data-page="home">
  <div style="display:grid;gap:14px;align-content:start">
    <div class="card hero shine" id="hero">
      <h3><span id="assetT">—</span></h3>
      <div class="gw">
        <svg viewBox="0 0 120 120"><circle class="gbg" cx="60" cy="60" r="52"/><circle class="gfg" id="arc" cx="60" cy="60" r="52"/></svg>
        <div class="gm"><div class="arrow" id="arrow">—</div><b id="conf">0</b><small style="display:block;font-size:10px;opacity:.75">قوة الإشارة (ليست احتمالًا)</small></div>
      </div>
      <div class="dirT" id="dirT">أحلّل السوق...</div>
      <div class="chip" id="badge">—</div>
      <div class="notes" id="notes"></div>
      <div class="cdb"><i id="cdb"></i></div>
      <div class="note" id="cdt"></div>
    </div>
    <div class="card" id="simCard">
      <h3>وضع المحاكاة (Paper Trading)</h3>
      <div class="note"><b class="w">🛡 محاكاة فقط:</b> البوت لا ينقر أي زر في المنصة ولا يرسل أي أمر ولا يقرأ المبلغ أو الرصيد. كل «صفقة» هنا افتراضية تُحسب نتيجتها من أسعار التيك، ولا علاقة لها بحسابك.</div>
      <div class="note" id="simSt"></div>
    </div>
    <div class="card">
      <h3>التحكم</h3>
      <div class="row">
        <button class="tgl" id="auto">الدخول الآلي الافتراضي: متوقف</button>
        <button class="tgl" id="gate">بوابة الإثبات: تعمل</button>
      </div>
      <div class="row"><button class="btn-danger" id="kill">⛔ إيقاف طارئ</button></div>
      <div class="row"><span>أقل قوة إشارة <b id="cv">65</b></span><input id="cs" type="range" min="50" max="90" value="65" style="flex:1"></div>
      <div class="row"><span>مدة الشمعة</span>
        <select id="tf"><option value="15">15 ثانية</option><option value="30">30 ثانية</option><option value="60" selected>دقيقة</option></select>
        <button id="lock">قفل الأصل</button>
      </div>
      <div class="row"><span>العائد % للأصل الحالي</span><input id="po" type="number" min="60" max="98" value="92" style="width:80px"><span class="note" id="beN"></span></div>
      <div class="note" id="ctlnote"></div>
    </div>
  </div>
  <div style="display:grid;gap:14px;align-content:start">
    <div class="card shine">
      <h3>نتائج الإشارات (افتراضية) <span id="sessNote" class="note"></span></h3>
      <div class="score">
        <div><b class="w" id="sw">0</b><span>ربح</span></div>
        <div class="vs">:</div>
        <div><b class="l" id="sl">0</b><span>خسارة</span></div>
      </div>
      <div class="wr"><i id="wr"></i></div>
      <div class="wrt"><span id="wrL">نسبة الربح: —</span><span id="lifeL">الإجمالي: —</span></div>
    </div>
    <div class="card">
      <h3>فحص الإشارة قبل الدخول</h3>
      <ul class="checks" id="checks"></ul>
      <div class="note" id="decNote"></div>
    </div>
    <div class="card">
      <h3>الإحصاءات</h3>
      <div class="stats" id="stats"></div>
    </div>
  </div>
</section>
<section class="page p-chart" data-page="chart">
  <div class="card">
    <h3><span>الشارت (آخر 90 شمعة من أصل 5000)</span></h3>
    <div class="tick" id="tick" style="margin-bottom:10px"></div>
    <canvas id="cv2"></canvas>
  </div>
</section>
<section class="page p-strat" data-page="strat">
  <div class="card">
    <h3>الاستراتيجيات الـ17 (تتعلم ذاتيًا)</h3>
    <div class="scroll">
      <table><thead><tr><th>الاسم</th><th>النوع</th><th>عينة</th><th>دقة</th><th>حد أدنى</th><th>وزن</th><th>الحالة</th></tr></thead><tbody id="strat"></tbody></table>
    </div>
  </div>
  <div class="card">
    <h3>دقة الإشارات حسب الثقة (حي فقط)</h3>
    <table><thead><tr><th>الفئة</th><th>عينة</th><th>دقة</th><th>الدخول الآلي</th></tr></thead><tbody id="bks"></tbody></table>
  </div>
</section>
<section class="page p-lab" data-page="lab" style="grid-template-columns:1fr">
  <div class="card">
    <h3>جودة البيانات والتدقيق</h3>
    <div class="stats" id="labQ"></div>
    <div class="note">تُقاس الفجوات الزمنية والشموع المسطحة والقفزات الشاذة وتأخر التيك. تحت حد الجودة لا تصدر توصية. التدقيق يتأكد أن كل تحليل بُني على شمعة مغلقة وأن قراءات الشمعة السابقة لا تتغير بعد إغلاقها. أثناء إعادة تشغيل التاريخ لا يُستخدم إلا ما تعلّمه البوت حتى تلك اللحظة.</div>
  </div>
  <div class="card">
    <h3>مقارنة مدد الانتهاء (على إشارات الأساس)</h3>
    <div class="scroll"><table><thead><tr><th>المدة</th><th>حي: عينة</th><th>دقة</th><th>حد أدنى</th><th>تاريخ: عينة</th><th>دقة</th><th></th></tr></thead><tbody id="labH"></tbody></table></div>
    <div class="note" id="labHn"></div>
    <div class="scroll"><table id="labRM"></table></div>
    <div class="note">المدد مضاعفات الشمعة. الدقة في المصفوفة تجمع الحي والتاريخ لكل حالة سوق (تظهر بعد 20 حالة).</div>
  </div>
  <div class="card">
    <h3>فلتر الإشارات الكاذبة: أداء الإشارات المحجوبة</h3>
    <div class="scroll"><table><thead><tr><th>الفحص</th><th>عدد المحجوبة</th><th>دقتها لو دخلنا</th><th>الحكم</th></tr></thead><tbody id="labV"></tbody></table></div>
    <div class="note">الفحص مفيد إذا كانت الإشارات التي يحجبها أقل دقة من نقطة التعادل. إن حجب إشارات رابحة فهو مرشح للإلغاء.</div>
  </div>
  <div class="card">
    <h3>أداء كل حالة سوق (لو دخلنا بلا فلتر الحالة)</h3>
    <div class="scroll"><table><thead><tr><th>الحالة</th><th>عدد الإشارات</th><th>الدقة</th><th>الحكم</th></tr></thead><tbody id="labCX"></tbody></table></div>
    <div class="note">قبل كل توصية يحدد البوت حالة السوق (اتجاه، نطاق، اختراق صالح/وهمي، انعكاس، انضغاط، فوضى). «انضغاط/فوضوي/غير واضح» ممنوع فيها الدخول، وبقية الحالات يُسمح فيها باتجاه واحد فقط. هذا الجدول يقيس هل الحالة المسموحة رابحة فعلًا.</div>
  </div>
  <div class="card">
    <h3>مقارنة الاستراتيجيات: الأصل × حالة السوق × مدة الصفقة</h3>
    <div class="scroll"><table id="labSC"></table></div>
    <div class="note" id="labSCn"></div>
    <div class="note">كل خلية دقة إشارة الاستراتيجية بعد N شمعات على هذا الأصل وفي حالة السوق الحالية. الاستراتيجية «المختارة» هي التي يتجاوز حدها الأدنى (Wilson) نقطة التعادل، وتُوزن في القرار حسب أدائها في هذه الحالة. «أنسب مدة» تظهر في شرائح التحليل للإشارة الحالية؛ مدة الصفقة الفعلية تبقى ما تضبطه أنت في المنصة.</div>
  </div>
  <div class="card">
    <h3>اختبار الاستراتيجيات المعدّلة قبل اعتمادها (✦)</h3>
    <div class="scroll"><table><thead><tr><th>الاستراتيجية</th><th>القديمة</th><th>المعدّلة</th><th>العينة</th><th>المستخدمة الآن</th><th>الحكم</th></tr></thead><tbody id="labVT"></tbody></table></div>
    <div class="note" id="labVL"></div>
    <div class="note">النسختان تعملان على نفس الشموع. لا تُعتمد المعدّلة إلا بعد ≥100 إشارة لكل منهما وتفوق ≥1% بدلالة z ≥ 1 ودون فقدان أكثر من ثلاثة أرباع التغطية، وتُسحب تلقائيًا إن ثبت أنها أسوأ. النتائج الحية تُفضَّل على التاريخية.</div>
  </div>
  <div class="card">
    <h3>عزل المؤشرات المتشابهة</h3>
    <div class="scroll"><table><thead><tr><th>العنقود (يُعدّ دليلًا مستقلًا واحدًا)</th><th>الحالة</th></tr></thead><tbody id="labCR"></tbody></table></div>
    <div class="note" id="labCRn"></div>
    <div class="note">داخل كل عنقود يُخفَّض وزن كل مؤشر حسب الارتباط المقاس بين إشاراتها (مؤشران متطابقان = دليل واحد). إن ثبت تطابق مجموعتين مختلفتين (متوسط ρ ≥ 0.6 عبر ≥3 أزواج، كل زوج ≥100 حالة) دُمجتا، فلا تُحسبان اتفاقًا مستقلًا.</div>
  </div>
  <div class="card">
    <h3>الامتناع عند غياب فرصة واضحة</h3>
    <div class="stats" id="labAb"></div>
    <div class="note">الامتناع مفيد إذا كانت دقة الحالات التي امتنع عنها أقل من دقة المُصدرة.</div>
  </div>
  <div class="card">
    <h3>مختبر التجارب (صفقات ظلّية لا تؤثر على القرار)</h3>
    <div class="scroll"><table><thead><tr><th>التجربة</th><th>حي: عينة</th><th>دقة</th><th>حد ويلسون</th><th>تاريخ: عينة</th><th>دقة</th><th>الحالة</th><th></th></tr></thead><tbody id="labX"></tbody></table></div>
    <div class="note">لا تُعتمد تجربة إلا بعد عينة حية كافية وحد أدنى فوق التعادل وتفوّق على الأساس بـ 2% على الأقل.</div>
    <div class="row"><button id="labReset">إرجاع القواعد للإعدادات الافتراضية</button></div>
  </div>
  <div class="card">
    <h3>الدفتر والنسخة الاحتياطية</h3>
    <div class="stats" id="labJ"></div>
    <div class="note">كل إشارة مرشحة ونتائجها بمدد مختلفة تُحفظ في المتصفح ونسخة ثانية في IndexedDB. إن مُسح التخزين المحلي تُستعاد الذاكرة تلقائيًا.</div>
  </div>
</section>
<section class="page p-log" data-page="log">
  <div class="card">
    <h3>سجل الإشارات والصفقات الافتراضية (محفوظ)</h3>
    <div class="scroll">
      <table><thead><tr><th>الوقت</th><th>الأصل</th><th>الاتجاه</th><th>القوة</th><th>النوع</th><th>النتيجة</th><th>السبب / سبب عدم الدخول</th></tr></thead><tbody id="log"></tbody></table>
    </div>
  </div>
</section>
<section class="page p-rec" data-page="rec" style="grid-template-columns:1fr">
  <div class="card">
    <h3>مسجّل الشموع (محلي — للمحاكاة والتحليل فقط)</h3>
    <div class="stats" id="recSt"></div>
    <div class="row">
      <button class="tgl" id="recOn">التسجيل: يعمل</button>
      <button id="recExpJ">تصدير الكل JSONL</button>
      <button id="recExpC">تصدير الكل CSV</button>
      <button id="recExpCur">تصدير الأصل الحالي JSONL</button>
      <button id="recImp">استيراد (JSONL/CSV)</button>
      <input type="file" id="recImpFile" accept=".jsonl,.json,.csv,text/plain" style="display:none">
      <button id="recScan">فحص الفجوات المخزّنة</button>
    </div>
    <div class="note" id="recMsg"></div>
    <div class="note">تُحفظ كل شمعة مكتملة بعد انتهائها فقط في قاعدة IndexedDB منفصلة داخل متصفحك. لا يُرسل شيء خارج المتصفح. الشموع الناقصة تُرفض ولا تُخزَّن، والمكررة لا تُكرَّر (التسجيل الحي يستبدل التاريخي للشمعة نفسها). مصدر الأسعار تيكات المنصة: دقة القمة/القاع محدودة بمعدل التيكات (عددها محفوظ مع كل شمعة).</div>
  </div>
  <div class="card">
    <h3>السلاسل المحفوظة (أصل × إطار)</h3>
    <div class="scroll"><table><thead><tr><th>الأصل</th><th>الإطار</th><th>الشموع</th><th>من (UTC)</th><th>إلى (UTC)</th><th>فجوات</th><th>شموع مفقودة</th></tr></thead><tbody id="recSer"></tbody></table></div>
  </div>
  <div class="card">
    <h3>أسباب رفض الشموع (هذه الجلسة)</h3>
    <div class="scroll"><table><thead><tr><th>السبب</th><th>العدد</th></tr></thead><tbody id="recRej"></tbody></table></div>
  </div>
  <div class="card">
    <h3>أحداث التسجيل (الفجوات، الانقطاع، التاريخ...)</h3>
    <div class="scroll"><table><thead><tr><th>الوقت</th><th>الحدث</th><th>التفاصيل</th></tr></thead><tbody id="recEv"></tbody></table></div>
    <div class="row"><button class="btn-danger" id="recClr">مسح كل الشموع المسجّلة</button></div>
  </div>
</section>
<section class="page p-mem" data-page="mem" style="grid-template-columns:1fr">
  <div class="card">
    <h3>ذاكرة البوت</h3>
    <div class="mem">
      <div class="st"><span>آخر حفظ</span><b id="memAt" style="font-size:14px">—</b></div>
      <div class="st"><span>أفضل فئة ثقة تعلّمها</span><b id="memBest" style="font-size:14px">—</b></div>
      <div class="st"><span>الصفقات المحفوظة في السجل</span><b id="memLog">0</b></div>
      <div class="row">
        <button id="exp">تصدير نسخة احتياطية</button>
        <button id="imp">استيراد نسخة</button>
        <input type="file" id="impFile" accept="application/json" style="display:none">
      </div>
      <div class="row"><button class="btn-danger" id="reset">مسح كل التعلّم</button></div>
      <div class="note">الذاكرة وإعدادات الحماية والإحصاءات تُحفظ تلقائيًا داخل المتصفح. إن مسحت بيانات الموقع ستضيع، لذلك صدّر نسخة احتياطية من وقت لآخر.</div>
    </div>
  </div>
</section>
<section class="page p-err" data-page="err" style="grid-template-columns:1fr">
  <div class="card">
    <h3>سجل الأخطاء والأحداث</h3>
    <div class="row"><button id="expDiag">تصدير التشخيص</button><button id="clrErr">مسح السجل</button></div>
    <div class="scroll"><table><thead><tr><th>الوقت</th><th>الرمز</th><th>الوصف</th></tr></thead><tbody id="errs"></tbody></table></div>
  </div>
  <div class="card">
    <h3>تتبع أحداث المحاكاة (آخر 40)</h3>
    <div class="scroll"><table><thead><tr><th>الوقت</th><th>النوع</th><th>الحدث</th></tr></thead><tbody id="trc"></tbody></table></div>
    <div class="note">أحداث الأوامر الافتراضية فقط. لا تُرسل أي أوامر إلى المنصة.</div>
  </div>
</section>
</div>
<div class="flash" id="flash"><div class="fbox" id="fbox"><b id="fA">—</b><span id="fS"></span></div></div>
<div class="mini" id="mini"><span class="ad"></span><div><b id="mA">—</b><span id="mT">انتظار</span></div></div>`;


// app: الواجهة لا تعرف المحرك إلا عبر هذا الكائن:
//   app.vm   { view(shown), lab(), recorder(), chart(), settings() }  — قراءة فقط (نسخ)
//   app.cmd  أوامر المحرك (القناة الوحيدة للكتابة)                   — engine/commands.js
//   app.rec  { setOn, exportFile, importFile, scanGaps, clear }       — أوامر المسجّل
//   app.on(type, fn)  أحداث المحرك ('signal'، 'result')
//   app.readShown()   اسم الأصل المعروض في صفحة المنصة (طبقة المنصة)
//   app.downloadText(name, text, mime) · app.diagnostics() · app.prefs { get(k, d), set(k, v) } تفضيلات العرض فقط
//   app.win / app.doc النافذة والمستند
function buildUI(app) {
  const doc = app.doc, win = app.win;
  if (doc.getElementById('wsnf25-host')) return null;
  const host = doc.createElement('div');
  host.id = 'wsnf25-host';
  doc.documentElement.appendChild(host);
  const sh = host.attachShadow({ mode: 'open' });
  sh.innerHTML = '<style>' + CSS + '</style>' + HTML;
  const $ = id => sh.getElementById(id);
  const ui = app.prefs.get(UI_KEY, { min: false, x: 12, y: 90 });
  const full = $('full'), mini = $('mini'), flash = $('flash'), fbox = $('fbox'), splash = $('splash');
  const st0 = app.vm.settings();
  $('cs').value = st0.minConf; $('po').value = Math.round(st0.payout * 100); $('tf').value = String(st0.tf);

  win.setTimeout(() => splash.classList.add('out'), 3000);
  win.setTimeout(() => { splash.style.display = 'none'; }, 3900);

  const setMin = m => {
    ui.min = m; app.prefs.set(UI_KEY, ui);
    full.classList.toggle('hide', m);
    mini.classList.toggle('show', m);
  };
  mini.style.left = ui.x + 'px';
  mini.style.top = ui.y + 'px';
  $('min').onclick = () => setMin(true);
  let drag = null;
  mini.onpointerdown = e => { drag = { sx: e.clientX, sy: e.clientY, x: mini.offsetLeft, y: mini.offsetTop, mv: false }; mini.setPointerCapture(e.pointerId); };
  mini.onpointermove = e => {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 5) drag.mv = true;
    if (drag.mv) { mini.style.left = Math.max(0, drag.x + dx) + 'px'; mini.style.top = Math.max(0, drag.y + dy) + 'px'; }
  };
  mini.onpointerup = () => {
    if (drag && !drag.mv) setMin(false);
    else if (drag) { ui.x = mini.offsetLeft; ui.y = mini.offsetTop; app.prefs.set(UI_KEY, ui); }
    drag = null;
  };

  const cv = $('cv2');
  $('nav').onclick = e => {
    const b = e.target.closest('button[data-p]');
    if (!b) return;
    sh.querySelectorAll('#nav button').forEach(x => x.classList.toggle('on', x === b));
    sh.querySelectorAll('.page').forEach(p => p.classList.toggle('on', p.dataset.page === b.dataset.p));
    if (b.dataset.p === 'chart') drawChart(cv, app.vm.chart());
  };

  const cmd = app.cmd;
  $('auto').onclick = () => { cmd.toggleAuto(); paint(); };
  $('kill').onclick = () => { cmd.kill(); paint(); };
  $('clrErr').onclick = () => { cmd.clearErrors(); };
  $('expDiag').onclick = () => app.downloadText('wsnf-diag-' + Date.now() + '.json', JSON.stringify(app.diagnostics(), null, 1), 'application/json');
  $('gate').onclick = () => { cmd.toggleGate(); };
  $('labX').onclick = e => { const b = e.target.closest('button[data-adopt]'); if (b) cmd.adopt(b.dataset.adopt); };
  $('labReset').onclick = () => { cmd.resetRules(); };
  $('cs').oninput = e => { $('cv').textContent = cmd.setMinConf(+e.target.value); };
  $('po').onchange = e => { $('po').value = cmd.setPayoutPct(+e.target.value); };
  $('tf').onchange = e => { if (!cmd.setTf(+e.target.value)) $('tf').value = String(app.vm.settings().tf); };
  $('lock').onclick = e => { e.target.textContent = cmd.toggleLock(app.readShown()) ? 'فك القفل' : 'قفل الأصل'; };

  $('exp').onclick = () => app.downloadText('wsnf-memory-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(cmd.exportMemory()), 'application/json');
  // ---- المسجّل ----
  const recMsg = (t, cls) => { $('recMsg').innerHTML = '<span class="' + (cls || '') + '">' + ESC(t) + '</span>'; };
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const recDl = (fmt, a) => {
    recMsg('جارٍ التصدير...');
    const tf = app.vm.settings().tf;
    app.rec.exportFile(fmt, a || null, a ? tf : null).then(x => {
      if (!x.count) { recMsg('لا توجد شموع للتصدير', 'warn'); return; }
      app.downloadText('wsnf-candles-' + (a ? a + '-' + tf + 's-' : '') + stamp() + '.' + (fmt === 'csv' ? 'csv' : 'jsonl'), x.text, fmt === 'csv' ? 'text/csv' : 'application/x-ndjson');
      recMsg('صُدّرت ' + x.count + ' شمعة (' + x.series.length + ' سلسلة)', 'w');
    }).catch(e => recMsg('فشل التصدير: ' + (e && e.message || e), 'l'));
  };
  $('recOn').onclick = () => { app.rec.setOn(!app.vm.recorder().on); paint(); };
  $('recExpJ').onclick = () => recDl('jsonl');
  $('recExpC').onclick = () => recDl('csv');
  $('recExpCur').onclick = () => { const cur = app.vm.settings().cur; if (!cur) recMsg('لا يوجد أصل حالي', 'warn'); else recDl('jsonl', cur); };
  $('recImp').onclick = () => $('recImpFile').click();
  $('recImpFile').onchange = e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const rd = new win.FileReader();
    rd.onload = () => {
      recMsg('جارٍ الاستيراد...');
      app.rec.importFile(String(rd.result)).then(o => {
        const rs = Object.entries(o.reasons).map(([k, v]) => k + ' ×' + v).join('، ');
        recMsg('قُرئ ' + o.read + ' · أُضيف ' + o.added + ' · استُبدل ' + o.replaced + ' · مكرر ' + o.dup + ' · متعارض (أُبقي الموجود) ' + o.conflicts + ' · مرفوض ' + o.rejected + (rs ? ' (' + rs + ')' : ''), o.rejected ? 'warn' : 'w');
      }).catch(err => recMsg('رُفض الملف: ' + (err && err.message || err), 'l'));
    };
    rd.readAsText(f);
    e.target.value = '';
  };
  $('recScan').onclick = () => { recMsg('جارٍ الفحص...'); app.rec.scanGaps().then(o => recMsg('اكتمل فحص ' + o.length + ' سلسلة', 'w')).catch(e => recMsg('فشل الفحص: ' + (e && e.message || e), 'l')); };
  $('recClr').onclick = () => {
    if (!win.confirm('سيُحذف كل ما سجّله المسجّل من شموع وأحداث نهائيًا. صدّر نسخة أولًا إن احتجتها. متابعة؟')) return;
    app.rec.clear().then(() => recMsg('مُسحت الشموع المسجّلة', 'warn'));
  };
  $('imp').onclick = () => $('impFile').click();
  $('impFile').onchange = e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const rd = new win.FileReader();
    rd.onload = () => {
      try { cmd.importMemory(String(rd.result)); win.alert('تم استيراد الذاكرة بنجاح'); }
      catch (err) { win.alert('فشل الاستيراد: ' + err.message); }
    };
    rd.readAsText(f);
    e.target.value = '';
  };
  $('reset').onclick = () => {
    if (!win.confirm('سيتم مسح كل ما تعلّمه البوت نهائيًا. متابعة؟')) return;
    cmd.resetLearning();
  };

  const showFlash = (cls, main, sub) => {
    flash.className = 'flash show ' + cls;
    fbox.style.animation = 'none'; void fbox.offsetWidth; fbox.style.animation = '';
    $('fA').textContent = main; $('fS').textContent = sub;
    win.clearTimeout(showFlash.t);
    showFlash.t = win.setTimeout(() => { flash.className = 'flash'; }, 2300);
  };
  // الواجهة تستمع لأحداث المحرك ولا تُدخل نفسها في مساره
  app.on('signal', e => {
    const buy = e.dir === 'call';
    showFlash(buy ? 'call' : 'put', buy ? '▲ إشارة صعود' : '▼ إشارة هبوط', (e.try ? 'صفقة افتراضية (محاكاة)' : 'إشارة فقط — لا صفقة') + ' · قوة ' + e.conf);
    const tk = $('tick');
    tk.insertAdjacentHTML('afterbegin', `<span style="color:${buy ? '#3ddbb0' : '#ff6b7a'}">${buy ? '▲' : '▼'} ${e.conf}</span>`);
    while (tk.children.length > 10) tk.lastElementChild.remove();
  });
  app.on('result', win2 => showFlash(win2 ? 'win' : 'loss', win2 ? '✔ ربح افتراضي' : '✖ خسارة افتراضية', 'نتيجة محاكاة — ليست صفقة حقيقية'));

  let lastLab = '';
  function paintRec() {
    const R = app.vm.recorder(), ss = R.sess, ser = R.series, tot = ser.reduce((a, s) => a + s.count, 0);
    $('recOn').textContent = 'التسجيل: ' + (R.on ? 'يعمل' : 'متوقف');
    $('recOn').classList.toggle('on', R.on);
    $('recSt').innerHTML =
      `<div class="st"><span>الحالة</span><b class="${R.on && R.ready && !R.err ? 'w' : 'l'}">${!R.on ? 'متوقف' : !R.ready ? 'يُهيّأ...' : R.err ? 'تحذير' : 'يسجّل'}</b><small>${ESC(R.err || (R.kind === 'indexeddb' ? 'IndexedDB (دائم)' : R.kind))}</small></div>` +
      `<div class="st"><span>الشموع المحفوظة</span><b>${tot}</b><small>${ser.length} سلسلة · ≈ ${(tot * R.bytesPer / 1048576).toFixed(1)} MB (تقدير)</small></div>` +
      `<div class="st"><span>آخر حفظ</span><b>${ss.lastFlush ? new Date(ss.lastFlush).toTimeString().slice(0, 8) : '-'}</b><small>بانتظار الحفظ: ${R.queue}${ss.flushErr ? ' · خطأ: ' + ESC(ss.flushErr) : ''}</small></div>` +
      `<div class="st"><span>هذه الجلسة</span><b>${ss.added}</b><small>جديدة · استُبدلت ${ss.replaced} · مكررة ${ss.dup} · متعارضة ${ss.conflicts}${ss.conflicts ? ' (أقصى فرق ' + (ss.maxDiff * 100).toFixed(4) + '%)' : ''}</small></div>` +
      `<div class="st"><span>مرفوضة (ناقصة/غير صالحة)</span><b class="${ss.rejected ? 'warn' : ''}">${ss.rejected}</b></div>` +
      `<div class="st"><span>فجوات مكتشفة حيًا</span><b class="${ss.gaps ? 'warn' : ''}">${ss.gaps}</b>${ss.dropped ? '<small class="l">سجلات أُسقطت: ' + ss.dropped + '</small>' : ''}</div>`;
    const sc = R.scan ? Object.fromEntries(R.scan.out.map(x => [x.a + '|' + x.tf, x])) : {};
    $('recSer').innerHTML = ser.sort((x, y) => x.a < y.a ? -1 : x.a > y.a ? 1 : x.tf - y.tf).map(s => {
      const g = sc[s.a + '|' + s.tf];
      return `<tr><td>${ESC(s.a)}</td><td>${s.tf} ث</td><td>${s.count}${s.capped ? ' <span class="chip c-d">الحد</span>' : ''}</td><td>${utc(s.first)}</td><td>${utc(s.last)}</td><td>${g ? g.gaps : '?'}</td><td>${g ? g.missing : '?'}</td></tr>`;
    }).join('') || '<tr><td colspan="7" class="note">لا شموع محفوظة بعد</td></tr>';
    $('recRej').innerHTML = Object.entries(ss.reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${ESC(k)}</td><td>${v}</td></tr>`).join('') || '<tr><td colspan="2" class="note">لا شيء</td></tr>';
    $('recEv').innerHTML = R.events.map(e => {
      const d = e.type === 'gap' ? e.a + ' ' + e.tf + 'ث: ' + utc(e.from) + ' → ' + utc(e.to) + ' (' + e.n + ' شمعة)'
        : e.type === 'reject' ? e.a + ' ' + utc(e.t) + ': ' + e.why
        : e.type === 'hist' ? e.a + ': ' + e.ticks + ' تيك'
        : e.type === 'stale' ? e.a + ': ' + e.age + ' ث بلا سعر'
        : e.type === 'tf' ? e.from + ' → ' + e.to + ' ث'
        : e.type === 'import' ? e.fmt + ': أُضيف ' + e.added + ' من ' + e.read + ' (مرفوض ' + e.rejected + ')'
        : e.type === 'cap' ? e.a + ' ' + e.tf + 'ث: ' + e.n : e.store || '';
      return `<tr><td>${new Date(e.at).toTimeString().slice(0, 8)}</td><td>${EV_LABEL[e.type] || ESC(e.type)}</td><td class="note">${ESC(d)}</td></tr>`;
    }).join('') || '<tr><td colspan="3" class="note">لا أحداث بعد</td></tr>';
  }
  function paint() {
    const V = app.vm.view(app.readShown()), R = app.vm.recorder(), r = V.r, d = r ? r.d : 'none', st = V.st, C = V.cfg;
    const col = d === 'call' ? '#3ddbb0' : d === 'put' ? '#ff6b7a' : '#f5c45e';
    $('assetT').textContent = V.asset
      ? V.asset + ' | ' + V.n + ' شمعة' + (V.price ? ' | ' + V.price : '')
      : 'لا بيانات بعد: حدّث الصفحة (F5) وانتظر';
    $('hero').className = 'card hero shine ' + (d === 'call' ? 'u' : d === 'put' ? 'd' : '');
    $('arc').style.strokeDashoffset = 326.7 * (1 - (r && d !== 'none' ? r.conf / 100 : .12));
    $('arc').style.stroke = col;
    $('arrow').textContent = d === 'call' ? '▲' : d === 'put' ? '▼' : '—';
    $('arrow').style.color = col;
    $('conf').textContent = (r && d !== 'none' ? r.conf : 0);
    $('dirT').textContent = !r ? 'أحلّل السوق...' : d === 'call' ? 'إشارة شراء' : d === 'put' ? 'إشارة بيع' : 'لا توجد فرصة واضحة الآن' + (r.abst && r.abst.length ? ' — ' + r.abst[0] : '');
    $('dirT').style.color = col;
    $('badge').textContent = V.g.ok ? '✔ ' + V.g.why : d === 'none' ? (r ? r.regime + ' | امتناع' : '—') : '⏳ ' + V.g.why;
    $('badge').className = 'chip ' + (V.g.ok ? 'c-u' : 'c-g');
    $('notes').innerHTML = r && r.notes ? r.notes.slice(0, 8).map(n => '<span class="chip">' + ESC(n) + '</span>').join('') : '';
    $('cdb').style.width = V.cd === null ? '0' : (100 - V.cd / C.tf * 100) + '%';
    $('cdt').textContent = V.cd === null ? '' : 'تُغلق الشمعة بعد ' + Math.ceil(V.cd) + ' ث';
    $('chips').innerHTML =
      '<span class="chip c-u">🛡 محاكاة فقط</span>' +
      (R.on ? `<span class="chip ${R.err || R.sess.flushErr ? 'c-d' : 'c-m'}">⏺ تسجيل ${R.series.reduce((a, s) => a + s.count, 0)}</span>` : '<span class="chip c-g">التسجيل متوقف</span>') +
      (C.auto ? '<span class="chip c-g">صفقات افتراضية تلقائية</span>' : '<span class="chip c-m">إشارات فقط</span>') +
      `<span class="chip ${V.asset ? 'c-u' : 'c-d'}">${V.asset ? '✓ بيانات حية' : 'لا بيانات'}</span>` +
      (V.loaded ? `<span class="chip c-m">تاريخ: ${V.loaded}</span>` : '') +
      (V.asset && V.dq ? `<span class="chip ${V.dq.q >= C.minQ ? 'c-m' : 'c-d'}">جودة البيانات ${V.dq.q}%</span>` : '') +
      (st.halted ? '<span class="chip c-d">توقف: ' + ESC(st.haltWhy || 'حد الخسارة') + '</span>' : '') +
      (st.unkRow ? '<span class="chip c-g">صفقة بلا نتيجة ×' + st.unkRow + '</span>' : '') +
      (V.paused ? '<span class="chip c-g">استراحة بعد خسائر</span>' : '') +
      (V.cooling && !V.paused ? '<span class="chip c-g">تهدئة</span>' : '') +
      (st.wsUp === false ? '<span class="chip c-d">انقطاع الاتصال</span>' : '') +
      (st.pending ? '<span class="chip c-g">بانتظار تأكيد المحاكاة</span>' : '') +
      (st.open ? '<span class="chip c-m">صفقة افتراضية مفتوحة</span>' : '') +
      (V.stale ? '<span class="chip c-d">بيانات قديمة: التحليل متوقف</span>' : '') +
      (st.storeErr ? '<span class="chip c-d">تعذّر الحفظ في المتصفح</span>' : '');
    $('auto').textContent = C.auto ? 'الدخول الآلي الافتراضي: يعمل' : 'الدخول الآلي الافتراضي: متوقف';
    $('auto').classList.toggle('on', C.auto);
    if (sh.activeElement !== $('po')) $('po').value = Math.round(V.payout * 100);
    $('beN').textContent = 'نقطة التعادل ' + pc(V.be, 1);
    $('simSt').innerHTML = 'صافي المحاكاة: <b class="' + (st.net >= 0 ? 'w' : 'l') + '">' + (st.net >= 0 ? '+' : '') + st.net.toFixed(2) + '</b> وحدة (مبلغ 1 لكل صفقة) · صفقات افتراضية: ' + V.sim.w + ' ربح / ' + V.sim.l + ' خسارة / ' + V.sim.tie + ' تعادل · ملغاة/فاشلة: ' + V.sim.bad +
      (st.open ? ' · <span class="warn">صفقة مفتوحة ' + ESC(st.open.asset) + '</span>' : '');
    $('gate').textContent = C.gate ? 'بوابة الإثبات: تعمل' : 'بوابة الإثبات: متجاوَزة';
    $('gate').classList.toggle('on', C.gate);
    $('cv').textContent = C.minConf;
    $('ctlnote').innerHTML =
      '«الدخول الآلي الافتراضي» يفتح صفقات محاكاة فقط ويبدأ متوقفًا بعد كل إعادة تحميل. «القوة» درجة اتفاق المؤشرات وليست احتمال نجاح؛ نسبة النجاح المقاسة تظهر في الإحصاءات مع حجم العينة.<br>' +
      (C.gate
        ? 'البوابة: لا صفقة افتراضية إلا إذا أثبتت فئة القوة نجاحًا فوق التعادل على ' + C.minLive + ' إشارة حية (z=' + C.gateZ + ') ونجحت أيضًا في آخر ' + C.recentN + ' إشارة.'
        : '<span class="warn">البوابة متجاوَزة: كل إشارة فوق حد القوة تفتح صفقة افتراضية.</span>');
    $('decNote').innerHTML = st.decision
      ? 'قرار آخر (' + new Date(st.decision.t).toTimeString().slice(0, 8) + '): ' + (st.decision.entered ? 'فُتحت صفقة افتراضية' : 'لم تُفتح صفقة افتراضية' + (st.decision.why.length ? ': ' + ESC(st.decision.why.join(' | ')) : ''))
      : 'لا قرارات بعد';
    $('errs').innerHTML = st.errors.map(e => `<tr><td>${new Date(e.t).toTimeString().slice(0, 8)}</td><td>${ESC(e.code)}</td><td>${ESC(e.msg)}</td></tr>`).join('') || '<tr><td colspan="3" class="note">لا أخطاء</td></tr>';
    $('trc').innerHTML = st.trace.map(x => `<tr><td>${new Date(x.t).toTimeString().slice(0, 8)}</td><td>${ESC(x.dir)}</td><td style="direction:ltr;text-align:left">${ESC(x.raw)}</td></tr>`).join('') || '<tr><td colspan="3" class="note">لا أحداث بعد</td></tr>';
    $('checks').innerHTML = V.checks.map(c => `<li class="${c.ok ? 'ok' : 'no'}"><b>${c.ok ? '✔' : '✖'}</b><span>${ESC(c.t)}</span></li>`).join('');
    const tot = V.sessW + V.sessL;
    $('sw').textContent = V.sessW;
    $('sl').textContent = V.sessL;
    $('sessNote').textContent = tot ? '(في السجل الحالي: ' + tot + ' — إشارات وصفقات افتراضية)' : '';
    $('wr').style.width = (tot ? V.sessW / tot * 100 : 0) + '%';
    $('wrL').textContent = 'نسبة النجاح: ' + (tot ? pc(V.sessW / tot, 1) + ' من ' + tot + (tot < 100 ? ' (عينة صغيرة)' : '') : '—');
    const lt = V.lifeW + V.lifeL;
    $('lifeL').textContent = 'كل الإشارات الحية: ' + V.lifeW + ' / ' + V.lifeL + (lt ? ' (' + pc(V.lifeW / lt, 1) + ')' : '');
    const n = V.liveN, w = V.liveW, po = V.payout, lo95 = V.lo95, hi95 = V.hi95, p = n ? w / n : 0;
    const ev = x => x * po - (1 - x);
    const evS = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%';
    $('stats').innerHTML =
      `<div class="st"><span>إشارات حية (هذا الأصل)</span><b>${n}</b><small>${n < 30 ? 'عينة غير كافية لأي استنتاج' : n < 300 ? 'عينة صغيرة' : 'عينة مقبولة'}</small></div>` +
      `<div class="st"><span>نسبة النجاح الحية</span><b>${n ? pc(p, 1) : '-'}</b><small>${n ? 'فاصل 95%: ' + pc(lo95, 1) + ' – ' + pc(hi95, 1) : ''}</small></div>` +
      `<div class="st"><span>نقطة التعادل</span><b>${pc(V.be, 1)}</b><small>عائد ${Math.round(po * 100)}%</small></div>` +
      (n >= 30
        ? `<div class="st"><span>التوقع الرياضي / صفقة</span><b class="${lo95 > V.be ? 'w' : hi95 < V.be ? 'l' : ''}">${evS(ev(p))}</b><small>المدى 95%: ${evS(ev(lo95))} إلى ${evS(ev(hi95))}${lo95 <= V.be && hi95 >= V.be ? ' — غير مثبت' : ''}</small></div>`
        : `<div class="st"><span>التوقع الرياضي / صفقة</span><b>—</b><small>لا يُحسب قبل 30 إشارة حية (${n}/30)</small></div>`) +
      `<div class="st"><span>إعادة تشغيل التاريخ (تدريب)</span><b>${V.histN ? pc(V.histW / V.histN, 1) : '-'}</b><small>${V.histN} إشارة — داخل العينة، ليست دليلًا</small></div>` +
      `<div class="st"><span>صافي المحاكاة</span><b class="${st.net >= 0 ? 'w' : 'l'}">${st.net >= 0 ? '+' : ''}${st.net.toFixed(2)}</b><small>وحدة افتراضية</small></div>` +
      `<div class="st"><span>صفقات افتراضية هذه الساعة</span><b>${st.hourly}/${C.maxPerHour}</b></div>` +
      `<div class="st"><span>صفقات افتراضية</span><b>${V.sim.w}/${V.sim.l}</b><small>ربح/خسارة · ملغاة/فاشلة ${V.sim.bad}</small></div>`;
    $('strat').innerHTML = V.strat.map(s =>
      `<tr><td>${s.name}${s.improved ? ' <small class="note">✦ معدّلة</small>' : ''}</td><td>${s.kind === 'T' ? 'اتجاه' : s.kind === 'R' ? 'ارتداد' : 'نمط'}</td><td>${s.n}</td><td>${s.n ? pc(s.p, 1) : '-'}</td><td>${s.n ? pc(s.lb, 0) : '-'}</td><td><i class="wb" style="width:${Math.min(100, s.w * 80)}%"></i></td><td><span class="chip c-${s.cls}">${s.mode}</span><small class="note"> ${s.src}${s.rg ? ' · ' + s.rg : ''}${s.rp !== undefined ? ' · آخر' + C.driftN + ': ' + pc(s.rp, 0) : ''}</small></td></tr>`).join('');
    $('bks').innerHTML = V.bks.map(b =>
      `<tr><td>${b.k}+</td><td>${b.n}</td><td>${b.n ? pc(b.acc, 1) : '-'}</td><td><span class="chip c-${b.ok ? 'u' : 'm'}">${b.ok ? 'مسموحة' : b.n < C.minLive ? 'عينة ' + b.n + '/' + C.minLive : 'غير مثبتة'}</span></td></tr>`).join('') || '<tr><td colspan="4" class="note">لم تتجمع بيانات بعد</td></tr>';
    $('log').innerHTML = V.log.map(e => {
      const tm = new Date(e.t).toTimeString().slice(0, 8);
      const why = (e.why || []).join(' · ') + (e.skip && e.skip.length ? ' — لم تُفتح: ' + e.skip.join(' | ') : '') + (e.reason ? ' — ' + e.reason : '');
      return `<tr><td>${tm}</td><td>${ESC(e.asset)}</td><td>${e.dir === 'call' ? '▲ صعود' : '▼ هبوط'}</td><td>${e.conf}</td><td>${kindLabel(e)}</td><td class="${e.win === null ? '' : e.win ? 'w' : 'l'}">${resLabel(e)}</td><td class="note">${ESC(why)}</td></tr>`;
    }).join('') || '<tr><td colspan="7" class="note">لا إشارات بعد</td></tr>';
    $('memAt').textContent = V.savedAt ? new Date(V.savedAt).toLocaleString('ar-SA') : 'لم يُحفظ بعد';
    $('memBest').textContent = V.best ? V.best.k + '+ بدقة ' + pc(V.best.acc, 1) + ' من ' + V.best.n : 'تحتاج عينة أكبر';
    $('memLog').textContent = V.logCount;
    if (sh.querySelector('.p-rec.on')) paintRec();
    if (sh.querySelector('.p-lab.on')) {
      const H = labHtml(app.vm.lab()), key = Object.values(H).join('\u0001');
      if (key !== lastLab) {
        lastLab = key;
        $('labQ').innerHTML = H.q; $('labH').innerHTML = H.h; $('labHn').textContent = H.hn; $('labRM').innerHTML = H.rm;
        $('labV').innerHTML = H.v; $('labCX').innerHTML = H.cx; $('labSC').innerHTML = H.scT; $('labSCn').textContent = H.scn; $('labVT').innerHTML = H.vt; $('labVL').textContent = H.vl ? 'آخر التبديلات: ' + H.vl : ''; $('labCR').innerHTML = H.cr; $('labCRn').textContent = H.crn ? 'أزواج شديدة التطابق: ' + H.crn : ''; $('labAb').innerHTML = H.ab; $('labX').innerHTML = H.x; $('labJ').innerHTML = H.j;
      }
    }
    mini.className = 'mini' + (ui.min ? ' show' : '') + (d === 'call' ? ' u' : d === 'put' ? ' d' : '') + (C.auto ? ' auto' : '');
    $('mA').textContent = d === 'call' ? '▲' : d === 'put' ? '▼' : '—';
    $('mA').style.color = col;
    $('mT').textContent = r && d !== 'none' ? 'قوة ' + r.conf : 'انتظار';
  }
  const t1 = win.setInterval(() => { try { paint(); } catch (e) { try { win.console.warn('wsnf paint', e); } catch (_) {} } }, 1000);
  const t2 = win.setInterval(() => {
    if (ui.min || !sh.querySelector('.p-chart.on')) return;
    try { drawChart(cv, app.vm.chart()); } catch (e) {}
  }, 400);
  setMin(ui.min);
  paint();
  return { paint, host, stop() { win.clearInterval(t1); win.clearInterval(t2); } };
}

// صفحة المختبر: تحويل بيانات نموذج العرض إلى HTML (لا حساب هنا)
function labHtml(L) {
  const dq = L.dq, au = L.audit;
  const q = `<div class="st"><span>جودة بيانات الأصل الحالي</span><b class="${dq && dq.q >= L.minQ ? 'w' : 'l'}">${dq ? dq.q + '%' : '-'}</b><small>${dq && dq.issues.length ? ESC(dq.issues.join(' | ')) : 'لا مشاكل'}</small></div>` +
    `<div class="st"><span>تدقيق عدم استخدام المستقبل</span><b class="${au.bad ? 'l' : 'w'}">${au.n - au.bad}/${au.n}</b><small>${au.bad ? ESC(au.last) : 'كل تحليل بُني على شمعة مغلقة'}</small></div>` +
    `<div class="st"><span>اختبار ثبات القراءات</span><b class="${au.testBad ? 'l' : 'w'}">${au.tests - au.testBad}/${au.tests}</b><small>إعادة حساب قراءة الشمعة السابقة</small></div>`;
  const h = L.hz.map(x => `<tr><td>${x.label}</td><td>${x.z.ln}</td><td>${cellAcc(x.z.ln, x.z.lw)}</td><td>${x.lbPct !== null ? x.lbPct + '%' : '-'}</td><td>${x.z.hn}</td><td>${cellAcc(x.z.hn, x.z.hw)}</td><td>${x.best ? '<span class="chip c-u">الأفضل' + (L.bestLive ? '' : ' (تمهيدي)') + '</span>' : ''}</td></tr>`).join('');
  const rm = '<thead><tr><th>الحالة \\ المدة</th>' + L.rm.cols.map(x => '<th>' + x + '</th>').join('') + '</tr></thead><tbody>' +
    L.rm.rows.map(r => '<tr><td>' + r.g + '</td>' + r.cells.map(c => '<td>' + (c.n >= 20 ? cellAcc(c.n, c.w) + ' <small class="note">(' + c.n + ')</small>' : '-') + '</td>').join('') + '</tr>').join('') + '</tbody>';
  const v = L.vetos.map(x => `<tr><td>${x.name}</td><td>${x.n}</td><td>${cellAcc(x.n, x.w)}</td><td><span class="chip ${x.useful ? 'c-u' : x.harmful ? 'c-d' : 'c-m'}">${x.useful ? 'يحجب خاسرة' : x.harmful ? 'يحجب رابحة' : 'عينة صغيرة'}</span></td></tr>`).join('');
  const cx = L.cx.map(x => `<tr><td>${x.label}</td><td>${x.n}</td><td>${cellAcc(x.n, x.w)}</td><td><span class="chip ${x.win ? 'c-u' : x.lose ? 'c-d' : 'c-m'}">${x.win ? 'رابحة' : x.lose ? 'خاسرة' : 'عينة صغيرة/متوسطة'}</span></td></tr>`).join('');
  let scT = '<tbody><tr><td class="note">لا أصل حالي</td></tr></tbody>';
  if (L.matrix) {
    scT = '<thead><tr><th>الاستراتيجية</th>' + L.matrix.cols.map(x => '<th>' + x + '</th>').join('') + '<th>الاختيار التلقائي</th></tr></thead><tbody>' +
      L.matrix.rows.map(r => '<tr><td>' + r.name + (r.improved ? ' ✦' : '') + '</td>' + r.cells.map(c =>
        '<td class="' + c.cls + '">' + (c.n ? cellAcc(c.n, c.w) + ' <small class="note">(' + c.n + (c.general ? ' عام' : '') + ')</small>' + (c.best ? ' ★' : '') : '-') + '</td>').join('') +
        '<td><span class="chip c-' + r.cls + '">' + r.st + '</span></td></tr>').join('') + '</tbody>';
  }
  const scn = L.matrix ? L.matrix.note : '';
  const vt = L.variants.map(x => `<tr><td>${x.name}</td><td>${x.no ? cellAcc(x.no, x.wo) + ' <small class="note">(' + x.no + ')</small>' : '-'}</td><td>${x.nn ? cellAcc(x.nn, x.wn) + ' <small class="note">(' + x.nn + ')</small>' : '-'}</td><td>${x.src}</td><td><span class="chip ${x.cur ? 'c-u' : 'c-m'}">${x.cur ? 'المعدّلة' : 'القديمة'}</span></td><td>${ESC(x.why)}</td></tr>`).join('');
  const vl = L.svLog.map(x => ESC(x.name) + ' → ' + (x.to === 'new' ? 'المعدّلة' : 'القديمة') + ' (' + new Date(x.t).toTimeString().slice(0, 5) + ')').join('، ');
  const cr = L.clusters.map(x => `<tr><td>${x.names.join('، ')}</td><td><span class="chip ${x.merged > 1 ? 'c-g' : 'c-m'}">${x.merged > 1 ? 'دُمجت ' + x.merged + ' مجموعات (تطابق مقاس)' : 'عنقود مستقل'}</span></td></tr>`).join('');
  const crn = L.pairs.map(p => p.names.join(' ↔ ') + ' ' + Math.round(p.agree * 100) + '%').join(' | ');
  const { zf, zb, za, be } = L.ab;
  const ab = `<div class="st"><span>كل الشموع (بدون امتناع)</span><b>${cellAcc(zf.ln + zf.hn, zf.lw + zf.hw)}</b><small>${zf.ln + zf.hn} حالة</small></div>` +
    `<div class="st"><span>الإشارات المُصدرة</span><b>${cellAcc(zb.ln + zb.hn, zb.lw + zb.hw)}</b><small>${zb.ln + zb.hn} حالة</small></div>` +
    `<div class="st"><span>التي امتنع عنها</span><b>${cellAcc(za.ln + za.hn, za.lw + za.hw)}</b><small>${za.ln + za.hn} حالة</small></div>` +
    `<div class="st"><span>نقطة التعادل</span><b>${pc(be, 1)}</b></div>`;
  const x = L.exps.map(e => {
    const st = e.base ? '<span class="chip c-m">المعتمد</span>' : e.ref ? '<span class="chip c-m">مرجع</span>' : e.cur ? '<span class="chip c-u">مُعتمدة</span>' : e.ready ? '<span class="chip c-u">جاهزة</span>' : '<span class="chip c-m">' + ESC(e.why) + '</span>';
    const btn = !e.ref && !e.base && !e.cur && e.ready ? `<button data-adopt="${e.k}">اعتمد</button>` : '';
    return `<tr><td>${e.n}</td><td>${e.z.ln}</td><td>${cellAcc(e.z.ln, e.z.lw)}</td><td>${e.lbPct !== null ? e.lbPct + '%' : '-'}</td><td>${e.z.hn}</td><td>${cellAcc(e.z.hn, e.z.hw)}</td><td>${st}</td><td>${btn}</td></tr>`;
  }).join('');
  const J = L.journal;
  const j = `<div class="st"><span>إشارات الدفتر</span><b>${J.n}</b><small>${J.done} اكتملت نتيجتها</small></div>` +
    `<div class="st"><span>النسخة الثانية (IndexedDB)</span><b class="${J.idbErr ? 'l' : 'w'}">${J.idbErr ? 'غير متاحة' : J.idbAt ? new Date(J.idbAt).toTimeString().slice(0, 8) : J.idbReady ? 'بانتظار أول حفظ' : 'تُفحص...'}</b></div>` +
    `<div class="st"><span>تجارب معتمدة</span><b>${J.adopted.length}</b><small>${J.adopted.slice(0, 3).map(a => ESC(a.k)).join('، ')}</small></div>`;
  return { q, h, hn: L.hzNote, rm, v, cx, scT, scn, vt, vl, cr, crn, ab, x, j };
}

// الشارت: يرسم بيانات جاهزة من نموذج العرض (الشموع، المتوسطات، العلامات)
function drawChart(cv, D) {
  const arr = D.arr;
  const ctx = cv.getContext('2d');
  const dpr = (typeof devicePixelRatio !== 'undefined' && devicePixelRatio) || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W) return;
  if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (arr.length < 3) {
    ctx.fillStyle = '#8d9ad0'; ctx.font = '14px sans-serif';
    ctx.fillText('بانتظار البيانات...', 20, 30);
    return;
  }
  let hi = -1e9, lo = 1e9;
  arr.forEach(c => { hi = Math.max(hi, c.h); lo = Math.min(lo, c.l); });
  const pad = (hi - lo) * .08 || 1e-6; hi += pad; lo -= pad;
  const y = v => H - (v - lo) / (hi - lo) * H, cw = W / arr.length;
  ctx.strokeStyle = '#26336e88'; ctx.lineWidth = 1;
  for (let i = 1; i < 5; i++) { ctx.beginPath(); ctx.moveTo(0, H * i / 5); ctx.lineTo(W, H * i / 5); ctx.stroke(); }
  arr.forEach((c, i) => {
    const x = i * cw + cw / 2, up = c.c >= c.o;
    ctx.strokeStyle = ctx.fillStyle = up ? '#3ddbb0' : '#ff6b7a';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(x, y(c.h)); ctx.lineTo(x, y(c.l)); ctx.stroke();
    ctx.fillRect(x - cw * .32, Math.min(y(c.o), y(c.c)), cw * .64, Math.max(1.5, Math.abs(y(c.o) - y(c.c))));
  });
  D.lines.forEach(({ col, v }) => {
    ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.beginPath();
    v.forEach((val, i) => { const x = i * cw + cw / 2; i ? ctx.lineTo(x, y(val)) : ctx.moveTo(x, y(val)); });
    ctx.stroke();
  });
  D.marks.forEach(m => {
    const x = m.i * cw + cw / 2, yy = y(m.entry);
    ctx.fillStyle = m.win === null ? '#f5c45e' : m.win ? '#3ddbb0' : '#ff6b7a';
    ctx.beginPath();
    if (m.dir === 'call') { ctx.moveTo(x, yy - 9); ctx.lineTo(x - 6, yy + 2); ctx.lineTo(x + 6, yy + 2); }
    else { ctx.moveTo(x, yy + 9); ctx.lineTo(x - 6, yy - 2); ctx.lineTo(x + 6, yy - 2); }
    ctx.fill();
  });
}
module.exports = { buildUI, labHtml, drawChart, CSS, HTML, ESC };
}
};
const __cache = {};
function __resolve(from, p) {
  if (p[0] !== '.') throw new Error('only relative requires are supported: ' + p);
  const parts = from.split('/').slice(0, -1);
  for (const s of p.split('/')) { if (s === '..') parts.pop(); else if (s !== '.') parts.push(s); }
  return parts.join('/').replace(/\.js$/, '');
}
function __load(id) {
  if (__cache[id]) return __cache[id].exports;
  if (!__defs[id]) throw new Error('module not found: ' + id);
  const module = __cache[id] = { exports: {} };
  __defs[id].call(undefined, module, module.exports, p => __load(__resolve(id, p)));
  return module.exports;
}
__load("main");
})();
