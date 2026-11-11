// Loads the ORIGINAL userscript unmodified in Node with minimal browser stubs.
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(process.argv[2], 'utf8');
function load() {
  const store = {};
  let now = 1.7e12;
  const ctx = {
    console: { warn() {}, log() {} },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    document: { readyState: 'complete', addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], visibilityState: 'visible' },
    setInterval: () => 0, setTimeout: () => 0, clearTimeout() {},
    TextDecoder, Blob: class {}, Promise, JSON, Math, Date: class extends Date { static now() { return now; } constructor(...a) { a.length ? super(...a) : super(now); } },
    Number, String, Object, Array, Set, Map, Error, RegExp, isFinite, parseFloat,
  };
  ctx.window = ctx; ctx.window.__WSNF25_NOUI = true; ctx.window.addEventListener = () => {};
  ctx.window.WebSocket = undefined;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { W: ctx.window.__WSNF25, setNow: t => { now = t; }, store };
}
module.exports = load;
