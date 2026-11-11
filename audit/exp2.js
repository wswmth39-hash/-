const load = require('./harness');
function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }
let tot = { n: 0, w: 0 }, falseModes = {}, regimeCells = 0, regimeFalse = 0, flips = 0;
for (let seed = 1; seed <= +process.argv[3]; seed++) {
  const { W, setNow } = load(process.argv[2]); const { S, getA } = W;
  const r = rng(seed * 101); let p = 1.1; const t0 = 1.7e9; const ticks = [];
  for (let s = 0; s < 86400 * 3; s++) { p *= 1 + gauss(r) * 4e-5; ticks.push([t0 + s + .3, +p.toFixed(5)]); }
  W.handle('hist', { asset: 'X', history: ticks.slice(0, 43200) }); S.wsUp = true;
  for (const [ts, px] of ticks.slice(43200)) { setNow(ts * 1000); W.feedTick('X', ts, px); }
  const A = getA('X'); tot.n += A.e.ln; tot.w += A.e.lw;
  for (const k in A.s) { const isR = k.includes('#'); const g = isR ? W.wt(A, k) : W.wt(A, k);
    if (isR) { if (g.n >= 60) { regimeCells++; if (g.mode === 'رابحة' || g.mode === 'عكسية') regimeFalse++; } continue; }
    if (g.mode === 'رابحة' || g.mode === 'عكسية' || g.mode === 'معطلة') falseModes[g.mode] = (falseModes[g.mode] || 0) + 1; }
  flips += S.svLog.length;
}
console.log('RANDOM WALK, seeds:', process.argv[3]);
console.log('pooled live emitted signals n=', tot.n, 'win=', (tot.w / tot.n).toFixed(3));
console.log('strategies wrongly labelled (should all be neutral):', JSON.stringify(falseModes), 'out of', 23 * process.argv[3]);
console.log('regime cells n>=60:', regimeCells, 'labelled winning/inverse by chance:', regimeFalse);
console.log('variant switches old->new (on pure noise):', flips);
