'use strict';
// المسجّل — القواعد والصيغ (بحتة): صحة السجل، قاعدة منع التكرار، الفجوات، JSONL/CSV، checksum.
// لم تتغير القواعد عن v3.5 (انظر docs/RECORDER_DESIGN.md). الفرق الوحيد: rx (ساعة الجهاز) يُمرَّر بدل قراءته هنا.
const REC_SCHEMA = 1;
const REC_DB = 'wsnf33s_rec';
// ترتيب الحقول ثابت: التصدير حتمي (نفس البيانات ⇒ نفس الملف ونفس الـchecksum)
const RECF = ['a', 'tf', 't', 'tc', 'o', 'h', 'l', 'c', 'n', 'ft', 'lt', 'mg', 'cts', 'src', 'rx', 'v'];
const REC_RANK = { hist: 1, mixed: 2, live: 3 };
const REC_EV_MAX = 6000;
const recKey = (a, tf) => a + '|' + tf;
const recPk = r => r.a + '|' + r.tf + '|' + r.t;
// FNV-1a 32-bit: للتحقق من سلامة الملفات المصدَّرة (اكتشاف التلف/التعديل، ليس تشفيرًا)
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return ('0000000' + h.toString(16)).slice(-8);
}

// ---- قواعد صحة السجل (نفسها للتسجيل الحي والاستيراد) ----
function recCheck(r) {
  if (!r || typeof r !== 'object') return 'سجل غير صالح';
  if (typeof r.a !== 'string' || !r.a || r.a.length > 40) return 'اسم أصل غير صالح';
  if (!Number.isInteger(r.tf) || r.tf < 1 || r.tf > 86400) return 'إطار زمني غير صالح';
  for (const f of ['t', 'tc', 'o', 'h', 'l', 'c', 'n', 'ft', 'lt', 'mg', 'cts']) if (!Number.isFinite(r[f])) return 'قيمة غير رقمية: ' + f;
  if (r.t % r.tf !== 0) return 'وقت افتتاح غير محاذٍ للإطار';
  if (r.tc !== r.t + r.tf) return 'وقت إغلاق غير متسق';
  if (!(r.l > 0) || r.h < r.l || r.h < Math.max(r.o, r.c) || r.l > Math.min(r.o, r.c)) return 'أسعار OHLC غير متسقة';
  if (!Number.isInteger(r.n) || r.n < 1) return 'عدد تيكات غير صالح';
  if (r.ft < r.t || r.lt < r.ft || r.lt >= r.tc) return 'توقيت التيكات خارج الشمعة';
  if (r.mg < 0 || r.mg > r.tf) return 'فجوة تيكات غير منطقية';
  if (r.cts < r.tc) return 'بيانات مستقبلية: الشمعة سُجّلت قبل انتهاء وقتها';
  if (!REC_RANK[r.src]) return 'مصدر غير معروف';
  if (r.v !== REC_SCHEMA) return 'إصدار مخطط غير مدعوم';
  return '';
}
// يبني السجل من الشمعة المبنية من التيكات. لا يضيف أي معلومة من خارج [t, t+tf).
// rx: ساعة الجهاز لحظة التسجيل (يمرّرها المستدعي؛ هذه الوحدة بلا ساعة)
function recMake(asset, c, tf, tsClose, rx) {
  return {
    a: asset, tf, t: c.t, tc: c.t + tf, o: c.o, h: c.h, l: c.l, c: c.c, n: c.nt, ft: c.ft, lt: c.lt,
    mg: +(c.mg || 0).toFixed(3), cts: tsClose, src: c.sl && c.sh ? 'mixed' : c.sl ? 'live' : 'hist', rx, v: REC_SCHEMA
  };
}
// قاعدة منع التكرار: المصدر الأعلى يستبدل الأدنى؛ غير ذلك يبقى الموجود (ويُعدّ تعارضًا إن اختلفت الأسعار)
function recDecide(ex, r) {
  if (!ex) return 'added';
  if (REC_RANK[r.src] > REC_RANK[ex.src]) return 'replaced';
  return ex.o === r.o && ex.h === r.h && ex.l === r.l && ex.c === r.c ? 'dup' : 'conflict';
}
const recDiff = (ex, r) => ex && ex.c ? Math.max(...['o', 'h', 'l', 'c'].map(f => Math.abs(r[f] - ex[f]) / Math.abs(ex.c))) : 0;
// الفجوات في سلسلة أوقات مرتبة
function recGaps(ts, tf) {
  const out = [];
  for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] > tf) out.push({ from: ts[i - 1] + tf, to: ts[i], n: (ts[i] - ts[i - 1]) / tf - 1 });
  return out;
}

const recLine = r => JSON.stringify(Object.fromEntries(RECF.map(f => [f, r[f]])));
const isoOf = s => new Date(s * 1000).toISOString();
const CSVF = ['asset', 'tf', 'open_time_utc', 'open_ts', 'close_ts', 'open', 'high', 'low', 'close', 'ticks', 'first_tick_ts', 'last_tick_ts', 'max_tick_gap_s', 'close_tick_ts', 'src', 'recorded_ms', 'schema'];
function recNormalize(x) {
  const num = v => (v === '' || v === null || v === undefined) ? NaN : +v;
  return { a: String(x.a == null ? '' : x.a), tf: num(x.tf), t: num(x.t), tc: num(x.tc), o: num(x.o), h: num(x.h), l: num(x.l), c: num(x.c), n: num(x.n),
    ft: num(x.ft), lt: num(x.lt), mg: num(x.mg), cts: num(x.cts), src: String(x.src || ''), rx: Number.isFinite(num(x.rx)) ? num(x.rx) : 0, v: num(x.v) };
}
function recParse(text) {
  const lines = String(text).split(/\r?\n/).filter(x => x.trim() !== '');
  if (!lines.length) throw new Error('الملف فارغ');
  const recs = [];
  if (lines[0].trim().startsWith('{')) {
    let head;
    try { head = JSON.parse(lines[0]); } catch (e) { throw new Error('سطر البيان غير صالح'); }
    if (!head || head.type !== 'wsnf-candles') throw new Error('ليس ملف شموع من wsnf');
    if (!(head.schema <= REC_SCHEMA)) throw new Error('إصدار مخطط أحدث من المدعوم: ' + head.schema);
    const body = lines.slice(1);
    if (head.checksum && head.checksum !== 'fnv1a32:' + fnv1a(body.join('\n'))) throw new Error('الـchecksum لا يطابق: الملف تالف أو معدّل، رُفض بالكامل');
    if (Number.isFinite(head.count) && head.count !== body.length) throw new Error('عدد الأسطر (' + body.length + ') لا يطابق البيان (' + head.count + ')');
    body.forEach((ln, i) => { try { recs.push(recNormalize(JSON.parse(ln))); } catch (e) { recs.push({ __bad: 'سطر JSON غير صالح ' + (i + 2) }); } });
    return { fmt: 'jsonl', recs };
  }
  const cols = lines[0].split(',').map(x => x.trim());
  const ix = f => cols.indexOf(f);
  if (ix('asset') < 0 || ix('open_ts') < 0 || ix('close') < 0) throw new Error('ترويسة CSV غير معروفة');
  const map = { a: 'asset', tf: 'tf', t: 'open_ts', tc: 'close_ts', o: 'open', h: 'high', l: 'low', c: 'close', n: 'ticks', ft: 'first_tick_ts', lt: 'last_tick_ts', mg: 'max_tick_gap_s', cts: 'close_tick_ts', src: 'src', rx: 'recorded_ms', v: 'schema' };
  lines.slice(1).forEach(ln => {
    const v = ln.split(','), o = {};
    for (const f in map) o[f] = ix(map[f]) >= 0 ? v[ix(map[f])] : undefined;
    recs.push(recNormalize(o));
  });
  return { fmt: 'csv', recs };
}
module.exports = { REC_SCHEMA, REC_DB, RECF, REC_RANK, REC_EV_MAX, recKey, recPk, fnv1a, recCheck, recMake, recDecide, recDiff, recGaps, recLine, isoOf, CSVF, recNormalize, recParse };
