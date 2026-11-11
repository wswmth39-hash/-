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
