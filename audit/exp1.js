const load = require('./harness');
const { W, setNow } = load(process.argv[2]);
const { S, CFG, analyze, getA } = W;
// 1) Flat/frozen prices -> RSI bug
const flat = []; for (let i = 0; i < 300; i++) flat.push({ t: i * 60, o: 1, h: 1, l: 1, c: 1 });
const rsiF = W.rawVotes ? W.rawVotes(flat) : null;
console.log('flat-market raw votes (non-zero):', Object.entries(rsiF).filter(([k, v]) => v).map(([k, v]) => k + '=' + v).join(' '));
// 2) Random-walk ticks: run the full pipeline (history replay -> live), count signals and win rate
function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }
const r = rng(+process.argv[3] || 7);
let p = 1.1, t0 = 1.7e9; const ticks = [];
for (let s = 0; s < 60 * 60 * 24 * 3; s += 1) { p *= 1 + gauss(r) * 0.00004; ticks.push([t0 + s + 0.3, +p.toFixed(5)]); }
const hist = ticks.slice(0, 60 * 60 * 12);
W.handle('hist', { asset: 'EURUSD_otc', history: hist });
S.wsUp = true;
const live = ticks.slice(hist.length);
for (const [ts, px] of live) { setNow(ts * 1000); W.feedTick('EURUSD_otc', ts, px); }
const log = S.log; const done = log.filter(e => e.win !== null);
const A = getA('EURUSD_otc');
console.log('live signals logged:', log.length, '(log capped at 200) settled:', done.length, 'wins:', done.filter(e => e.win).length);
console.log('A.e live n/w:', A.e.ln, A.e.lw, ' rate:', (A.e.lw / A.e.ln).toFixed(3), ' hist n/w:', A.e.hn, A.e.hw);
const calls = log.filter(e => e.dir === 'call').length; console.log('call/put in log:', calls, log.length - calls);
const conf = {}; log.forEach(e => conf[e.conf] = (conf[e.conf] || 0) + 1); console.log('conf distribution:', JSON.stringify(conf));
const modes = {}; for (const k in A.s) { if (k.includes('#')) continue; const g = W.wt(A, k); modes[k] = g.mode + ' n=' + g.n + ' p=' + g.p.toFixed(3); }
console.log('strategy grades on RANDOM WALK:'); console.log(modes);
console.log('audit:', JSON.stringify(S.audit));
console.log('gate on last:', JSON.stringify(W.gate(S.sigBy['EURUSD_otc'], A)));
