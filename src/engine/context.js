'use strict';
// سياق المحرك: يربط أجزاءه (التخزين، المحاكاة، المختبر، المسجّل، العرض) دون متغيرات عامة.
// - كل جزء يسجّل دواله بـ provide({...}) ويعلن صراحةً ما يحتاجه من غيره بـ use('name', ...).
//   الربط متأخر (عند الاستدعاء)، فلا يهم ترتيب تركيب الأجزاء، وأي اعتماد ناقص يظهر كخطأ صريح لا كـ undefined.
// - البيئة env تُحقن من الخارج: الساعة now()، التخزين storage (واجهة localStorage)، indexedDB، وconsole.
//   في المتصفح تأتي من window؛ في الاختبارات من بدائل مضبوطة.
function createContext(env) {
  const fn = {};
  const listeners = {};
  const E = {
    env,
    fn,
    clock: env.now || (() => Date.now()),
    provide(obj) {
      for (const k in obj) {
        if (Object.prototype.hasOwnProperty.call(fn, k)) throw new Error('engine: duplicate provider for ' + k);
        fn[k] = obj[k];
      }
    },
    use(...names) {
      return names.map(n => (...a) => {
        const f = fn[n];
        if (typeof f !== 'function') throw new Error('engine: missing dependency ' + n);
        return f(...a);
      });
    },
    // ناقل أحداث بسيط: المحرك يُصدر، الواجهة والمسجّل يستمعان. خطأ مستمع لا يوقف المحرك.
    on(type, f) { (listeners[type] = listeners[type] || []).push(f); return () => { listeners[type] = listeners[type].filter(x => x !== f); }; },
    emit(type, payload) {
      for (const f of listeners[type] || []) { try { f(payload); } catch (e) { try { env.console && env.console.warn('[wsnf] listener', type, e); } catch (_) {} } }
    }
  };
  return E;
}
module.exports = { createContext };
