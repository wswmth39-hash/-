'use strict';
// النواة — أدوات إحصائية بحتة (بلا حالة، بلا DOM، بلا ساعة).
const clamp = (v, a = -1, b = 1) => Math.max(a, Math.min(b, v));
// ================= الإحصاء =================
const blank = () => ({ hn: 0, hw: 0, ln: 0, lw: 0, rc: [] });
const slot = (o, k) => o[k] || (o[k] = blank());
const nw = o => [o.hn + o.ln, o.hw + o.lw];
const rec = (o, win, live) => {
  if (live) {
    o.ln++; if (win) o.lw++;
    const r = o.rc || (o.rc = []);
    r.push(win ? 1 : 0);
    if (r.length > 50) r.shift();
  } else { o.hn++; if (win) o.hw++; }
};
const wil = (n, w, z = 1.64) => {
  if (!n) return 0;
  const p = w / n, d = 1 + z * z / n;
  return (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
};
const bucket = conf => String(Math.floor(conf / 5) * 5);
module.exports = { clamp, blank, slot, nw, rec, wil, bucket };
