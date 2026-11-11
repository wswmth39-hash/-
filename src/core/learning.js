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
