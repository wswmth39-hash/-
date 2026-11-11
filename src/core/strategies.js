'use strict';
// النواة — الاستراتيجيات الـ17 ونسخها المعدّلة. كل استراتيجية دالة بحتة (cs, c, X) → [صوت بين −1 و+1، وصف].
// هذه الوحدة «تصوّت» فقط؛ الأوزان (التعلّم) في learning.js والقرار في decision.js.
const { ema, eff, hl, bb, body, rng, bull, bear, upw, low, patterns, levels, heikin, rsi, atr } = require('./indicators');
const { clamp } = require('./stats');
// ================= الاستراتيجيات (17) =================
const NM = {
  trend: 'ترند EMA', rsi: 'RSI', boll: 'بولينجر', macd: 'MACD', stoch: 'ستوكاستك',
  candles: 'أنماط الشموع', sr: 'دعم/مقاومة', break: 'اختراق', ha: 'هايكن آيش', cci: 'CCI',
  willr: 'ويليامز %R', mom: 'الزخم', lin: 'انحدار خطي', streak: 'إنهاك التتابع',
  pin: 'شمعة الرفض', squeeze: 'انفجار الانضغاط', kelt: 'كيلتنر'
};
// v2.5: مجموعات المؤشرات المترابطة. المؤشرات داخل المجموعة تقيس سلوكًا متقاربًا فلا تُعدّ أصواتًا مستقلة.
const GRP = {
  trend: 'T', macd: 'T', mom: 'T', lin: 'T', ha: 'T',
  rsi: 'O', stoch: 'O', cci: 'O', willr: 'O', boll: 'O', kelt: 'O',
  break: 'K', squeeze: 'K', candles: 'P', pin: 'P', sr: 'S', streak: 'X'
};
const STR = [
  // v3.4: نفس القيم السابقة تمامًا عند عدم التساوي؛ التساوي (سوق ساكن) كان يُحسب هابطًا (−1) وأصبح 0
  ['trend', 'T', (cs, c) => { const e9 = ema(c, 9), e21 = ema(c, 21), e50 = ema(c, 50), n = c.length - 1, sg = Math.sign; return [clamp((sg(e9[n] - e21[n]) + sg(e21[n] - e50[n]) + sg(e9[n] - e9[n - 3])) / 3), '']; }],
  // v2.5.1: لا ارتداد ضد اتجاه قوي + لا دخول إلا بعد أن تبدأ الشمعة بالانعكاس فعلًا (تأكيد)
  ['rsi', 'R', (cs, c, X) => {
    const l = cs[cs.length - 1];
    if (eff(c) > .35) return [0, ''];
    if (X.rsi < 30 && bull(l)) return [X.rsi < 25 ? 1 : .6, ''];
    if (X.rsi > 70 && bear(l)) return [X.rsi > 75 ? -1 : -.6, ''];
    return [0, ''];
  }],
  ['boll', 'R', (cs, c) => { const [m, sd] = bb(c, c.length - 1), z = (c[c.length - 1] - m) / sd; return [z < -2 ? 1 : z > 2 ? -1 : z < -1.5 ? .4 : z > 1.5 ? -.4 : 0, '']; }],
  ['macd', 'T', (cs, c) => {
    const e12 = ema(c, 12), e26 = ema(c, 26), m = e12.map((v, i) => v - e26[i]), sg = ema(m, 9), n = m.length - 1;
    const h = m[n] - sg[n], hp = m[n - 1] - sg[n - 1];
    return [h > 0 ? (h > hp ? .8 : .3) : h < 0 ? (h < hp ? -.8 : -.3) : 0, ''];
  }],
  ['stoch', 'R', cs => { const [h, l] = hl(cs, 14), k = h === l ? 50 : (cs[cs.length - 1].c - l) / (h - l) * 100; return [k < 15 ? 1 : k > 85 ? -1 : 0, '']; }],
  ['candles', 'N', cs => { const [v, n] = patterns(cs); return [v, n]; }],
  ['sr', 'R', (cs, c, X) => {
    const [lo, hi] = levels(cs), p = c[c.length - 1], l = cs[cs.length - 1];
    if (lo.some(v => Math.abs(p - v) < .5 * X.atr) && low(l) > body(l)) return [.9, 'ارتداد دعم'];
    if (hi.some(v => Math.abs(p - v) < .5 * X.atr) && upw(l) > body(l)) return [-.9, 'ارتداد مقاومة'];
    return [0, ''];
  }],
  ['break', 'T', (cs, c) => { const w = cs.slice(-21, -1), hh = Math.max(...w.map(x => x.h)), ll = Math.min(...w.map(x => x.l)), p = c[c.length - 1]; return [p > hh ? .9 : p < ll ? -.9 : 0, '']; }],
  ['ha', 'T', cs => {
    const h = heikin(cs), a = h.slice(-3);
    if (a.every(x => x.c > x.o)) return [Math.abs(a[2].l - Math.min(a[2].o, a[2].c)) < 1e-12 ? .9 : .6, ''];
    if (a.every(x => x.c < x.o)) return [Math.abs(a[2].h - Math.max(a[2].o, a[2].c)) < 1e-12 ? -.9 : -.6, ''];
    return [0, ''];
  }],
  ['cci', 'R', cs => {
    const w = cs.slice(-20).map(x => (x.h + x.l + x.c) / 3), m = w.reduce((a, b) => a + b) / 20;
    const md = w.reduce((a, b) => a + Math.abs(b - m), 0) / 20 || 1e-12, v = (w[19] - m) / (.015 * md);
    // v2.5.1: نفس فكرة RSI: فلتر اتجاه قوي + تأكيد انعكاس الشمعة
    const l = cs[cs.length - 1];
    if (eff(cs.map(x => x.c)) > .35) return [0, ''];
    if (v < -100 && bull(l)) return [v < -150 ? 1 : .6, ''];
    if (v > 100 && bear(l)) return [v > 150 ? -1 : -.6, ''];
    return [0, ''];
  }],
  ['willr', 'R', cs => { const [h, l] = hl(cs, 14), v = h === l ? -50 : (h - cs[cs.length - 1].c) / (h - l) * -100; return [v < -90 ? 1 : v < -80 ? .5 : v > -10 ? -1 : v > -20 ? -.5 : 0, '']; }],
  ['mom', 'T', (cs, c, X) => [clamp((c[c.length - 1] - c[c.length - 6]) / (X.atr * 2.5)), '']],
  ['lin', 'T', (cs, c, X) => {
    const w = c.slice(-20), n = 20, mx = 9.5, my = w.reduce((a, b) => a + b) / n;
    let num = 0, den = 0;
    w.forEach((v, i) => { num += (i - mx) * (v - my); den += (i - mx) ** 2; });
    return [clamp(num / den / X.atr * 3), ''];
  }],
  ['streak', 'R', cs => {
    const sd = x => Math.sign(x.c - x.o), d0 = sd(cs[cs.length - 1]), dir = d0 > 0;
    if (!d0) return [0, '']; // دوجي يقطع التتابع
    let k = 0;
    for (let i = cs.length - 1; i >= 0 && sd(cs[i]) === d0; i--) k++;
    return [k >= 5 ? (dir ? -.9 : .9) : k === 4 ? (dir ? -.6 : .6) : 0, k >= 4 ? 'تتابع ' + k : ''];
  }],
  ['pin', 'N', cs => {
    const x = cs[cs.length - 1], r = rng(x);
    if (low(x) >= 2 * body(x) && low(x) > .5 * r && (x.c - x.l) / r > .6) return [.7, 'رفض سفلي'];
    if (upw(x) >= 2 * body(x) && upw(x) > .5 * r && (x.h - x.c) / r > .6) return [-.7, 'رفض علوي'];
    return [0, ''];
  }],
  // v3.4: الانضغاط يُقاس حتى الشمعة السابقة. كان يشمل شمعة الاختراق نفسها فيتسع الانحراف فيبطل شرط الانضغاط دائمًا تقريبًا.
  ['squeeze', 'T', (cs, c) => {
    const n = c.length - 1, ws = [];
    for (let i = n - 50; i <= n - 1; i++) { const [, sd] = bb(c, i); ws.push(sd); }
    const cur = ws[ws.length - 1], rank = ws.filter(v => v < cur).length / ws.length;
    const [m, sd] = bb(c, n - 1);
    if (rank <= .25) {
      if (c[n] > m + 2 * sd) return [.8, 'انضغاط واختراق ↑'];
      if (c[n] < m - 2 * sd) return [-.8, 'انضغاط واختراق ↓'];
    }
    return [0, ''];
  }],
  // v2.5.1: كيلتنر — فلتر اتجاه قوي + تأكيد انعكاس الشمعة (الحد 1.5 ATR بدل 2 لأن التأكيد يقلل الإشارات الكاذبة)
  ['kelt', 'R', (cs, c, X) => {
    const e = ema(c, 20), n = c.length - 1, l = cs[n];
    if (eff(c) > .35) return [0, ''];
    if (c[n] > e[n] + 1.5 * X.atr && bear(l)) return [-.7, ''];
    if (c[n] < e[n] - 1.5 * X.atr && bull(l)) return [.7, ''];
    return [0, ''];
  }]
];
const SK = STR.map(s => s[0]);

// ================= v3.2: نسخ محسّنة للاستراتيجيات + اختبار قبل الاعتماد =================
// كل استراتيجية معدّلة تعمل بجانب نسختها القديمة (الأصل لا يُحذف). النسختان تُسجَّلان على نفس الشموع:
// القديمة تحت المفتاح k والمعدّلة تحت k+. لا تُستخدم المعدّلة في القرار إلا إذا أثبتت تفوقًا (evalVariants)، وتُعاد للقديمة إن تدهورت.
const IMP = {
  // بولينجر: لا ارتداد ضد اتجاه قوي + تأكيد انعكاس الشمعة (كان يرتد بلا تأكيد وبلا فلتر اتجاه)
  boll: (cs, c) => {
    const n = c.length - 1, [m, sd] = bb(c, n), z = (c[n] - m) / sd, l = cs[n];
    if (eff(c) > .35) return [0, ''];
    if (z < -1.5 && bull(l)) return [z < -2 ? 1 : .4, ''];
    if (z > 1.5 && bear(l)) return [z > 2 ? -1 : -.4, ''];
    return [0, ''];
  },
  // MACD: منطقة ميتة (تقاطع بلا قوة نسبة إلى ATR لا يُعدّ صوتًا) + تخفيض الصوت المعاكس لجهة خط MACD
  macd: (cs, c, X) => {
    const e12 = ema(c, 12), e26 = ema(c, 26), m = e12.map((v, i) => v - e26[i]), sg = ema(m, 9), n = m.length - 1;
    const h = m[n] - sg[n], hp = m[n - 1] - sg[n - 1];
    if (!(Math.abs(h) / X.atr >= .03)) return [0, '']; // v3.4: يشمل ATR=0 (كانت 0/0=NaN تمرّ وتعطي صوتًا هابطًا في السوق الساكن)
    const up = h > 0, grow = up ? h > hp : h < hp;
    let v = grow ? .8 : .3;
    if ((up && m[n] < 0) || (!up && m[n] > 0)) v *= .7;
    return [up ? v : -v, ''];
  },
  // ستوكاستك: يحتاج تقاطع %K/%D داخل منطقة التشبع (لا مجرد الوصول إليها) + فلتر اتجاه قوي
  stoch: (cs, c) => {
    if (eff(c) > .35) return [0, ''];
    const n = cs.length - 1;
    const kAt = i => { const w = cs.slice(i - 13, i + 1), h = Math.max(...w.map(x => x.h)), l = Math.min(...w.map(x => x.l)); return h === l ? 50 : (cs[i].c - l) / (h - l) * 100; };
    const k0 = kAt(n), k1 = kAt(n - 1), k2 = kAt(n - 2), k3 = kAt(n - 3), d0 = (k0 + k1 + k2) / 3, d1 = (k1 + k2 + k3) / 3;
    if (k0 < 20 && k0 > d0 && k1 <= d1) return [k0 < 10 ? 1 : .8, ''];
    if (k0 > 80 && k0 < d0 && k1 >= d1) return [k0 > 90 ? -1 : -.8, ''];
    if (k0 < 15 && bull(cs[n])) return [.5, ''];
    if (k0 > 85 && bear(cs[n])) return [-.5, ''];
    return [0, ''];
  },
  // ويليامز %R: نفس منطق RSI (فلتر اتجاه + تأكيد انعكاس)
  willr: (cs, c) => {
    if (eff(c) > .35) return [0, ''];
    const l = cs[cs.length - 1], [h, lo] = hl(cs, 14), v = h === lo ? -50 : (h - l.c) / (h - lo) * -100;
    if (v < -90 && bull(l)) return [1, ''];
    if (v < -80 && bull(l)) return [.5, ''];
    if (v > -10 && bear(l)) return [-1, ''];
    if (v > -20 && bear(l)) return [-.5, ''];
    return [0, ''];
  },
  // اختراق: إغلاق خلف القمة/القاع بهامش 0.1 ATR + جسم ≥40% من المدى + ذيل رفض ≤40% (يستبعد الاختراق الوهمي بذيل)
  break: (cs, c, X) => {
    const w = cs.slice(-21, -1), hh = Math.max(...w.map(x => x.h)), ll = Math.min(...w.map(x => x.l)), l = cs[cs.length - 1], p = c[c.length - 1];
    if (p > hh + .1 * X.atr && body(l) >= .4 * rng(l) && upw(l) <= .4 * rng(l)) return [.9, ''];
    if (p < ll - .1 * X.atr && body(l) >= .4 * rng(l) && low(l) <= .4 * rng(l)) return [-.9, ''];
    return [0, ''];
  },
  // إنهاك التتابع: لا يُعاكس التتابع إلا إذا ضعف جسم آخر شمعة (الزخم بدأ يخبو) وإلا فالاتجاه مستمر
  streak: cs => {
    const l = cs[cs.length - 1], p = cs[cs.length - 2], sd = x => Math.sign(x.c - x.o), d0 = sd(l), dir = d0 > 0;
    if (!d0) return [0, ''];
    let k = 0;
    for (let i = cs.length - 1; i >= 0 && sd(cs[i]) === d0; i--) k++;
    if (k < 4 || !(body(l) < .8 * body(p))) return [0, ''];
    return [k >= 5 ? (dir ? -.9 : .9) : (dir ? -.6 : .6), 'تتابع ' + k];
  }
};
const IMPK = Object.keys(IMP);

// أصوات كل الاستراتيجيات على شموع معطاة. useNew(k) يحدد النسخة المعتمدة لكل استراتيجية لها نسخة معدّلة.
// onErr(k, e): الخطأ داخل استراتيجية لا يُبتلع — صوتها 0 ويُبلَّغ المستدعي (المحرك يسجّله).
// يعيد: raw (كل الأصوات الخام بما فيها النسخ المعدّلة k+)، list (صوت النسخة المعتمدة لكل استراتيجية مع نوعها ووصفها).
function evaluate(cs, c, X, useNew, onErr) {
  const raw = {}, list = [];
  for (const [k, kind, fn] of STR) {
    let v = 0, n = '';
    try { [v, n] = fn(cs, c, X); } catch (e) { if (onErr) onErr(k, e); }
    if (!Number.isFinite(v)) v = 0;
    raw[k] = v;
    let ak = k, det = n;
    if (IMP[k]) {
      let v2 = 0, n2 = '';
      try { [v2, n2] = IMP[k](cs, c, X); } catch (e) { if (onErr) onErr(k + '+', e); }
      if (!Number.isFinite(v2)) v2 = 0;
      raw[k + '+'] = v2;
      if (useNew && useNew(k)) { v = v2; ak = k + '+'; det = n2; }
    }
    list.push({ k, kind, ak, v, det });
  }
  return { raw, list };
}
// قراءات الاستراتيجيات الخام (تُستخدم أيضًا في اختبار ثبات القراءات بعد إغلاق الشمعة)
function rawVotes(cs, onErr) {
  const c = cs.map(x => x.c), X = { rsi: rsi(c), atr: atr(cs) };
  return evaluate(cs, c, X, null, onErr).raw;
}
module.exports = { NM, GRP, STR, SK, IMP, IMPK, evaluate, rawVotes };
