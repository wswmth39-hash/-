'use strict';
// النواة — تحليل إطارات Engine.IO/Socket.IO (بحت، بلا حالة).
// يطابق البروتوكول المنشور لـ Socket.IO v4 (https://socket.io/docs/v4/socket-io-protocol/):
//   إطار Engine.IO نصي: رقم النوع أولًا — 0 open، 1 close، 2 ping، 3 pong، 4 message، 5 upgrade، 6 noop
//   داخل message (4): نوع Socket.IO — 0 CONNECT، 1 DISCONNECT، 2 EVENT، 3 ACK، 4 CONNECT_ERROR، 5 BINARY_EVENT، 6 BINARY_ACK
//   ثم (لـ 5/6) عدد المرفقات الثنائية متبوعًا بـ «-»، ثم namespace اختياري يبدأ بـ «/» وينتهي بـ «,»، ثم رقم ack اختياري، ثم JSON.
//   المرفقات الثنائية تصل بعدها كإطارات ثنائية منفصلة بالترتيب، وتحل محل { _placeholder: true, num: i }.
// لا نفترض أي اسم حدث هنا؛ تفسير الأحداث في طبقة المنصة.

const EIO = { 0: 'open', 1: 'close', 2: 'ping', 3: 'pong', 4: 'message', 5: 'upgrade', 6: 'noop' };
const SIO = { 0: 'connect', 1: 'disconnect', 2: 'event', 3: 'ack', 4: 'connect_error', 5: 'binary_event', 6: 'binary_ack' };

// يعيد { eio, sio?, attachments, nsp, id, data?, error? }. لا يرمي أبدًا: أي خلل يُعاد في error ليُسجَّل.
function parseText(s) {
  if (typeof s !== 'string' || !s.length) return { eio: 'invalid', error: 'إطار فارغ' };
  const eio = EIO[s[0]];
  if (!eio) return { eio: 'invalid', error: 'نوع Engine.IO غير معروف: ' + s[0] };
  if (eio !== 'message') return { eio, raw: s.length > 1 ? s.slice(1, 200) : '' };
  const t = s[1], sio = SIO[t];
  if (!sio) return { eio, error: 'نوع Socket.IO غير معروف: ' + t };
  let i = 2, attachments = 0, nsp = '/', id = null;
  if (sio === 'binary_event' || sio === 'binary_ack') {
    const m = /^(\d+)-/.exec(s.slice(i));
    if (!m) return { eio, sio, error: 'عدد المرفقات مفقود' };
    attachments = +m[1]; i += m[0].length;
  }
  if (s[i] === '/') {
    const c = s.indexOf(',', i);
    if (c < 0) { nsp = s.slice(i); i = s.length; } else { nsp = s.slice(i, c); i = c + 1; }
  }
  const d = /^\d+/.exec(s.slice(i));
  if (d) { id = +d[0]; i += d[0].length; }
  const body = s.slice(i);
  const out = { eio, sio, attachments, nsp, id };
  if (!body.length) return out;
  try { out.data = JSON.parse(body); } catch (e) { out.error = 'JSON غير صالح: ' + String(e && e.message || e).slice(0, 80); }
  return out;
}

// استبدال العناصر النائبة بالمرفقات (عميق). المرفق المفقود خطأ لا يُخمَّن.
function fillPlaceholders(x, atts) {
  if (Array.isArray(x)) return x.map(v => fillPlaceholders(v, atts));
  if (x && typeof x === 'object') {
    if (x._placeholder === true && Number.isInteger(x.num)) {
      if (!(x.num in atts)) throw new Error('مرفق ثنائي مفقود رقم ' + x.num);
      return atts[x.num];
    }
    const o = {};
    for (const k in x) o[k] = fillPlaceholders(x[k], atts);
    return o;
  }
  return x;
}

// حدث Socket.IO = مصفوفة [اسم، ...وسائط]
const eventName = data => (Array.isArray(data) && typeof data[0] === 'string') ? data[0] : null;

module.exports = { EIO, SIO, parseText, fillPlaceholders, eventName };
