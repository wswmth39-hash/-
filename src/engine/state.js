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
