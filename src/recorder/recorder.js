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
