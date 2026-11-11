// فحص بسيط: معرّفات مستخدمة في كل وحدة لكنها غير معرّفة فيها (ولا هي من المتغيرات العامة للغة/المتصفح)
const fs = require('fs'), path = require('path');
const GLOBALS = new Set('Math JSON Number String Object Array Set Map Promise Error RegExp Date Symbol Infinity NaN undefined isFinite parseFloat parseInt console window document setTimeout clearTimeout setInterval clearInterval TextDecoder TextEncoder module exports require true false null this new typeof instanceof return if else for while do const let var function of in break continue throw try catch finally switch case default delete void class extends super async await yield arguments devicePixelRatio Blob URL FileReader getComputedStyle localStorage indexedDB IDBKeyRange EventTarget'.split(' '));
function strip(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ')
    .replace(/`(?:\\[\s\S]|\$\{(?:[^{}]|\{[^{}]*\})*\}|[^`\\])*`/g, m => ' ' + (m.match(/\$\{((?:[^{}]|\{[^{}]*\})*)\}/g) || []).map(x => x.slice(2, -1)).join(' ; ') + ' ')
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, '""').replace(/\/(?![*\/])(?:\\.|\[(?:\\.|[^\]])*\]|[^\/\n\\\[])+\/[gimsuy]*/g, '0');
}
let bad = 0;
for (const f of process.argv.slice(2)) {
  const code = strip(fs.readFileSync(f, 'utf8'));
  const declared = new Set();
  for (const m of code.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  // تعريفات متعددة بفواصل: const a = 1, b = 2 — نمسح على عمق 0 ونأخذ الاسم بعد كل فاصلة
  for (const m of code.matchAll(/\b(?:const|let|var)\s+/g)) {
    let i = m.index + m[0].length, depth = 0, expectName = true;
    for (; i < code.length; i++) {
      const ch = code[i];
      if (expectName && depth === 0) { const nm = /^[A-Za-z_$][\w$]*/.exec(code.slice(i)); if (nm) { declared.add(nm[0]); i += nm[0].length - 1; expectName = false; continue; } }
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) { if (depth === 0) break; depth--; }
      else if (ch === ',' && depth === 0) expectName = true;
      else if ((ch === ';' || ch === '\n') && depth === 0 && !/[,=+\-*/?:&|(]\s*$/.test(code.slice(Math.max(0, i - 40), i))) break;
    }
  }
  // أسماء خصائص/طرق داخل كائنات حرفية: name(...) { و get name() {
  for (const m of code.matchAll(/^\s*(?:get\s+|set\s+|async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) declared.add(m[1]);
  ['get', 'set'].forEach(x => declared.add(x));
  for (const m of code.matchAll(/\b(?:const|let|var)\s*[\[{]([^=]*?)[\]}]\s*=/g)) m[1].split(/[,\s:]+/).forEach(x => { const n = x.replace(/=.*$/, '').replace(/\.\.\./, '').trim(); if (n) declared.add(n); });
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>|\bfunction\s*[\w$]*\s*\(([^()]*)\)|\b([A-Za-z_$][\w$]*)\s*=>|catch\s*\((\w+)\)|for\s*\(\s*(?:const|let)\s*(?:\[([^\]]*)\]|\{([^}]*)\}|(\w+))/g)) {
    [m[1], m[2], m[3], m[4], m[5], m[6], m[7]].filter(Boolean).forEach(s => s.split(',').forEach(p => { const n = p.replace(/=.*$/, '').replace(/[\[\]{}.\s]/g, '').split(':').pop(); if (n) declared.add(n); }));
  }
  const used = new Set();
  for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\b(?!\s*:(?!:))/g)) used.add(m[1]);
  const miss = [...used].filter(x => !declared.has(x) && !GLOBALS.has(x) && !/^\d/.test(x));
  if (miss.length) { bad++; console.log(path.relative(process.cwd(), f) + ': ' + miss.join(', ')); }
}
process.exit(bad ? 1 : 0);
