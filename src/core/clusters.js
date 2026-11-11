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
