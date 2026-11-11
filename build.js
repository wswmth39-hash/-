'use strict';
// يبني dist/wsnf.user.js من وحدات src/ (CommonJS) بلا أي مكتبة خارجية.
// كل وحدة تُغلَّف في دالة مستقلة لها نطاقها الخاص (لا متغيرات عامة مشتركة)، ويُحَلّ require بمسار نسبي.
// الاستخدام: node build.js         ← يكتب dist/wsnf.user.js
//            node build.js --check ← يفشل إن كان dist غير مطابق لـ src (يُستخدم في الاختبارات)
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src');
const OUT = path.join(__dirname, 'dist', 'wsnf.user.js');
const ENTRY = 'main';

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : d.name.endsWith('.js') ? [p] : [];
  }).sort();
}

function build() {
  const header = fs.readFileSync(path.join(SRC, 'header.txt'), 'utf8').trimEnd();
  const mods = walk(SRC).map(f => ({ id: path.relative(SRC, f).replace(/\\/g, '/').replace(/\.js$/, ''), code: fs.readFileSync(f, 'utf8') }));
  if (!mods.some(m => m.id === ENTRY)) throw new Error('missing src/' + ENTRY + '.js');
  for (const m of mods) {
    if (/\b(import|export)\s/.test(m.code.replace(/\/\/.*$/gm, '').replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, ''))) throw new Error('ES module syntax not supported in ' + m.id);
  }
  const defs = mods.map(m => '/* ---- ' + m.id + '.js ---- */\n' + JSON.stringify(m.id) + ': function (module, exports, require) {\n' + m.code.trimEnd() + '\n}').join(',\n');
  return header + `
// هذا الملف مولَّد آليًا من src/ بواسطة build.js — لا تعدّله مباشرة.
(function () {
'use strict';
const __defs = {
${defs}
};
const __cache = {};
function __resolve(from, p) {
  if (p[0] !== '.') throw new Error('only relative requires are supported: ' + p);
  const parts = from.split('/').slice(0, -1);
  for (const s of p.split('/')) { if (s === '..') parts.pop(); else if (s !== '.') parts.push(s); }
  return parts.join('/').replace(/\\.js$/, '');
}
function __load(id) {
  if (__cache[id]) return __cache[id].exports;
  if (!__defs[id]) throw new Error('module not found: ' + id);
  const module = __cache[id] = { exports: {} };
  __defs[id].call(undefined, module, module.exports, p => __load(__resolve(id, p)));
  return module.exports;
}
__load(${JSON.stringify(ENTRY)});
})();
`;
}

if (require.main === module) {
  const out = build();
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (cur !== out) { console.error('dist/wsnf.user.js is out of date: run node build.js'); process.exit(1); }
    console.log('dist is up to date');
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, out);
    console.log('built', path.relative(__dirname, OUT), out.length, 'bytes');
  }
}
module.exports = { build, OUT };
