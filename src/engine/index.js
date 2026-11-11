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
