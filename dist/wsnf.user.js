// ==UserScript==
// @name         POCKET OPTION SMART BOT V1.0-dev (analysis and signals only)
// @namespace    local.wsnf.v34sim
// @version      1.0.0-dev.2
// @description  تحليل لحظي وإشارات على أسعار المنصة الفعلية. لا ينفّذ صفقات، لا ينقر أي زر في المنصة ولا يرسل أي أمر. أداة مستقلة غير تابعة لـ Pocket Option.
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
/* ---- core/feed.js ---- */
"core/feed": function (module, exports, require) {
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
/* ---- core/sio.js ---- */
"core/sio": function (module, exports, require) {
'use strict';
// النواة — تحليل إطارات Engine.IO/Socket.IO (بحت، بلا حالة).
// يطابق البروتوكول المنشور لـ Socket.IO v4 (https://socket.io/docs/v4/socket-io-protocol/):
//   إطار Engine.IO نصي: رقم النوع أولًا — 0 open، 1 close، 2 ping، 3 pong، 4 message، 5 upgrade، 6 noop
//   داخل message (4): نوع Socket.IO — 0 CONNECT، 1 DISCONNECT، 2 EVENT، 3 ACK، 4 CONNECT_ERROR، 5 BINARY_EVENT، 6 BINARY_ACK
//   ثم (لـ 5/6) عدد المرفقات الثنائية متبوعًا بـ «-»، ثم namespace اختياري يبدأ بـ «/» وينتهي بـ «,»، ثم رقم ack اختياري، ثم JSON.
//   المرفقات الثنائية تصل بعدها كإطارات ثنائية منفصلة بالترتيب، وتحل محل { _placeholder: true, num: i }.
// لا نفترض أي اسم حدث هنا؛ تفسير الأحداث في طبقة المنصة.

const EIO = { 0: 'open', 1: 'close', 2: 'ping', 3: 'pong', 4: 'message', 5: 'upgrade', 6: 'noop' };
const SIO = { 0: 'connect', 1: 'disconnect', 2: 'event', 3: 'ack', 4: 'connect_error', 5: 'binary_event', 6: 'binary_ack' };

// يعيد { eio, sio?, attachments, nsp, id, data?, error? }. لا يرمي أبدًا: أي خلل يُعاد في error ليُسجَّل.
function parseText(s) {
  if (typeof s !== 'string' || !s.length) return { eio: 'invalid', error: 'إطار فارغ' };
  const eio = EIO[s[0]];
  if (!eio) return { eio: 'invalid', error: 'نوع Engine.IO غير معروف: ' + s[0] };
  if (eio !== 'message') return { eio, raw: s.length > 1 ? s.slice(1, 200) : '' };
  const t = s[1], sio = SIO[t];
  if (!sio) return { eio, error: 'نوع Socket.IO غير معروف: ' + t };
  let i = 2, attachments = 0, nsp = '/', id = null;
  if (sio === 'binary_event' || sio === 'binary_ack') {
    const m = /^(\d+)-/.exec(s.slice(i));
    if (!m) return { eio, sio, error: 'عدد المرفقات مفقود' };
    attachments = +m[1]; i += m[0].length;
  }
  if (s[i] === '/') {
    const c = s.indexOf(',', i);
    if (c < 0) { nsp = s.slice(i); i = s.length; } else { nsp = s.slice(i, c); i = c + 1; }
  }
  const d = /^\d+/.exec(s.slice(i));
  if (d) { id = +d[0]; i += d[0].length; }
  const body = s.slice(i);
  const out = { eio, sio, attachments, nsp, id };
  if (!body.length) return out;
  try { out.data = JSON.parse(body); } catch (e) { out.error = 'JSON غير صالح: ' + String(e && e.message || e).slice(0, 80); }
  return out;
}

// استبدال العناصر النائبة بالمرفقات (عميق). المرفق المفقود خطأ لا يُخمَّن.
function fillPlaceholders(x, atts) {
  if (Array.isArray(x)) return x.map(v => fillPlaceholders(v, atts));
  if (x && typeof x === 'object') {
    if (x._placeholder === true && Number.isInteger(x.num)) {
      if (!(x.num in atts)) throw new Error('مرفق ثنائي مفقود رقم ' + x.num);
      return atts[x.num];
    }
    const o = {};
    for (const k in x) o[k] = fillPlaceholders(x[k], atts);
    return o;
  }
  return x;
}

// حدث Socket.IO = مصفوفة [اسم، ...وسائط]
const eventName = data => (Array.isArray(data) && typeof data[0] === 'string') ? data[0] : null;

module.exports = { EIO, SIO, parseText, fillPlaceholders, eventName };
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
    // اختيار الأصل يدويًا من الأصول التي وصلت بياناتها فعلًا (null = اتبع الأصل الذي تبثه المنصة)
    lockAsset(asset) {
      if (asset === null || asset === undefined || asset === '') { S.lock = null; return null; }
      if (!S.candles[asset]) return S.lock;
      S.lock = asset; S.cur = asset;
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
  // v4: حد للذاكرة — لا نحتفظ بشموع أكثر من CFG.maxAssets أصلًا في وقت واحد (كانت 5000 شمعة لكل أصل فُتح بلا حد).
  // يُحذف الأقدم تحديثًا، ولا يُحذف أبدًا: الأصل الحالي، المقفول، أو صاحب صفقة افتراضية مفتوحة/معلّقة.
  function evictAssets(incoming) {
    const keep = new Set([incoming, S.cur, S.lock, S.open && S.open.asset, S.pending && S.pending.asset]);
    const ks = Object.keys(S.candles).filter(a => !keep.has(a)).sort((a, b) => (S.lastTs[a] || 0) - (S.lastTs[b] || 0));
    while (Object.keys(S.candles).length >= CFG.maxAssets && ks.length) {
      const a = ks.shift();
      delete S.candles[a]; delete S.P[a]; delete S.sigBy[a]; delete S.dq[a]; delete S.SH[a]; delete S.sdh[a];
    }
  }
  // ================= الشموع من التيك =================
  function feedTick(asset, ts, p) {
    if (!Number.isFinite(ts) || !Number.isFinite(p) || p <= 0) return;
    if (S.lock && asset !== S.lock) return;
    const t = Math.floor(ts / CFG.tf) * CFG.tf;
    if (!S.candles[asset]) evictAssets(asset);
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
/* ---- engine/feed.js ---- */
"engine/feed": function (module, exports, require) {
'use strict';
// المحرك — مراقب تغذية البيانات: كل تيك من المنصة يمر من هنا قبل feedTick.
//   1) تحقق (core/feed.tickError) ← المرفوض يُعدّ بسببه ولا يدخل المحرك
//   2) كشف التكرار (حلقة محدودة لكل أصل) ← التيك المعاد إرساله يُتجاهل ويُعدّ
//   3) عدّادات لكل اتصال (رسائل، أحجام، آخر رسالة، أحداث معروفة/غير معروفة، أخطاء تحليل)
//   4) حالة البيانات (core/feed.feedStatus) تُحسب كل ثانية وتُصدر حدث 'feed' عند تغيّرها
// لا يرسل شيئًا للمنصة إطلاقًا.
const { tickError, createDedup, createClockTracker, feedStatus, FEED_LABEL } = require('../core/feed');

module.exports = function install(E) {
  const { S, CFG } = E, clock = E.clock;
  const [feedTick, loadHistory, connOpen, connLost, logErr] = E.use('feedTick', 'loadHistory', 'connOpen', 'connLost', 'logErr');
  const dedup = createDedup(256);
  const clk = createClockTracker();
  const F = E.feed = {
    conns: {}, nextId: 1,
    ticks: { rx: 0, ok: 0, dup: 0, rej: 0, reasons: {} },
    hist: { loads: 0, rx: 0, ok: 0, rej: 0, reasons: {} },
    perAsset: {},             // asset → { at (ساعة الجهاز), ts (وقت المنصة), p, n }
    candles: 0, reconnects: 0, downSince: 0, downMs: 0, everOpen: false, lastOpenAt: 0, lastCloseAt: 0,
    msgs: 0, bytes: 0, known: {}, unknown: {}, parseErrors: [], errAt: {},
    status: 'disconnected', statusSince: clock(), lastAsset: null, assetChanges: 0, reloadAdvice: false, history: [],
    // v4.0.1: مراحل خط البيانات (لكل اتصال) — لتحديد المرحلة التي ينقطع عندها الخط بدقة
    outgoing: {}, assetsById: {}, assetsLoadedAt: 0, unpaired: { n: 0, skeletons: [] }, lastMarketAt: 0, env: null
  };
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
  const openCount = () => Object.values(F.conns).filter(c => c.state === 'open').length;
  const connectingCount = () => Object.values(F.conns).filter(c => c.state === 'connecting').length;

  // ---- الاتصالات ----
  function connCreated(host) {
    const id = F.nextId++;
    F.conns[id] = { id, host: String(host || '').slice(0, 80), state: 'connecting', createdAt: clock(), openedAt: 0, closedAt: 0, msgs: 0, bytes: 0, lastMsgAt: 0, events: 0, errors: 0,
      auth: null, sub: null, marketAt: 0, marketEvents: 0, histAt: 0 };
    pruneConns();
    return id;
  }
  function connOpened(id) {
    const c = F.conns[id]; if (!c) return;
    const now = clock(), wasDown = F.everOpen && openCount() === 0;
    c.state = 'open'; c.openedAt = now;
    if (wasDown) { F.reconnects++; if (F.downSince) F.downMs += now - F.downSince; }
    F.downSince = 0; F.everOpen = true; F.lastOpenAt = now; F.reloadAdvice = false;
    connOpen();
  }
  // يعيد true إن كان هذا آخر اتصال مفتوح (أي انقطاع فعلي)
  function connClosed(id) {
    const c = F.conns[id]; if (!c) return false;
    const was = c.state === 'open';
    c.state = 'closed'; c.closedAt = clock();
    if (!was || openCount()) return false;
    F.downSince = F.lastCloseAt = clock();
    connLost();
    return true;
  }
  // لا نحتفظ إلا بآخر 20 اتصالًا مغلقًا (حد للذاكرة)
  function pruneConns() {
    const closed = Object.values(F.conns).filter(c => c.state === 'closed').sort((a, b) => a.closedAt - b.closedAt);
    while (closed.length > 20) delete F.conns[closed.shift().id];
  }
  function onMessage(id, bytes) {
    const c = F.conns[id], now = clock();
    F.msgs++; F.bytes += bytes || 0;
    if (c) { c.msgs++; c.bytes += bytes || 0; c.lastMsgAt = now; }
  }
  function onEvent(id, name, known) {
    const c = F.conns[id]; if (c) c.events++;
    const key = String(name).slice(0, 60);
    bump(known ? F.known : F.unknown, key);
    if (!known && Object.keys(F.unknown).length > 200) delete F.unknown[Object.keys(F.unknown)[0]];
  }
  // خطأ تحليل: يُسجَّل دائمًا في العدّاد، وفي سجل الأخطاء مرة كل 10 ث لكل سبب (لا إغراق)
  function parseError(id, why) {
    const c = F.conns[id], now = clock();
    if (c) c.errors++;
    F.parseErrors.push({ at: now, conn: id || 0, why: String(why).slice(0, 120) });
    if (F.parseErrors.length > 50) F.parseErrors.shift();
    const k = String(why).slice(0, 40);
    if (!F.errAt[k] || now - F.errAt[k] > 1e4) { F.errAt[k] = now; logErr('WS_PARSE', String(why).slice(0, 160)); }
  }

  // ---- مراحل الخط: الدخول، الاشتراك، أحداث السوق، جدول الأصول ----
  // أسماء الأحداث موثّقة في reverse/on_events.md وemit_events.md لمكتبة lordralinc/pocket_option (مرجع فقط، لم يُنسخ منها كود)
  function onAuth(id, ok) {
    const c = F.conns[id]; if (!c) return;
    c.auth = { ok: !!ok, at: clock() };
    if (!ok) logErr('PO_AUTH', 'المنصة رفضت الدخول (NotAuthorized) على الاتصال #' + id);
  }
  // رسالة صادرة أرسلتها المنصة نفسها (البوت لا يرسل شيئًا). نسجّل الاسم فقط، وللاشتراك أصل/مدة فقط — لا أي قيمة أخرى.
  function onOutgoing(id, name, payload) {
    const c = F.conns[id], key = String(name).slice(0, 60);
    bump(F.outgoing, key);
    if (Object.keys(F.outgoing).length > 100) delete F.outgoing[Object.keys(F.outgoing)[0]];
    if (!c) return;
    if (key === 'changeSymbol' || key === 'subscribeSymbol') {
      const a = payload && typeof payload === 'object' ? payload.asset : payload;
      const per = payload && typeof payload === 'object' && Number.isFinite(+payload.period) ? +payload.period : null;
      if (typeof a === 'string' || Number.isFinite(a)) c.sub = { raw: typeof a === 'string' ? a.slice(0, 40) : +a, period: per, at: clock(), via: key };
    }
    if (key === 'unSubscribeSymbol' && c.sub) c.sub = { ...c.sub, unsubAt: clock() };
  }
  function onMarketEvent(id, kind) {
    const c = F.conns[id], now = clock();
    F.lastMarketAt = now;
    if (c) { c.marketAt = now; c.marketEvents++; if (kind === 'hist') c.histAt = now; }
  }
  // updateAssets: صفوف تبدأ بـ [id, asset, label, ...] (ترتيب موثّق ومتطابق في مكتبتين مستقلتين). نأخذ id والرمز فقط.
  function onAssets(id, rows) {
    if (!Array.isArray(rows)) { parseError(id, 'updateAssets: بنية غير متوقعة'); return 0; }
    let n = 0;
    for (const r of rows) if (Array.isArray(r) && Number.isFinite(r[0]) && typeof r[1] === 'string' && r[1].length <= 40) { F.assetsById[r[0]] = r[1]; n++; }
    if (!n) parseError(id, 'updateAssets: لا صفوف بالشكل [id, asset, …]');
    else F.assetsLoadedAt = clock();
    return n;
  }
  // إطار ثنائي وصل دون حدث ينتظره: نحفظ بنيته فقط (بلا قيم) ليظهر في التشخيص
  function onUnpaired(id, sk) {
    F.unpaired.n++;
    const s = JSON.stringify(sk).slice(0, 300);
    if (F.unpaired.skeletons.length < 5 && !F.unpaired.skeletons.includes(s)) F.unpaired.skeletons.push(s);
  }
  const resolveAsset = raw => raw === null || raw === undefined ? null : typeof raw === 'string' ? raw : (F.assetsById[raw] || null);
  function setEnv(env) { F.env = env; }

  // ---- التيكات ----
  function ingestTicks(id, list) {
    onMarketEvent(id, 'stream');
    if (!Array.isArray(list)) { parseError(id, 'updateStream: الحمولة ليست مصفوفة'); return 0; }
    let ok = 0;
    for (const x of list) {
      F.ticks.rx++;
      if (!Array.isArray(x) || x.length < 3) { F.ticks.rej++; bump(F.ticks.reasons, 'بنية تيك غير متوقعة'); continue; }
      const t = { asset: String(x[0]), ts: +x[1], p: +x[2] }, pa = F.perAsset[t.asset] || null;
      const why = tickError(t, pa, { maxJump: CFG.maxPriceJump, jumpWindowS: 300 });
      if (why) { F.ticks.rej++; bump(F.ticks.reasons, why); continue; }
      if (dedup.seen(t.asset, t.ts, t.p)) { F.ticks.dup++; continue; }
      const before = S.cur;
      feedTick(t.asset, t.ts, t.p);
      // قد يرفض المحرك التيك (أصل غير مقفول، أقدم من الشمعة الحالية): نعدّه صالحًا فقط إن دخل فعلًا
      if (S.lastTs[t.asset] !== t.ts) { F.ticks.rej++; bump(F.ticks.reasons, S.lock && t.asset !== S.lock ? 'أصل غير المقفول' : 'تيك أقدم من الشمعة الحالية'); continue; }
      F.ticks.ok++; ok++;
      const now = clock(), r = F.perAsset[t.asset] || (F.perAsset[t.asset] = { at: 0, ts: 0, p: 0, n: 0 });
      r.at = now; r.ts = t.ts; r.p = t.p; r.n++;
      clk.add(now, t.ts);
      if (before !== S.cur && S.cur === t.asset) {
        F.assetChanges++;
        if (F.lastAsset !== null) E.emit('asset', { from: F.lastAsset, to: t.asset });
        F.lastAsset = t.asset;
      }
    }
    prunePerAsset();
    return ok;
  }
  function prunePerAsset() {
    const ks = Object.keys(F.perAsset);
    if (ks.length <= 50) return;
    ks.sort((a, b) => F.perAsset[a].at - F.perAsset[b].at).slice(0, ks.length - 50).forEach(k => { delete F.perAsset[k]; dedup.forget(k); });
  }
  // التاريخ: يُرفض منه ما لا يجتاز التحقق الأساسي (أنواع، وحدة الوقت). لا يُطبَّق كشف التكرار: التحميل يعيد البناء من الصفر.
  function ingestHistory(id, asset, list) {
    onMarketEvent(id, 'hist');
    if (typeof asset !== 'string' || !Array.isArray(list)) { parseError(id, 'updateHistory: بنية غير متوقعة'); return 0; }
    F.hist.loads++;
    const ok = [];
    for (const x of list) {
      F.hist.rx++;
      const t = Array.isArray(x) ? { asset, ts: +x[0], p: +x[1] } : null;
      const why = t ? tickError(t, null, null) : 'بنية غير متوقعة';
      if (why) { F.hist.rej++; bump(F.hist.reasons, why); continue; }
      ok.push(x);
    }
    F.hist.ok += ok.length;
    loadHistory(asset, ok);
    // آخر تيكات التاريخ تدخل كاشف التكرار: إن أعادت المنصة بثها حيًا لا تُحسب مرتين
    dedup.forget(asset);
    ok.slice(-256).forEach(x => dedup.seen(asset, +x[0], +x[1]));
    return ok.length;
  }
  E.on('candle', x => { if (x.live) F.candles++; });

  // ---- الحالة ----
  const TH = () => ({ liveMs: CFG.feedLiveMs, delayMs: CFG.maxTickAgeMs, unavailableMs: CFG.feedUnavailableMs, waitMs: CFG.feedWaitMs });
  function computeStatus(now = clock()) {
    const cur = S.cur, pa = cur ? F.perAsset[cur] : null;
    const recentErr = F.parseErrors.filter(e => now - e.at < 6e4).length;
    return feedStatus({ openConns: openCount(), connecting: connectingCount(), everOpen: F.everOpen, lastOpenAt: F.lastOpenAt, lastCloseAt: F.lastCloseAt,
      lastValidAt: pa ? pa.at : 0, errorBurst: recentErr >= 5, now }, TH());
  }
  // يُستدعى كل ثانية (المؤقت في main): يُحدّث الحالة المخزنة ويُصدر حدثًا عند التغيّر
  function feedCheck() {
    const now = clock(), st = computeStatus(now);
    if (st !== F.status) {
      const from = F.status;
      F.status = st; F.statusSince = now;
      F.history.push({ at: now, from, to: st }); if (F.history.length > 100) F.history.shift();
      E.emit('feed', { from, to: st, label: FEED_LABEL[st] });
    }
    if (!F.reloadAdvice && F.downSince && now - F.downSince > CFG.reloadAdviceMs) {
      F.reloadAdvice = true;
      logErr('WS_RELOAD', 'لم تُعِد المنصة الاتصال منذ ' + Math.round((now - F.downSince) / 1000) + ' ث: أعد تحميل الصفحة');
      E.emit('reloadAdvice', { since: F.downSince });
    }
    return st;
  }
  // المراحل الخمس + تشخيص المرحلة التي ينقطع عندها الخط. «صالحة» = نفس شرط «بيانات حية».
  function stages(now = clock(), st = computeStatus(now)) {
    const open = Object.values(F.conns).filter(c => c.state === 'open');
    const authC = open.filter(c => c.auth && c.auth.ok), denied = open.some(c => c.auth && !c.auth.ok);
    const subC = open.filter(c => (c.sub && !c.sub.unsubAt) || c.histAt);
    const recvC = open.filter(c => c.marketAt && now - c.marketAt <= CFG.feedReceivingMs);
    const sub = subC.map(c => c.sub).filter(Boolean).sort((a, b) => b.at - a.at)[0] || null;
    const subAsset = sub ? resolveAsset(sub.raw) : null;
    const pa = S.cur ? F.perAsset[S.cur] : null;
    const rejected = F.ticks.rej, tickRx = F.ticks.rx;
    const S5 = {
      connected: { ok: open.length > 0, detail: open.length + ' اتصال مفتوح من ' + Object.keys(F.conns).length },
      authenticated: { ok: authC.length > 0, failed: denied, detail: authC.length ? 'successauth على ' + authC.length + ' اتصال' : denied ? 'NotAuthorized' : 'لم يصل successauth على أي اتصال مفتوح' },
      subscribed: { ok: subC.length > 0, detail: sub ? (sub.via + ': ' + (subAsset || ('#' + sub.raw + ' (غير معروف في updateAssets)')) + (sub.period !== null ? ' · period ' + sub.period : '')) : subC.length ? 'وصل تاريخ أصل (اشتراك ضمني)' : 'لم تطلب المنصة الاشتراك في أي أصل (changeSymbol) على اتصال مفتوح' },
      receiving: { ok: recvC.length > 0, detail: F.lastMarketAt ? 'آخر رسالة أسعار منذ ' + Math.round((now - F.lastMarketAt) / 1000) + ' ث' : 'لم تصل أي رسالة أسعار (updateStream / updateHistoryNew*)' },
      valid: { ok: st === 'live', detail: pa ? 'آخر تيك صالح منذ ' + Math.round((now - pa.at) / 1000) + ' ث' : tickRx ? 'كل التيكات المستلمة رُفضت (' + rejected + ')' : 'لا تيكات' }
    };
    let why = '';
    if (!S5.connected.ok) why = 'لا يوجد أي اتصال مفتوح مع المنصة.';
    else if (S5.authenticated.failed) why = 'المنصة رفضت الدخول (NotAuthorized): سجّل الدخول من جديد.';
    else if (!S5.authenticated.ok) why = 'الاتصال مفتوح لكن لم يصل تأكيد الدخول (successauth) على أي اتصال مفتوح.';
    else if (!S5.subscribed.ok) why = 'لم ترسل المنصة طلب الاشتراك في أصل (changeSymbol) على أي اتصال مراقَب. افتح الشارت واختر الأصل.';
    else if (!S5.receiving.ok) {
      const e = F.env || {};
      why = 'المنصة طلبت الاشتراك' + (subAsset ? ' في ' + subAsset : '') + ' لكن لا تصل رسائل الأسعار على أي اتصال مراقَب.' +
        (F.unpaired.n ? ' وصلت ' + F.unpaired.n + ' إطارات ثنائية دون حدث ينتظرها (انظر «رسائل المنصة»).' : '') +
        (e.workers ? ' الصفحة أنشأت ' + e.workers + ' Worker: قد تُستقبل الأسعار داخله حيث لا يصل المراقب.' : '') +
        (e.frames ? ' في الصفحة ' + e.frames + ' إطار iframe.' : '');
    } else if (!S5.valid.ok) why = tickRx && rejected === tickRx ? 'تصل رسائل الأسعار لكن كل التيكات تُرفض — الأسباب: ' + Object.entries(F.ticks.reasons).map(([k, n]) => k + ' ×' + n).join('، ') :
      S.cur && subAsset && S.cur !== subAsset ? 'تصل الأسعار لأصل (' + S.cur + ') غير الأصل المشترك فيه (' + subAsset + ').' : 'تصل رسائل الأسعار لكن لا تيك صالح حديث للأصل الحالي.';
    return { stages: S5, why, subAsset, tickAsset: S.cur || null };
  }
  // للعرض: نسخة بلا أي تعديل للحالة
  function feedView() {
    const now = clock(), st = computeStatus(now), cur = S.cur, pa = cur ? F.perAsset[cur] : null;
    return {
      status: st, label: FEED_LABEL[st], since: F.status === st ? F.statusSince : now,
      // source: مصدر البيانات — اتصال المنصة في الصفحة (تترجمه الواجهة إلى نص عربي)
      source: 'platform-ws', asset: cur, lastPrice: pa ? pa.p : null, lastTs: pa ? pa.ts : null,
      lastAt: pa ? pa.at : null, ageMs: pa ? now - pa.at : null,
      // إزاحة ساعة المنصة عن الجهاز (تُقاس، لا تُفترض) والتأخر النسبي لآخر تيك
      clockOffsetS: clk.offsetS() === null ? null : Math.round(clk.offsetS()), latencyMs: clk.latencyMs(),
      ticks: { ...F.ticks, reasons: { ...F.ticks.reasons } }, hist: { ...F.hist, reasons: { ...F.hist.reasons } }, candles: F.candles,
      conns: Object.values(F.conns).map(c => ({ ...c })), open: openCount(), reconnects: F.reconnects,
      downMs: F.downMs + (F.downSince ? now - F.downSince : 0), msgs: F.msgs, bytes: F.bytes,
      known: { ...F.known }, unknown: { ...F.unknown }, parseErrors: F.parseErrors.slice(-20).map(e => ({ ...e })),
      assets: Object.keys(F.perAsset).map(a => ({ a, ...F.perAsset[a], ageMs: now - F.perAsset[a].at })).sort((x, y) => y.at - x.at),
      assetChanges: F.assetChanges, reloadAdvice: F.reloadAdvice, history: F.history.slice(-20).map(h => ({ ...h })),
      pipeline: stages(now, st), outgoing: { ...F.outgoing }, assetsKnown: Object.keys(F.assetsById).length,
      unpaired: { n: F.unpaired.n, skeletons: F.unpaired.skeletons.slice() }, env: F.env ? { ...F.env } : null
    };
  }
  E.provide({ connCreated, connOpened, connClosed, onMessage, onEvent, parseError, ingestTicks, ingestHistory, feedCheck, feedView, computeStatus,
    onAuth, onOutgoing, onMarketEvent, onAssets, onUnpaired, resolveAsset, setEnv, feedStages: stages });
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
  require('./feed')(E);
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
const SCRIPT_VERSION = '4.0.0-dev';
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
    recMaxPerSeries: 500000, recMaxGapFrac: .5,
    // v4: تغذية البيانات — «حية» حتى 3 ث من آخر تيك صالح، «متأخرة» حتى maxTickAgeMs، «قديمة» حتى دقيقة، ثم «غير متاحة»
    feedLiveMs: 3000, feedUnavailableMs: 60000, feedWaitMs: 15000, maxPriceJump: .2, feedReceivingMs: 10000, reloadAdviceMs: 60000, maxAssets: 8
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
const { tfOfKey, assetOfKey, emptyBook } = require('../core/learning');
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


  // لوحة V1.0 (الواجهة الجديدة): رموز حالة محايدة لغويًا تترجمها الواجهة، وأرقام محسوبة من الحالة الفعلية فقط.
  // لا تكتب في الحالة. نصوص الأسباب التي يولّدها المحرك (abst/notes) تُمرَّر كما هي.
  function dash() {
    const now = clock(), asset = S.cur, r = asset ? S.sigBy[asset] : null, arr = asset ? S.candles[asset] || [] : [];
    const f = E.fn.feedView(), dataOk = f.status === 'live' || f.status === 'delayed';
    // حالة محرك التوقيت — مشتقة من قرار المحرك الحالي (محرك التوقيت المستقل والتقييم من 100: المرحلة 5)
    let timing;
    if (!asset || !dataOk) timing = { state: 'wait', code: 'data' };
    else if (S.loading) timing = { state: 'analyzing', code: 'history' };
    else if (arr.length < 60) timing = { state: 'wait', code: 'collect', n: arr.length, need: 60 };
    else if (!r) timing = { state: 'analyzing', code: 'first' };
    else if (r.stale) timing = { state: 'wait', code: 'stale' };
    else if (r.d !== 'none') timing = { state: 'favorable', code: 'signal' };
    else timing = { state: 'no_trade', code: 'engine', text: r.abst && r.abst[0] ? String(r.abst[0]) : '' };
    const analysis = !asset ? 'idle' : S.loading ? 'loading' : !dataOk ? 'paused' : arr.length < 60 ? 'collecting' : 'active';
    let signal = null;
    if (r) {
      const sd = r.sd || 0, votes = r.rawA && typeof r.rawA === 'object' ? r.rawA : {};
      const side = sgn => sd ? Object.keys(votes).filter(k => votes[k] * sd * sgn > 0).map(k => ({ k, name: NM[k] || k, v: +(+votes[k]).toFixed(2) })) : [];
      signal = {
        d: r.d, conf: r.conf, sd, regime: r.regime || '-', stale: !!r.stale,
        abst: (r.abst || []).map(String), notes: (r.notes || []).map(String),
        agree: r.agree === undefined ? null : r.agree, oppPct: r.opp === undefined ? null : Math.round(r.opp * 100),
        htf: r.htf === undefined ? null : r.htf, htfOK: r.htfOK === undefined ? null : !!r.htfOK,
        q: r.q === undefined ? null : r.q, vetoes: copy(r.vetoes || []),
        ctx: r.ctx ? { label: r.ctx.label, clarity: r.ctx.clarity, note: r.ctx.note || '' } : null,
        pro: side(1), con: side(-1),
        bestHz: r.hzB ? { s: r.hzB.h * CFG.tf, accPct: Math.round(r.hzB.acc * 100) } : null
      };
    }
    // إحصاءات من دفاتر النتائج الحية المحفوظة (لا تُخلط بها نتائج إعادة تشغيل التاريخ)
    const add = (o, k, n, w) => { const x = o[k] || (o[k] = { k, n: 0, w: 0 }); x.n += n; x.w += w; };
    const byAsset = {}, byTf = {}, byStrat = {};
    let n = 0, w = 0;
    for (const k in S.A) {
      const A = S.A[k];
      if (!A || !A.e) continue;
      n += A.e.ln; w += A.e.lw;
      if (A.e.ln) { add(byAsset, assetOfKey(k), A.e.ln, A.e.lw); add(byTf, tfOfKey(k), A.e.ln, A.e.lw); }
      // المفاتيح التي فيها # دفاتر فرعية لكل حالة سوق: تُستبعد حتى لا تُعدّ النتيجة مرتين
      for (const sk in A.s) if (sk.indexOf('#') < 0 && A.s[sk] && A.s[sk].ln) add(byStrat, sk, A.s[sk].ln, A.s[sk].lw);
    }
    const fin = x => ({ ...x, acc: x.n ? x.w / x.n : null, lo: x.n ? wil(x.n, x.w, 1.96) : null, hi: x.n ? 1 - wil(x.n, x.n - x.w, 1.96) : null });
    const rows = o => Object.values(o).map(fin).sort((a, b) => b.n - a.n);
    const assets = f.assets.map(x => {
      const cs = S.candles[x.a] || [], sg = S.sigBy[x.a];
      return { a: x.a, price: x.p === undefined ? null : x.p, ageMs: x.ageMs, candles: cs.length, d: sg ? sg.d : null, conf: sg ? sg.conf : null, cur: x.a === asset, locked: S.lock === x.a };
    });
    return {
      version: SCRIPT_VERSION, now, asset, lock: S.lock, tf: CFG.tf, candles: arr.length,
      candleLeftS: asset && S.lastTs[asset] && arr.length ? Math.max(0, Math.ceil(CFG.tf - (S.lastTs[asset] - arr[arr.length - 1].t))) : null,
      feed: { status: f.status, since: f.since, source: f.source, lastPrice: f.lastPrice, lastTs: f.lastTs, lastAt: f.lastAt, ageMs: f.ageMs, latencyMs: f.latencyMs,
        open: f.open, reconnects: f.reconnects, ticksOk: f.ticks.ok, ticksRej: f.ticks.rej, ticksDup: f.ticks.dup, reloadAdvice: !!f.reloadAdvice, why: f.pipeline ? f.pipeline.why : '' },
      analysis, timing, signal,
      dq: asset && S.dq[asset] ? copy(S.dq[asset]) : null,
      assets, assetsScanned: Object.keys(S.candles).length,
      signalsLogged: S.log.length,
      stats: { total: fin({ k: 'all', n, w }), byAsset: rows(byAsset), byTf: rows(byTf), byStrat: rows(byStrat).map(x => ({ ...x, name: NM[x.k] || x.k })) },
      log: S.log.slice(0, 200).map(e => ({ t: e.t, asset: e.asset, dir: e.dir, conf: e.conf, entry: e.entry, exit: e.exit, win: e.win, tie: !!e.tie, stale: !!e.stale, voided: !!e.voided, failed: !!e.failed, why: (e.why || []).map(String) })),
      errors: S.errors.length, storeErr: !!S.storeErr,
      cfg: { tf: CFG.tf, minConf: CFG.minConf, minQ: CFG.minQ, feedLiveMs: CFG.feedLiveMs, maxTickAgeMs: CFG.maxTickAgeMs, feedUnavailableMs: CFG.feedUnavailableMs, window: CFG.window, maxAssets: CFG.maxAssets }
    };
  }

  // حالة التغذية: نسخة من مراقب البيانات (engine/feed.js) دون تعديل
  const feed = () => E.fn.feedView();
  E.provide({ view, lab, recorder, chart, settings, feed, dash, activeCheck, norm });
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
const { createDiscovery } = require('./platform/discovery');
const { installEnvProbe } = require('./platform/env');
const { buildUI } = require('./ui/ui');
const { buildShell } = require('./ui/shell');
const core = {
  stats: require('./core/stats'), indicators: require('./core/indicators'), strategies: require('./core/strategies'),
  quality: require('./core/quality'), context: require('./core/context'), decision: require('./core/decision'), catalog: require('./core/catalog'),
  format: require('./recorder/format'), sio: require('./core/sio'), feed: require('./core/feed')
};

const win = window;
const TEST = win.__WSNF_TEST === true;
// حارس الحقن المزدوج: إن حُقن السكربت مرتين في نفس الصفحة لا يُنشأ محرك ثانٍ ولا تتكرر المستمعات ولا يُلَف WebSocket مرتين
if (win.__WSNF_RUNNING) { try { win.console.warn('[wsnf] السكربت يعمل مسبقًا في هذه الصفحة؛ تم تجاهل الحقن الثاني'); } catch (e) {} return; }
Object.defineProperty(win, '__WSNF_RUNNING', { value: true });
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
const probe = installEnvProbe(win, s => F.setEnv(s));
setInterval(() => { try { F.watchdog(); } catch (err) {} try { F.setEnv(probe.snapshot()); F.feedCheck(); } catch (err) {} }, 1000);
setInterval(() => { try { F.recFlush(); } catch (err) {} }, 5000);

const handle = createHandler(E);
const discovery = createDiscovery({ clock: () => Date.now() });
const tapped = installSocketTap(win, E, handle, { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: t => clearTimeout(t) }, discovery);
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
  vm: { view: F.view, lab: F.lab, recorder: F.recorder, chart: F.chart, settings: F.settings, feed: F.feed, dash: F.dash },
  cmd: E.cmd,
  rec: { setOn: F.recSetOn, exportFile: F.recExport, importFile: F.recImport, scanGaps: F.recScanGaps, clear: F.recClear },
  on: E.on, tapped,
  discovery: { start: () => discovery.start(), stop: () => discovery.stop('إيقاف يدوي'), report: () => discovery.report({ version: SCRIPT_VERSION, feed: F.feedView() }), status: () => { const r = discovery.report(); return { on: r.running, startedAt: r.startedAt ? Date.parse(r.startedAt) : 0, messages: r.messages, types: Object.keys(r.events).length, stopReason: r.stopReason }; } },
  readShown, diagnostics,
  downloadText: (name, text, mime) => downloadText(win, name, text, mime),
  prefs: { get: F.LSget, set: F.LSset }
};
// V1.0: الواجهة الجديدة (ui/shell.js) هي الظاهرة. صفحات الإصدار السابق تُبنى مخفية وتُفتح من «متقدم» وتعود بزر «رجوع».
let uiHandle = null, shellHandle = null;
const showLegacy = on => {
  if (uiHandle && uiHandle.host) uiHandle.host.style.display = on ? '' : 'none';
  if (shellHandle && shellHandle.host) shellHandle.host.style.display = on ? 'none' : '';
  if (on && uiHandle) { try { uiHandle.host.shadowRoot.getElementById('min').textContent = shellHandle.backLabel(); } catch (e) {} uiHandle.paint(); }
  if (!on && shellHandle) shellHandle.go('dash');
};
const build = () => {
  if (win.__WSNF25_NOUI) return;
  shellHandle = buildShell(app, { openLegacy: () => showLegacy(true) });
  uiHandle = buildUI(app, { embedded: true, onBack: () => showLegacy(false), backLabel: shellHandle ? shellHandle.backLabel() : '←' });
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
else build();

// الواجهة الداخلية تُكشف للاختبارات فقط (السكربت يعمل عند document-start قبل سكربتات الصفحة، فلا تستطيع الصفحة ضبط هذا العلم مسبقًا).
// لا توجد فيها أي دالة تنفيذ: لا يوجد كود تنفيذ أصلًا. الدوال ذات توقيعات v3.5 أغلفة رفيعة فوق الوحدات الجديدة.
if (TEST) {
  const Ln = E.learner, Cl = E.clusters, Q = core.quality, D = core.decision, X = core.context, I = core.indicators;
  const peek = a => S.A[F.AK(a)] || null;
  win.__WSNF25 = {
    SIM_ONLY, S, CFG, E, core, app, get ui() { return uiHandle; }, get shell() { return shellHandle; }, showLegacy,
    on: E.on, cmd: E.cmd, discovery, tapped,
    feedView: F.feedView, feedCheck: F.feedCheck, feedStages: F.feedStages, probe, onOutgoing: F.onOutgoing, computeStatus: F.computeStatus, ingestTicks: F.ingestTicks, ingestHistory: F.ingestHistory, feedState: () => E.feed,
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
/* ---- platform/discovery.js ---- */
"platform/discovery": function (module, exports, require) {
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
/* ---- platform/env.js ---- */
"platform/env": function (module, exports, require) {
'use strict';
// طبقة المنصة — فحص سلبي لبيئة الصفحة: هل أنشأت الصفحة Worker/SharedWorker (قد تُفتح اتصالات الأسعار داخله حيث لا يصل
// مراقب WebSocket في الصفحة)، وكم إطار iframe فيها. لا يُحقن شيء في أي Worker أو iframe، ولا يُعدَّل سلوكها.
function installEnvProbe(win, onChange) {
  const st = { workers: 0, sharedWorkers: 0, workerHosts: {}, frames: 0, frameHosts: {} };
  const hostOf = u => { try { return new URL(String(u), win.location && win.location.href).host || 'blob'; } catch (e) { return 'غير معروف'; } };
  const wrap = (name, key) => {
    const Native = win[name];
    if (typeof Native !== 'function' || Native.__wsnfProbe) return;
    const P = function (url, opts) {
      st[key]++; const h = hostOf(url); st.workerHosts[h] = (st.workerHosts[h] || 0) + 1;
      try { onChange(snapshot()); } catch (e) {}
      return opts !== undefined ? new Native(url, opts) : new Native(url);
    };
    P.prototype = Native.prototype;
    Object.defineProperty(P, '__wsnfProbe', { value: true });
    try { win[name] = P; } catch (e) {}
  };
  wrap('Worker', 'workers');
  wrap('SharedWorker', 'sharedWorkers');
  function snapshot() {
    try {
      const fr = win.document ? win.document.querySelectorAll('iframe') : [];
      st.frames = fr.length; st.frameHosts = {};
      for (const f of fr) { const h = hostOf(f.src || 'about:blank'); st.frameHosts[h] = (st.frameHosts[h] || 0) + 1; }
    } catch (e) {}
    return { workers: st.workers + st.sharedWorkers, workerHosts: { ...st.workerHosts }, frames: st.frames, frameHosts: { ...st.frameHosts } };
  }
  return { snapshot };
}
module.exports = { installEnvProbe };
},
/* ---- platform/ws.js ---- */
"platform/ws": function (module, exports, require) {
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
/* ---- ui/i18n.js ---- */
"ui/i18n": function (module, exports, require) {
'use strict';
// الواجهة — نصوص الواجهة الجديدة (V1.0) بالعربية والإنجليزية. بحتة: لا DOM ولا حالة.
// ملاحظة: نصوص الأسباب التي يولّدها محرك التحليل نفسه (أسباب الامتناع، ملاحظات المؤشرات) ما زالت عربية فقط؛
// ترجمتها ضمن المرحلة 6 (نظام الإشارات). الواجهة تذكر ذلك صراحةً في الوضع الإنجليزي.
const AR = {
  brand_sub: 'تحليل فقط · لا تنفيذ',
  dev: 'V1.0 قيد التطوير',
  nav_dash: 'لوحة التحكم', nav_market: 'السوق', nav_signals: 'الإشارات', nav_history: 'السجل', nav_alerts: 'التنبيهات', nav_settings: 'الإعدادات', nav_adv: 'متقدم',
  minimize: 'تصغير', lang_switch: 'English', na: 'غير متاح', none: 'لا يوجد', ago_s: 'منذ {n} ث', ago_m: 'منذ {n} د', now: 'الآن',
  // حالات البيانات
  fs_disconnected: 'غير متصل', fs_connecting: 'جارٍ الاتصال', fs_connected: 'متصل — بانتظار البيانات', fs_live: 'بيانات حية',
  fs_delayed: 'بيانات متأخرة', fs_stale: 'بيانات قديمة', fs_unavailable: 'البيانات غير متاحة', fs_error: 'خطأ في البيانات',
  // محرك التوقيت
  tm_wait: 'WAIT · انتظار', tm_analyzing: 'ANALYZING · تحليل', tm_favorable: 'FAVORABLE · ظروف مناسبة', tm_no_trade: 'NO TRADE · لا فرصة',
  tc_data: 'بانتظار بيانات حية من المنصة', tc_history: 'تحميل تاريخ الأصل', tc_collect: 'تجميع الشموع {n}/{need}', tc_first: 'بانتظار إغلاق أول شمعة',
  tc_stale: 'السعر متقادم — التحليل متوقف', tc_signal: 'توافقت شروط المحرك على إشارة', tc_engine: 'المحرك امتنع',
  tm_prelim: 'مشتقة من قرار المحرك الحالي. محرك التوقيت المستقل والتقييم من 100: المرحلة 5.',
  // محرك التحليل
  an_idle: 'لا بيانات', an_loading: 'يحمّل التاريخ', an_paused: 'متوقف — البيانات غير حية', an_collecting: 'يجمع الشموع', an_active: 'يعمل',
  // اللوحة
  d_bot: 'حالة البوت', d_bot_on: 'يعمل', d_bot_wait: 'بانتظار البيانات', d_bot_sub: 'تحليل وإشارات فقط — لا ينفّذ صفقات',
  d_conn: 'الاتصال بمصدر البيانات', d_src: 'المصدر: Pocket Option — اتصال الصفحة (قراءة فقط)',
  d_asset: 'الأصل الحالي', d_asset_none: 'لم تصل بيانات أي أصل بعد', d_locked: 'مثبّت يدويًا', d_follow: 'يتبع الأصل المفتوح في المنصة',
  d_tf: 'الإطار الزمني', d_trend: 'اتجاه السوق', d_strength: 'قوة الإشارة', d_strength_sub: 'درجة توافق المؤشرات — ليست احتمال نجاح',
  d_last: 'آخر تحديث للأسعار', d_scanned: 'الأصول المفحوصة', d_scanned_sub: 'أصول وصلت بياناتها في هذه الجلسة',
  d_signals: 'الإشارات المسجّلة', d_signals_sub: 'آخر 200 محفوظة · الإجمالي الحي {n}',
  d_engine: 'محرك التحليل', d_timing: 'محرك اختيار التوقيت', d_recent: 'آخر التحليلات', d_no_recent: 'لا إشارات مسجّلة بعد',
  d_candles: '{n} شمعة', d_next: 'إغلاق الشمعة بعد {n} ث', d_price: 'السعر',
  up: 'صاعد', down: 'هابط', flat: 'غير محدد',
  rg_trend: 'اتجاهي', rg_range: 'عرضي', rg_mixed: 'مختلط', rg_volatile: 'متقلب',
  // السوق
  m_chart: 'الشارت — {a}', m_chart_sub: 'آخر 90 شمعة مغلقة · EMA 9 و EMA 21', m_wait: 'بانتظار البيانات...',
  m_assets: 'الأصول التي وصلت بياناتها', m_assets_note: 'المنصة تبث الأصل المفتوح على الشارت فقط. افتح أصلًا في المنصة ليظهر هنا (حتى {n} أصول في الذاكرة).',
  m_col_asset: 'الأصل', m_col_price: 'آخر سعر', m_col_age: 'آخر تحديث', m_col_candles: 'الشموع', m_col_sig: 'آخر تحليل', m_col_act: 'الإجراء',
  m_lock: 'حلّل هذا الأصل فقط', m_unlock: 'إلغاء التثبيت', m_current: 'الحالي', m_no_assets: 'لا أصول بعد',
  m_ohlc: 'فتح {o} · أعلى {h} · أدنى {l} · إغلاق {c}',
  // الإشارات
  s_current: 'الإشارة الحالية', s_none: 'لا إشارة الآن', s_call: 'CALL · صعود', s_put: 'PUT · هبوط',
  s_asset: 'الأصل', s_time: 'وقت الإشارة', s_tf: 'الإطار الزمني', s_eval: 'مدة التقييم', s_eval_v: 'شمعة واحدة ({n} ث) — تُسجَّل النتيجة عند إغلاق الشمعة التالية',
  s_price: 'السعر وقت الإشارة', s_strength: 'قوة الإشارة', s_pro: 'المؤشرات المؤيدة', s_con: 'المؤشرات المعارضة', s_reason: 'سبب القرار',
  s_timing: 'حالة التوقيت', s_quality: 'جودة البيانات', s_ctx: 'سياق السوق', s_clarity: 'وضوح {n}%', s_agree: 'عناقيد مستقلة متفقة: {n}', s_opp: 'وزن الأصوات المعاكسة: {n}%',
  s_no_prob: 'لا تُعرض نسبة نجاح متوقعة: القوة تقيس توافق المؤشرات فقط. الدقة الفعلية في صفحة «السجل» من النتائج المسجّلة.',
  s_recent: 'آخر الإشارات', s_engine_ar: '',
  s_besthz: 'أنسب مدة مسجّلة: {s} ث (دقة {p}% في السجلات)',
  // السجل
  h_total: 'إجمالي الإشارات', h_right: 'الصحيحة', h_wrong: 'غير الصحيحة', h_acc: 'نسبة الدقة', h_ci: 'فاصل ثقة 95%: {lo}% – {hi}%', h_small: 'العينة صغيرة — النسبة غير موثوقة بعد',
  h_by_asset: 'أداء كل أصل', h_by_tf: 'أداء كل إطار زمني', h_by_strat: 'أداء كل مؤشر (دقة تصويته على الشموع الحية)',
  h_col_k: 'البند', h_col_n: 'العدد', h_col_w: 'صحيحة', h_col_acc: 'الدقة', h_col_ci: 'فاصل 95%',
  h_log: 'سجل الإشارات (آخر 200)', h_id: 'الرقم', h_asset: 'الأصل', h_dir: 'الاتجاه', h_time: 'وقت الإشارة', h_entry: 'السعر عند الإشارة', h_exit: 'السعر عند التقييم',
  h_res: 'النتيجة', h_score: 'القوة', h_why: 'السبب',
  r_win: 'صحيحة', r_loss: 'غير صحيحة', r_tie: 'تعادل', r_pending: 'قيد التقييم', r_unknown: 'غير معروفة', r_void: 'ملغاة',
  h_empty: 'لا نتائج مسجّلة بعد', h_note: 'كل الأرقام من نتائج فعلية مسجّلة على أسعار المنصة. الإطار الزمني لكل صف ورقم تسلسلي دائم: المرحلة 6.',
  h_disclaimer: 'الدقة السابقة لا تضمن النتائج القادمة. لا يوجد دليل على أن هذا النظام مربح.',
  // التنبيهات
  a_title: 'مركز التنبيهات', a_clear: 'مسح الكل', a_empty: 'لا تنبيهات',
  n_signal: 'إشارة جديدة: {a} {d} · قوة {c}', n_result_w: 'نتيجة إشارة: صحيحة', n_result_l: 'نتيجة إشارة: غير صحيحة',
  n_asset: 'تغيّر الأصل: {from} ← {to}', n_feed: 'حالة البيانات: {s}', n_reload: 'لم تُعِد المنصة الاتصال — أعد تحميل الصفحة',
  n_timing: 'محرك التوقيت: {s}', n_trend: 'تغيّر حالة السوق: {from} ← {to}', n_quality: 'جودة البيانات منخفضة: {q}%', n_conflict: 'تضارب في المؤشرات: {n}% أصوات معاكسة',
  // الإعدادات
  st_mode: 'وضع اختيار الأصل', st_mode_d: 'يدوي: يحلل الأصل الذي تثبّته فقط. متابعة المنصة: يحلل الأصل المفتوح على شارت المنصة.',
  st_manual: 'يدوي', st_follow: 'متابعة المنصة', st_manual_need: 'لا أصل لتثبيته بعد — افتح أصلًا في المنصة أولًا',
  st_tf: 'مدة الشمعة', st_tf_d: 'الأطر المتاحة الآن من التيكات الحية. تغييرها يعيد بناء الشموع من جديد. M5 إلى H1: المرحلة 4.',
  st_min: 'الحد الأدنى لقوة الإشارة', st_min_d: 'لا تصدر إشارة تحت هذه الدرجة (50–90).',
  st_lang: 'اللغة', st_lang_d: 'لغة الواجهة.',
  st_alerts: 'التنبيهات', st_toasts: 'إشعارات منبثقة', st_toasts_d: 'تظهر أعلى الشاشة عند كل حدث مفعّل.', st_sound: 'صوت التنبيه', st_sound_d: 'نغمة قصيرة مع الإشعار. قد يتطلب المتصفح نقرة في الصفحة أولًا.',
  st_types: 'أنواع التنبيهات', ty_signal: 'إشارة جديدة ونتيجتها', ty_conn: 'الاتصال وحالة البيانات', ty_asset: 'تغيّر الأصل', ty_quality: 'ضعف جودة البيانات', ty_timing: 'تغيّر حالة التوقيت', ty_trend: 'تغيّر حالة السوق', ty_conflict: 'تضارب المؤشرات',
  st_ui: 'الواجهة', st_compact: 'عرض مضغوط', st_compact_d: 'هوامش وخطوط أصغر.', st_motion: 'الحركة والانتقالات', st_motion_d: 'عطّلها لواجهة ثابتة.',
  st_conn: 'الاتصال', st_conn_d: 'المصدر الوحيد: قراءة سلبية لاتصال صفحة Pocket Option. غير موثّق رسميًا من المنصة. البوت لا يرسل أي رسالة ولا يستخدم رمز الجلسة.',
  st_conn_live: 'حية حتى', st_conn_delay: 'متأخرة حتى (بعدها يتوقف التحليل)', st_conn_unav: 'غير متاحة بعد', st_conn_ro: 'عتبات الحداثة للعرض فقط؛ تعديلها ضمن المرحلة 3.',
  st_pending: 'إعدادات لم تُبنَ بعد', st_p1: 'تفعيل وتعطيل المؤشرات — المرحلة 4', st_p2: 'أوزان التقييم من 100 — المرحلة 5', st_p3: 'الاختيار التلقائي لأفضل أصل وإطار — المرحلة 5',
  on: 'مفعّل', off: 'معطّل', sec: '{n} ث',
  // متقدم
  adv_title: 'الأدوات المتقدمة', adv_d: 'صفحات الإصدار السابق كما هي: الاستراتيجيات، المختبر، مسجّل الشموع، الذاكرة، سجل الأخطاء وأداة استكشاف بيانات المنصة. الصفقات الافتراضية مخفية من الواجهة.',
  adv_open: 'فتح الأدوات المتقدمة', adv_back: '← رجوع للواجهة', adv_errors: 'أخطاء مسجّلة: {n}', adv_store: 'تعذّر الحفظ في المتصفح',
  disclaimer: 'أداة تحليل مستقلة غير تابعة لـ Pocket Option. الإشارات ليست نصيحة مالية ولا ضمان فيها.'
};
const EN = {
  brand_sub: 'Analysis only · no execution',
  dev: 'V1.0 in development',
  nav_dash: 'Dashboard', nav_market: 'Market', nav_signals: 'Signals', nav_history: 'History', nav_alerts: 'Alerts', nav_settings: 'Settings', nav_adv: 'Advanced',
  minimize: 'Minimize', lang_switch: 'العربية', na: 'N/A', none: 'None', ago_s: '{n}s ago', ago_m: '{n}m ago', now: 'now',
  fs_disconnected: 'Disconnected', fs_connecting: 'Connecting', fs_connected: 'Connected — waiting for data', fs_live: 'Live data',
  fs_delayed: 'Delayed data', fs_stale: 'Stale data', fs_unavailable: 'Data unavailable', fs_error: 'Data error',
  tm_wait: 'WAIT', tm_analyzing: 'ANALYZING', tm_favorable: 'FAVORABLE', tm_no_trade: 'NO TRADE',
  tc_data: 'Waiting for live data from the platform', tc_history: 'Loading asset history', tc_collect: 'Collecting candles {n}/{need}', tc_first: 'Waiting for the first candle close',
  tc_stale: 'Price is stale — analysis paused', tc_signal: 'Engine conditions aligned on a signal', tc_engine: 'Engine abstained',
  tm_prelim: 'Derived from the current engine decision. Standalone timing engine and 100-point score: phase 5.',
  an_idle: 'No data', an_loading: 'Loading history', an_paused: 'Paused — data not live', an_collecting: 'Collecting candles', an_active: 'Running',
  d_bot: 'Bot status', d_bot_on: 'Running', d_bot_wait: 'Waiting for data', d_bot_sub: 'Analysis and signals only — places no trades',
  d_conn: 'Data source connection', d_src: 'Source: Pocket Option — page connection (read-only)',
  d_asset: 'Current asset', d_asset_none: 'No asset data received yet', d_locked: 'Pinned manually', d_follow: 'Following the asset open on the platform',
  d_tf: 'Timeframe', d_trend: 'Market direction', d_strength: 'Signal strength', d_strength_sub: 'Indicator agreement score — not a win probability',
  d_last: 'Last price update', d_scanned: 'Assets scanned', d_scanned_sub: 'Assets whose data arrived this session',
  d_signals: 'Signals logged', d_signals_sub: 'Last 200 kept · live total {n}',
  d_engine: 'Analysis engine', d_timing: 'Timing engine', d_recent: 'Recent analyses', d_no_recent: 'No signals logged yet',
  d_candles: '{n} candles', d_next: 'Candle closes in {n}s', d_price: 'Price',
  up: 'Up', down: 'Down', flat: 'Undetermined',
  rg_trend: 'Trending', rg_range: 'Ranging', rg_mixed: 'Mixed', rg_volatile: 'Volatile',
  m_chart: 'Chart — {a}', m_chart_sub: 'Last 90 closed candles · EMA 9 and EMA 21', m_wait: 'Waiting for data...',
  m_assets: 'Assets with received data', m_assets_note: 'The platform streams only the asset open on its chart. Open an asset there to see it here (up to {n} assets in memory).',
  m_col_asset: 'Asset', m_col_price: 'Last price', m_col_age: 'Updated', m_col_candles: 'Candles', m_col_sig: 'Last analysis', m_col_act: 'Action',
  m_lock: 'Analyze this asset only', m_unlock: 'Unpin', m_current: 'Current', m_no_assets: 'No assets yet',
  m_ohlc: 'O {o} · H {h} · L {l} · C {c}',
  s_current: 'Current signal', s_none: 'No signal now', s_call: 'CALL', s_put: 'PUT',
  s_asset: 'Asset', s_time: 'Signal time', s_tf: 'Timeframe', s_eval: 'Evaluation period', s_eval_v: 'One candle ({n}s) — the outcome is recorded at the next candle close',
  s_price: 'Price at signal', s_strength: 'Signal strength', s_pro: 'Supporting indicators', s_con: 'Opposing indicators', s_reason: 'Decision reason',
  s_timing: 'Timing state', s_quality: 'Data quality', s_ctx: 'Market context', s_clarity: 'clarity {n}%', s_agree: 'Independent clusters agreeing: {n}', s_opp: 'Opposing vote weight: {n}%',
  s_no_prob: 'No expected win rate is shown: strength only measures indicator agreement. Actual accuracy is on the History page, from recorded outcomes.',
  s_recent: 'Recent signals', s_engine_ar: 'Reason texts generated by the analysis engine are still Arabic-only; translation is planned for phase 6.',
  s_besthz: 'Best recorded duration: {s}s ({p}% accuracy in records)',
  h_total: 'Total signals', h_right: 'Correct', h_wrong: 'Incorrect', h_acc: 'Accuracy', h_ci: '95% confidence interval: {lo}% – {hi}%', h_small: 'Small sample — the rate is not reliable yet',
  h_by_asset: 'Performance by asset', h_by_tf: 'Performance by timeframe', h_by_strat: 'Performance by indicator (vote accuracy on live candles)',
  h_col_k: 'Item', h_col_n: 'Count', h_col_w: 'Correct', h_col_acc: 'Accuracy', h_col_ci: '95% CI',
  h_log: 'Signal log (last 200)', h_id: 'ID', h_asset: 'Asset', h_dir: 'Direction', h_time: 'Signal time', h_entry: 'Price at signal', h_exit: 'Price at evaluation',
  h_res: 'Outcome', h_score: 'Strength', h_why: 'Reason',
  r_win: 'Correct', r_loss: 'Incorrect', r_tie: 'Tie', r_pending: 'Pending', r_unknown: 'Unknown', r_void: 'Voided',
  h_empty: 'No recorded outcomes yet', h_note: 'All figures come from actual outcomes recorded on platform prices. Per-row timeframe and a permanent serial number: phase 6.',
  h_disclaimer: 'Past accuracy does not guarantee future results. There is no evidence that this system is profitable.',
  a_title: 'Alert center', a_clear: 'Clear all', a_empty: 'No alerts',
  n_signal: 'New signal: {a} {d} · strength {c}', n_result_w: 'Signal outcome: correct', n_result_l: 'Signal outcome: incorrect',
  n_asset: 'Asset changed: {from} → {to}', n_feed: 'Data status: {s}', n_reload: 'The platform has not reconnected — reload the page',
  n_timing: 'Timing engine: {s}', n_trend: 'Market state changed: {from} → {to}', n_quality: 'Low data quality: {q}%', n_conflict: 'Indicator conflict: {n}% opposing votes',
  st_mode: 'Asset selection mode', st_mode_d: 'Manual: analyzes only the asset you pin. Follow platform: analyzes the asset open on the platform chart.',
  st_manual: 'Manual', st_follow: 'Follow platform', st_manual_need: 'No asset to pin yet — open one on the platform first',
  st_tf: 'Candle duration', st_tf_d: 'Timeframes available now from live ticks. Changing it rebuilds candles from scratch. M5 to H1: phase 4.',
  st_min: 'Minimum signal strength', st_min_d: 'No signal is issued below this score (50–90).',
  st_lang: 'Language', st_lang_d: 'Interface language.',
  st_alerts: 'Alerts', st_toasts: 'Pop-up notifications', st_toasts_d: 'Shown at the top of the screen for each enabled event.', st_sound: 'Alert sound', st_sound_d: 'A short tone with the notification. The browser may require a click on the page first.',
  st_types: 'Alert types', ty_signal: 'New signal and its outcome', ty_conn: 'Connection and data status', ty_asset: 'Asset change', ty_quality: 'Low data quality', ty_timing: 'Timing state change', ty_trend: 'Market state change', ty_conflict: 'Indicator conflict',
  st_ui: 'Interface', st_compact: 'Compact view', st_compact_d: 'Smaller spacing and type.', st_motion: 'Motion and transitions', st_motion_d: 'Turn off for a static interface.',
  st_conn: 'Connection', st_conn_d: 'Single source: passive reading of the Pocket Option page connection. Not officially documented by the platform. The bot sends no messages and does not use the session token.',
  st_conn_live: 'Live up to', st_conn_delay: 'Delayed up to (analysis stops after)', st_conn_unav: 'Unavailable after', st_conn_ro: 'Freshness thresholds are read-only here; editing them is part of phase 3.',
  st_pending: 'Settings not built yet', st_p1: 'Enable/disable indicators — phase 4', st_p2: '100-point score weights — phase 5', st_p3: 'Automatic best asset and timeframe selection — phase 5',
  on: 'On', off: 'Off', sec: '{n}s',
  adv_title: 'Advanced tools', adv_d: 'Pages from the previous version, unchanged: strategies, lab, candle recorder, memory, error log and the platform data discovery tool. Virtual trades are hidden from the interface.',
  adv_open: 'Open advanced tools', adv_back: '← Back to interface', adv_errors: 'Logged errors: {n}', adv_store: 'Could not save to browser storage',
  disclaimer: 'Independent analysis tool, not affiliated with Pocket Option. Signals are not financial advice and carry no guarantee.'
};
const DICT = { ar: AR, en: EN };
const LANGS = ['ar', 'en'];
function t(lang, key, vars) {
  const d = DICT[lang] || AR;
  let s = d[key];
  if (s === undefined) s = AR[key];
  if (s === undefined) return key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => vars[k] === undefined || vars[k] === null ? '' : String(vars[k])) : s;
}
module.exports = { DICT, LANGS, t };
},
/* ---- ui/shell.js ---- */
"ui/shell": function (module, exports, require) {
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
  <div class="brand">${letters(NAME)}<i class="dot"></i><small>v4.0 (تطوير) · محاكاة فقط</small></div>
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
    <div class="card" id="feedCard" data-v4>
      <h3>اتصال المنصة وحالة البيانات <span class="chip" id="feedBadge">—</span></h3>
      <ul class="checks" id="feedPipe"></ul>
      <div class="note" id="feedWhy"></div>
      <div class="stats" id="feedSt"></div>
      <div class="note" id="feedNote"></div>
    </div>
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
  <div class="card" data-v4>
    <h3>استكشاف بيانات المنصة (تشخيص)</h3>
    <div class="note">تسجّل هذه الأداة <b>أسماء</b> الرسائل التي تصل من المنصة و<b>بنيتها</b> (الأنواع والمفاتيح) لمعرفة الصيغ الحقيقية بدل تخمينها. لا تسجّل قيم أي رسالة فيها مفتاح يوحي بالحساب أو الهوية (رصيد، بريد، مستخدم، جلسة…)، ولا الرسائل الصادرة، ولا عناوين الاتصال الكاملة. تتوقف تلقائيًا بعد 10 دقائق. راجع الملف قبل مشاركته.</div>
    <div class="row"><button class="tgl" id="discOn">بدء الاستكشاف</button><button id="discExp">تصدير التقرير</button></div>
    <div class="note" id="discSt"></div>
  </div>
  <div class="card" data-v4>
    <h3>رسائل المنصة والأخطاء في البيانات</h3>
    <div class="stats" id="feedMsgs"></div>
    <div class="scroll"><table><thead><tr><th>الحدث</th><th>العدد</th><th>النوع</th></tr></thead><tbody id="feedEv"></tbody></table></div>
    <div class="scroll"><table><thead><tr><th>رسالة أرسلتها المنصة نفسها (الاسم فقط)</th><th>العدد</th></tr></thead><tbody id="feedOut"></tbody></table></div>
    <div class="note" id="feedUnp"></div>
    <div class="scroll"><table><thead><tr><th>سبب رفض التيك</th><th>العدد</th></tr></thead><tbody id="feedRej"></tbody></table></div>
    <div class="scroll"><table><thead><tr><th>الوقت</th><th>خطأ تحليل رسالة</th></tr></thead><tbody id="feedErr"></tbody></table></div>
  </div>
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
// opts.embedded (V1.0): تُعرض هذه الصفحات كقسم «متقدم» داخل الواجهة الجديدة (ui/shell.js): بلا شاشة بداية ولا وميض ولا نافذة مصغّرة،
// وتُخفى عناصر الصفقات الافتراضية (الكود باقٍ، والعناصر باقية في DOM). زر «تصغير» يصبح «رجوع» ويستدعي opts.onBack.
const EMB_CSS = '#simCard,#auto,#kill,.splash,.flash,.mini{display:none!important}';
function buildUI(app, opts) {
  const doc = app.doc, win = app.win, emb = !!(opts && opts.embedded);
  if (doc.getElementById('wsnf25-host')) return null;
  const host = doc.createElement('div');
  host.id = 'wsnf25-host';
  doc.documentElement.appendChild(host);
  const sh = host.attachShadow({ mode: 'open' });
  sh.innerHTML = '<style>' + CSS + (emb ? EMB_CSS : '') + '</style>' + HTML;
  if (emb) host.style.display = 'none';
  const $ = id => sh.getElementById(id);
  const ui = app.prefs.get(UI_KEY, { min: false, x: 12, y: 90 });
  const full = $('full'), mini = $('mini'), flash = $('flash'), fbox = $('fbox'), splash = $('splash');
  const st0 = app.vm.settings();
  $('cs').value = st0.minConf; $('po').value = Math.round(st0.payout * 100); $('tf').value = String(st0.tf);

  win.setTimeout(() => splash.classList.add('out'), 3000);
  win.setTimeout(() => { splash.style.display = 'none'; }, 3900);

  const setMin = m => {
    if (emb) { ui.min = false; if (m && opts.onBack) opts.onBack(); return; }
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
  const tappedOk = app.tapped !== false;
  $('discOn').onclick = () => { if (app.discovery.status().on) app.discovery.stop(); else app.discovery.start(); paint(); };
  $('discExp').onclick = () => app.downloadText('wsnf-platform-discovery-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.json', JSON.stringify(app.discovery.report(), null, 1), 'application/json');
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
    if (emb) return; // التنبيهات تعرضها الواجهة الجديدة
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
  const FEED_CLS = { live: 'c-u', delayed: 'c-g', connected: 'c-g', connecting: 'c-g', stale: 'c-d', unavailable: 'c-d', disconnected: 'c-d', error: 'c-d' };
  const NA = '<span class="note">غير متاح</span>';
  const ago = ms => ms === null || ms === undefined ? NA : ms < 1000 ? 'الآن' : ms < 60000 ? Math.round(ms / 1000) + ' ث' : ms < 36e5 ? Math.round(ms / 60000) + ' د' : Math.round(ms / 36e5) + ' س';
  function paintFeed(V) {
    const f = app.vm.feed(), shown = app.readShown(), dq = V.dq;
    $('feedBadge').textContent = f.label;
    $('feedBadge').className = 'chip ' + (FEED_CLS[f.status] || 'c-m');
    const st = (k, v, s, cls) => `<div class="st"><span>${k}</span><b class="${cls || ''}">${v}</b>${s ? '<small>' + s + '</small>' : ''}</div>`;
    $('feedSt').innerHTML =
      st('الحالة', ESC(f.label), 'منذ ' + ago(Date.now() - f.since), f.status === 'live' ? 'w' : f.status === 'delayed' || f.status === 'connected' || f.status === 'connecting' ? 'warn' : 'l') +
      st('مصدر البيانات', f.source === 'platform-ws' ? 'Pocket Option' : ESC(f.source), 'WebSocket الصفحة — قراءة فقط') +
      st('الأصل المحلَّل', f.asset ? ESC(f.asset) : NA, 'المعروض في الصفحة: ' + (shown ? ESC(shown) : 'غير متاح')) +
      st('آخر سعر', f.lastPrice != null ? f.lastPrice : NA, f.lastTs ? 'وقت المنصة ' + new Date(f.lastTs * 1000).toLocaleTimeString('ar', { hour12: false }) : '') +
      st('آخر تحديث', ago(f.ageMs), f.latencyMs != null ? 'تأخر نسبي ' + f.latencyMs + ' ms · ساعة المنصة ' + (f.clockOffsetS >= 0 ? '+' : '') + f.clockOffsetS + ' ث عن جهازك' : '') +
      st('التيكات', f.ticks.ok, 'مستلمة ' + f.ticks.rx + ' · مكررة ' + f.ticks.dup + ' · مرفوضة ' + f.ticks.rej, f.ticks.rej ? 'warn' : '') +
      st('الشموع المعالجة', f.candles, 'حية منذ تشغيل الصفحة') +
      st('جودة البيانات', dq ? dq.q + '%' : NA, dq && dq.issues.length ? ESC(dq.issues.join(' | ')) : '', dq && dq.q < V.cfg.minQ ? 'l' : '') +
      st('الاتصال', f.open + ' مفتوح', 'إعادة اتصال ' + f.reconnects + ' · انقطاع كلي ' + ago(f.downMs), f.open ? '' : 'l');
    const P = f.pipeline, SL = { connected: 'متصل بالمنصة', authenticated: 'تم تسجيل الدخول (successauth)', subscribed: 'اشتراك في أصل (changeSymbol)', receiving: 'تصل رسائل الأسعار', valid: 'البيانات صالحة وحديثة' };
    let blocked = false;
    $('feedPipe').innerHTML = Object.keys(SL).map(k => {
      const s = P.stages[k], ok = s.ok && !blocked; if (!s.ok) blocked = true;
      return `<li class="${ok ? 'ok' : 'no'}"><b>${ok ? '✔' : '✖'}</b><span>${SL[k]} — <small class="note">${ESC(s.detail)}</small></span></li>`;
    }).join('');
    $('feedWhy').innerHTML = P.why ? '<span class="l">⚠ التشخيص: ' + ESC(P.why) + '</span>' : '<span class="w">✔ خط البيانات سليم من الاتصال حتى التيك الصالح.</span>';
    $('feedNote').innerHTML = (f.reloadAdvice ? '<span class="l">⚠ لم تُعِد المنصة الاتصال: أعد تحميل الصفحة.</span> ' : '') +
      (tappedOk ? '' : '<span class="l">⚠ لم يُركَّب مراقب WebSocket: لن تصل أي بيانات. أعد تحميل الصفحة.</span> ') +
      '«بيانات حية» تظهر فقط عند وصول تيك صالح للأصل خلال آخر 3 ث عبر اتصال مفتوح؛ الاتصال وحده لا يكفي.';
    if (sh.querySelector('.p-err.on')) {
      const D = app.discovery.status();
      $('discOn').textContent = D.on ? 'إيقاف الاستكشاف' : 'بدء الاستكشاف';
      $('discOn').classList.toggle('on', D.on);
      $('discSt').textContent = D.on ? 'يعمل منذ ' + ago(Date.now() - D.startedAt) + ' · رسائل ' + D.messages + ' · أنواع ' + D.types : D.messages ? 'متوقف (' + (D.stopReason || '') + ') · رسائل ' + D.messages + ' · أنواع ' + D.types : 'غير مفعّل';
      $('feedMsgs').innerHTML = st('رسائل مستلمة', f.msgs, Math.round(f.bytes / 1024) + ' KB') + st('اتصالات', f.conns.length, 'مفتوحة ' + f.open) + st('أخطاء تحليل', f.parseErrors.length, '', f.parseErrors.length ? 'warn' : '') +
        st('التاريخ', f.hist.ok, 'تحميلات ' + f.hist.loads + ' · مرفوضة ' + f.hist.rej, f.hist.rej ? 'warn' : '');
      const ev = Object.entries(f.known).map(([k, n]) => [k, n, 'مقروء']).concat(Object.entries(f.unknown).map(([k, n]) => [k, n, 'غير مقروء'])).sort((a, b) => b[1] - a[1]);
      $('feedEv').innerHTML = ev.slice(0, 40).map(([k, n, t]) => `<tr><td style="direction:ltr;text-align:left">${ESC(k)}</td><td>${n}</td><td class="${t === 'مقروء' ? 'w' : 'note'}">${t}</td></tr>`).join('') || '<tr><td colspan="3" class="note">لم تصل رسائل بعد</td></tr>';
      $('feedOut').innerHTML = Object.entries(f.outgoing).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, n]) => `<tr><td style="direction:ltr;text-align:left">${ESC(k)}</td><td>${n}</td></tr>`).join('') || '<tr><td colspan="2" class="note">لم تُرصد رسائل صادرة بعد</td></tr>';
      $('feedUnp').innerHTML = 'أصول معروفة من updateAssets: ' + f.assetsKnown + ' · إطارات ثنائية دون حدث ينتظرها: ' + f.unpaired.n +
        (f.unpaired.skeletons.length ? '<br><span style="direction:ltr;display:inline-block">' + f.unpaired.skeletons.map(ESC).join('<br>') + '</span>' : '') +
        (f.env ? '<br>Worker في الصفحة: ' + f.env.workers + ' · iframe: ' + f.env.frames : '');
      const rj = Object.entries(f.ticks.reasons).concat(Object.entries(f.hist.reasons).map(([k, n]) => ['تاريخ: ' + k, n]));
      $('feedRej').innerHTML = rj.map(([k, n]) => `<tr><td>${ESC(k)}</td><td>${n}</td></tr>`).join('') || '<tr><td colspan="2" class="note">لا شيء</td></tr>';
      $('feedErr').innerHTML = f.parseErrors.slice().reverse().map(e => `<tr><td>${new Date(e.at).toTimeString().slice(0, 8)}</td><td>${ESC(e.why)}</td></tr>`).join('') || '<tr><td colspan="2" class="note">لا أخطاء</td></tr>';
    }
  }
  function paint() {
    const V = app.vm.view(app.readShown()), R = app.vm.recorder(), r = V.r, d = r ? r.d : 'none', st = V.st, C = V.cfg;
    const col = d === 'call' ? '#3ddbb0' : d === 'put' ? '#ff6b7a' : '#f5c45e';
    paintFeed(V);
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
  if (emb) { ui.min = false; splash.style.display = 'none'; $('min').textContent = opts.backLabel || '←'; }
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
