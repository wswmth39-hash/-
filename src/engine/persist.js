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
