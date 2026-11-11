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
