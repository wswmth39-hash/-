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
