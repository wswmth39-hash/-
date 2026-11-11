'use strict';
// اختبار ضابط إحصائي: على حركة عشوائية بحتة لا توجد أي أفضلية. أي نظام سليم يجب أن:
// (1) لا يُظهر نسبة نجاح تختلف جوهريًا عن 50%،  (2) لا يصنّف استراتيجيات «رابحة/معطلة» بكثرة بسبب الصدفة.
// بطيء نسبيًا (~1 دقيقة). شغّله مع: npm run test:stats
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness');

const SEEDS = +(process.env.WSNF_SEEDS || 8);
let cache = null;
function run() {
  if (cache) return cache;
  const out = { n: 0, w: 0, labels: {}, cells: 0, flips: 0, strategies: 0 };
  for (let seed = 1; seed <= SEEDS; seed++) {
    const B = H.load();
    H.runFeed(B, 'X', H.randomWalkTicks(seed * 101, 86400 * 3), 43200);
    const A = B.W.getA('X');
    out.n += A.e.ln; out.w += A.e.lw;
    for (const k in A.s) {
      if (k.includes('#')) continue;
      out.strategies++;
      const g = B.W.wt(A, k);
      if (g.mode === 'رابحة' || g.mode === 'عكسية' || g.mode === 'معطلة') out.labels[g.mode] = (out.labels[g.mode] || 0) + 1;
    }
    out.flips += (B.W.S.svLog || []).length;
  }
  cache = out;
  console.log('[stats]', SEEDS, 'seeds:', JSON.stringify(out));
  return out;
}

test('ST1 نسبة نجاح الإشارات على الحركة العشوائية لا تختلف جوهريًا عن 50%', () => {
  const o = run();
  assert.ok(o.n >= 30, 'عينة صغيرة: ' + o.n);
  const p = o.w / o.n, z = (p - .5) / Math.sqrt(.25 / o.n);
  assert.ok(Math.abs(z) < 3, 'p=' + p.toFixed(3) + ' z=' + z.toFixed(2));
});

test('ST2 تصنيفات «رابحة/عكسية/معطلة» بالصدفة نادرة (≤ 3% من الحالات)', () => {
  const o = run();
  const bad = Object.values(o.labels).reduce((a, b) => a + b, 0);
  assert.ok(bad / o.strategies <= .03, bad + ' من ' + o.strategies + ' ' + JSON.stringify(o.labels));
});
