'use strict';
// يشغّل نفس الاختبارات على النسخة الأصلية والمعدّلة ويطبع جدول قبل/بعد.
// الاستخدام: node test/compare.js [--stats] [--md out.md]
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const files = ['safety', 'bugs', 'regression'].concat(process.argv.includes('--stats') ? ['stats'] : []).map(f => path.join(__dirname, f + '.test.js'));
function run(target) {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { env: { ...process.env, WSNF_TARGET: target }, encoding: 'utf8', maxBuffer: 1e8 });
  const res = {};
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(not ok|ok) \d+ - (.+?)\s*(#.*)?$/.exec(line);
    if (m && !/\.test\.js$/.test(m[2])) res[m[2]] = m[1] === 'ok';
  }
  const st = (r.stdout.match(/\[stats\].*/g) || []).join(' ');
  return { res, st };
}
const before = run('original'), after = run('current');
const names = [...new Set([...Object.keys(after.res), ...Object.keys(before.res)])];
const mark = v => v === undefined ? '—' : v ? 'PASS' : 'FAIL';
const rows = names.map(n => `| ${n} | ${mark(before.res[n])} | ${mark(after.res[n])} |`);
const count = o => Object.values(o).filter(Boolean).length + '/' + Object.keys(o).length;
const md = ['| الاختبار | قبل (v3.3 الأصلية) | بعد (المعدّلة) |', '|---|---|---|', ...rows, '', `**الإجمالي:** قبل ${count(before.res)} — بعد ${count(after.res)}`,
  before.st ? '\nقبل: `' + before.st + '`' : '', after.st ? '\nبعد: `' + after.st + '`' : ''].join('\n');
console.log(md);
const i = process.argv.indexOf('--md');
if (i > 0) fs.writeFileSync(process.argv[i + 1], md + '\n');
const regFail = names.filter(n => /^R\d/.test(n) && before.res[n] === true && after.res[n] !== true);
const anyFail = Object.values(after.res).some(v => !v);
if (regFail.length) console.error('REGRESSION:', regFail);
process.exit(anyFail || regFail.length ? 1 : 0);
