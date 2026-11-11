'use strict';
// النواة — المؤشرات الفنية وأنماط الشموع والقمم/القيعان.
// كلها دوال بحتة: المدخل مصفوفة شموع مغلقة مرتبة زمنيًا {t,o,h,l,c} أو مصفوفة أسعار، والمخرج قيمة محسوبة منها فقط.
// لا تقرأ أي حالة عامة ولا إعدادات: كل معامل (مثل مدة الشمعة tf) يُمرَّر صراحةً.
// ================= المؤشرات =================
const ema = (a, n) => {
  const k = 2 / (n + 1); let e = a[0]; const o = [e];
  for (let i = 1; i < a.length; i++) { e = a[i] * k + e * (1 - k); o.push(e); }
  return o;
};
// v3.4: RSI بطريقة Wilder (التنعيم الأسي القياسي الذي صُممت له عتبتا 30/70). كان متوسطًا بسيطًا،
// وكان يعطي 100 عند سكون السعر (لا ربح ولا خسارة) فيصدر إشارة بيع كاذبة. الصحيح عند السكون = 50.
const rsiVal = (g, l) => (g === 0 && l === 0) ? 50 : l === 0 ? 100 : 100 - 100 / (1 + g / l);
const rsiSeries = (c, n = 14) => {
  const out = new Array(c.length).fill(50);
  if (c.length <= n) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n; out[n] = rsiVal(g, l);
  for (let i = n + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (n - 1) + (d > 0 ? d : 0)) / n; l = (l * (n - 1) + (d < 0 ? -d : 0)) / n;
    out[i] = rsiVal(g, l);
  }
  return out;
};
const rsi = (c, n = 14) => { const r = rsiSeries(c, n); return r[r.length - 1]; };
const atr = (cs, n = 14) => {
  let s = 0;
  for (let i = cs.length - n; i < cs.length; i++) {
    const x = cs[i], p = cs[i - 1];
    s += Math.max(x.h - x.l, Math.abs(x.h - p.c), Math.abs(x.l - p.c));
  }
  return s / n;
};
const hl = (cs, n) => { const w = cs.slice(-n); return [Math.max(...w.map(x => x.h)), Math.min(...w.map(x => x.l))]; };
const eff = (c, n = 20) => {
  let p = 0;
  for (let i = c.length - n; i < c.length; i++) p += Math.abs(c[i] - c[i - 1]);
  return p === 0 ? 0 : Math.abs(c[c.length - 1] - c[c.length - 1 - n]) / p;
};
// v3.4: الدوجي (إغلاق = افتتاح) ليس صاعدًا ولا هابطًا. كان !bull يُستخدم بمعنى «هابطة» فيُحسب الدوجي هابطًا.
const body = x => Math.abs(x.c - x.o), rng = x => Math.max(x.h - x.l, 1e-12), bull = x => x.c > x.o, bear = x => x.c < x.o;
const upw = x => x.h - Math.max(x.o, x.c), low = x => Math.min(x.o, x.c) - x.l;
// ATR مرجعي: متوسط المدى الحقيقي على ما يصل إلى 100 شمعة قبل آخر 30 (كان ATR لـ 14 شمعة فقط: مرجع شديد الضوضاء)
const atrBase = cs => { const b = cs.slice(0, -30), n = Math.min(100, b.length - 1); return n >= 14 ? atr(b, n) : atr(b); };
const bb = (c, i, n = 20) => {
  const w = c.slice(i - n + 1, i + 1), m = w.reduce((a, b) => a + b) / n;
  const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / n) || 1e-12;
  return [m, sd];
};
// ================= إطار زمني أعلى =================
// v3.4: الشموع الأعلى تُبنى على حدود الساعة (مثل أي منصة)، لا من نهاية المصفوفة (كانت حدودها تنزاح مع كل شمعة).
// تُستبعد الشمعة الأعلى الأولى إن كانت ناقصة البداية، والأخيرة إن لم ينتهِ وقتها بعد.
function resample(cs, k, tf) {
  if (!(tf > 0)) throw new Error('resample: tf مطلوب صراحةً');
  const P = tf * k, out = [];
  if (!cs.length) return out;
  const lastEnd = cs[cs.length - 1].t + tf;
  let g = null;
  for (const x of cs) {
    const b = Math.floor(x.t / P) * P;
    if (!g || g.t !== b) {
      if (g && !(out.length === 0 && g.first !== g.t)) out.push({ t: g.t, o: g.o, h: g.h, l: g.l, c: g.c });
      g = { t: b, o: x.o, h: x.h, l: x.l, c: x.c, first: x.t };
    } else { if (x.h > g.h) g.h = x.h; if (x.l < g.l) g.l = x.l; g.c = x.c; }
  }
  if (g && g.t + P <= lastEnd && !(out.length === 0 && g.first !== g.t)) out.push({ t: g.t, o: g.o, h: g.h, l: g.l, c: g.c });
  return out;
}
function htfTrend(cs, k, tf) {
  const h = resample(cs, k, tf);
  if (h.length < 25) return 0;
  const c = h.map(x => x.c), e9 = ema(c, 9), e21 = ema(c, 21), n = c.length - 1;
  return e9[n] > e21[n] ? 1 : e9[n] < e21[n] ? -1 : 0;
}

// ================= أنماط الشموع =================
function patterns(cs) {
  const n = cs.length, a = cs[n - 3], b = cs[n - 2], c = cs[n - 1];
  const down = cs[n - 5].c > b.c, upt = cs[n - 5].c < b.c;
  if (bear(b) && bull(c) && c.o <= b.c && c.c >= b.o && body(c) > body(b)) return [1, 'ابتلاع صاعد'];
  if (bull(b) && bear(c) && c.o >= b.c && c.c <= b.o && body(c) > body(b)) return [-1, 'ابتلاع هابط'];
  if (bear(a) && body(a) > .5 * rng(a) && body(b) < .3 * rng(b) && bull(c) && c.c > (a.o + a.c) / 2) return [1, 'نجمة الصباح'];
  if (bull(a) && body(a) > .5 * rng(a) && body(b) < .3 * rng(b) && bear(c) && c.c < (a.o + a.c) / 2) return [-1, 'نجمة المساء'];
  if (body(c) < .35 * rng(c) && low(c) >= 2 * body(c) && upw(c) < .25 * rng(c) && down) return [.8, 'مطرقة'];
  if (body(c) < .35 * rng(c) && upw(c) >= 2 * body(c) && low(c) < .25 * rng(c) && upt) return [-.8, 'نجمة الرماية'];
  if ([a, b, c].every(x => bull(x) && body(x) > .5 * rng(x)) && a.c < b.c && b.c < c.c) return [.6, 'ثلاثة جنود'];
  if ([a, b, c].every(x => bear(x) && body(x) > .5 * rng(x)) && a.c > b.c && b.c > c.c) return [-.6, 'ثلاثة غربان'];
  return [0, ''];
}
function levels(cs, n = 60) {
  const seg = cs.slice(-n, -3), hi = [], lo = [];
  for (let i = 2; i < seg.length - 2; i++) {
    const w = seg.slice(i - 2, i + 3);
    if (seg[i].h === Math.max(...w.map(x => x.h))) hi.push(seg[i].h);
    if (seg[i].l === Math.min(...w.map(x => x.l))) lo.push(seg[i].l);
  }
  return [lo, hi];
}
function heikin(cs) {
  const w = cs.slice(-30), out = [];
  let po = w[0].o, pc = w[0].c;
  for (const x of w) {
    const c = (x.o + x.h + x.l + x.c) / 4, o = (po + pc) / 2;
    out.push({ o, c, h: Math.max(x.h, o, c), l: Math.min(x.l, o, c) });
    po = o; pc = c;
  }
  return out;
}
function swings(cs, k = 2) {
  const hi = [], lo = [];
  for (let i = k; i < cs.length - k; i++) {
    let h = true, l = true;
    for (let j = 1; j <= k; j++) {
      if (!(cs[i].h > cs[i - j].h && cs[i].h >= cs[i + j].h)) h = false;
      if (!(cs[i].l < cs[i - j].l && cs[i].l <= cs[i + j].l)) l = false;
    }
    if (h) hi.push({ i, p: cs[i].h });
    if (l) lo.push({ i, p: cs[i].l });
  }
  return { hi, lo };
}
// هيكل السوق: قمم أعلى + قيعان أعلى = +1 ، قمم أدنى + قيعان أدنى = -1 ، متضارب = 0
function structOf(sw) {
  if (sw.hi.length < 2 || sw.lo.length < 2) return 0;
  const h1 = sw.hi[sw.hi.length - 2].p, h2 = sw.hi[sw.hi.length - 1].p, l1 = sw.lo[sw.lo.length - 2].p, l2 = sw.lo[sw.lo.length - 1].p;
  return (h2 > h1 ? .5 : h2 < h1 ? -.5 : 0) + (l2 > l1 ? .5 : l2 < l1 ? -.5 : 0);
}
function adxOf(cs, n = 14) {
  if (cs.length < 2 * n + 2) return null;
  const pd = [], md = [], tr = [];
  for (let i = 1; i < cs.length; i++) {
    const x = cs[i], p = cs[i - 1], up = x.h - p.h, dn = p.l - x.l;
    pd.push(up > dn && up > 0 ? up : 0); md.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(x.h - x.l, Math.abs(x.h - p.c), Math.abs(x.l - p.c)));
  }
  let sp = 0, sm = 0, st = 0;
  for (let i = 0; i < n; i++) { sp += pd[i]; sm += md[i]; st += tr[i]; }
  const dx = []; let dip = 0, dim = 0;
  for (let i = n; i < pd.length; i++) {
    sp = sp - sp / n + pd[i]; sm = sm - sm / n + md[i]; st = st - st / n + tr[i];
    dip = st ? 100 * sp / st : 0; dim = st ? 100 * sm / st : 0;
    const s = dip + dim; dx.push(s ? 100 * Math.abs(dip - dim) / s : 0);
  }
  if (dx.length < n) return null;
  let a = dx.slice(0, n).reduce((x, y) => x + y, 0) / n;
  for (let i = n; i < dx.length; i++) a = (a * (n - 1) + dx[i]) / n;
  return { adx: a, dip, dim };
}
// اتجاه إطار واحد: EMA سريع/بطيء + ميل + هيكل القمم والقيعان
module.exports = { ema, rsiVal, rsiSeries, rsi, atr, atrBase, hl, eff, body, rng, bull, bear, upw, low, bb, resample, htfTrend, patterns, levels, heikin, swings, structOf, adxOf };
