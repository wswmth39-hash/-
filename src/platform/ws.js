'use strict';
// طبقة المنصة — اعتراض WebSocket للقراءة فقط وترجمة رسائل المنصة إلى أوامر المحرك.
// هذه الوحدة وحدها تعرف صيغة رسائل المنصة (Socket.IO: 42[...] نصي، 451-[...] + إطار ثنائي).
// لا نعترض send ولا نرسل شيئًا إطلاقًا.
const WS_GRACE_MS = 3000; // مهلة قبل اعتبار الانقطاع حقيقيًا (إعادة اتصال المنصة العادية تستغرق ثوانٍ قليلة)

// ترجمة رسالة واحدة إلى استدعاءات المحرك (مكشوفة للاختبارات باسم handle)
function createHandler(E) {
  const [feedTick, loadHistory, logErr] = E.use('feedTick', 'loadHistory', 'logErr');
  return function handle(kind, j) {
    try {
      if (kind === 'stream' && Array.isArray(j)) j.forEach(x => { if (Array.isArray(x) && x.length >= 3) feedTick(String(x[0]), +x[1], +x[2]); });
      if (kind === 'hist' && j && j.asset && Array.isArray(j.history)) loadHistory(j.asset, j.history);
    } catch (e) { E.S.loading = false; logErr('HANDLE', String(e && e.message || e)); }
  };
}

// تركيب الاعتراض على window.WebSocket. win: كائن النافذة (أو بديل في الاختبار)، timers: { setTimeout, clearTimeout }.
function installSocketTap(win, E, handle, timers) {
  const [connOpen, connLost, onWsDown, logErr] = E.use('connOpen', 'connLost', 'onWsDown', 'logErr');
  let expect = null, expectWs = null, chain = Promise.resolve();
  const toText = d => (win.Blob && d instanceof win.Blob) ? d.text() : Promise.resolve(new TextDecoder().decode(d));
  const liveSockets = new Set();
  let wsDownTimer = null;
  function onMsg(ev) {
    const d = ev.data;
    if (typeof d === 'string') {
      if (/^45\d-/.test(d)) {
        expect = d.includes('updateStream') ? 'stream' : /updateHistoryNew/.test(d) ? 'hist' : null;
        expectWs = expect ? ev.target : null;
        return;
      }
      const m = /^42\d*(\[[\s\S]*)$/.exec(d);
      if (m) {
        try {
          const j = JSON.parse(m[1]);
          if (j[0] === 'updateStream') handle('stream', j[1]);
          else if (/^updateHistoryNew/.test(j[0])) handle('hist', j[1]);
        } catch (e) {}
      }
      return;
    }
    if (expect && (!expectWs || ev.target === expectWs)) {
      const kind = expect; expect = null; expectWs = null;
      chain = chain.then(() => toText(d)).then(t => handle(kind, JSON.parse(t))).catch(e => { logErr('WS_PARSE', String(e && e.message || e)); });
    }
  }
  const NativeWS = win.WebSocket;
  if (!NativeWS) return false;
  win.WebSocket = function (url, proto) {
    const ws = proto !== undefined ? new NativeWS(url, proto) : new NativeWS(url);
    ws.addEventListener('message', onMsg);
    ws.addEventListener('open', () => {
      liveSockets.add(ws);
      connOpen();
      if (wsDownTimer) { timers.clearTimeout(wsDownTimer); wsDownTimer = null; } // رجع الاتصال خلال المهلة: لا انقطاع فعلي
    });
    ws.addEventListener('close', () => {
      const wasLive = liveSockets.delete(ws);
      if (expectWs === ws) { expect = null; expectWs = null; } // لا نفسّر رسالة ثنائية قادمة من اتصال مغلق
      if (!wasLive) return;            // اتصال فشل قبل أن يفتح: ليس انقطاعًا جديدًا
      if (liveSockets.size) return;    // ما زال هناك اتصال حي آخر
      connLost();                      // نوقف التحليل والدخول فورًا
      if (wsDownTimer) return;         // الانقطاع مسجَّل قيد المهلة أصلًا
      wsDownTimer = timers.setTimeout(() => { // لا نسجّل خطأ ولا نُلغي صفقة إلا لو طال الانقطاع
        wsDownTimer = null;
        if (liveSockets.size) return;
        logErr('WS_DOWN', 'انقطع اتصال WebSocket');
        onWsDown();
      }, WS_GRACE_MS);
    });
    return ws; // لا نعترض send ولا نرسل شيئًا
  };
  win.WebSocket.prototype = NativeWS.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(k => { win.WebSocket[k] = NativeWS[k]; });
  return true;
}
module.exports = { createHandler, installSocketTap, WS_GRACE_MS };
