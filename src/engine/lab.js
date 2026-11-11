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
