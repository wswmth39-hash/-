'use strict';
// المرحلة 4 (v4): استقبال بيانات المنصة — حالة لكل اتصال، تحليل Socket.IO، التحقق من التيك، حالة البيانات، إعادة الاتصال،
// حارس الحقن المزدوج، حد الذاكرة، خصوصية أداة الاستكشاف. تعمل عبر مسار WebSocket في بيئة المتصفح المحاكاة.
// تُشغَّل أيضًا على v3.6 (WSNF_TARGET=v36) لإثبات وجود الخلل قبل الإصلاح.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness');

const A = 'EURUSD_otc';
const enc = s => new TextEncoder().encode(s);
function boot(opts = {}) {
  const B = H.load(opts);
  const sockets = [];
  B.open = () => { const ws = new B.ctx.WebSocket('wss://api.po.test/socket.io/?EIO=4&sid=SECRET'); ws.emit('open'); sockets.push(ws); return ws; };
  B.text = (ws, s) => ws.emit('message', { data: s });
  B.bin = (ws, s) => ws.emit('message', { data: enc(s) });
  B.ticks = (ws, list) => B.text(ws, '42["updateStream",' + JSON.stringify(list) + ']');
  B.flush = () => new Promise(r => setTimeout(r, 30));
  B.sockets = sockets;
  return B;
}
const lastCandle = (B, a = A) => (B.W.S.candles[a] || []).slice(-1)[0];

test('F1 حالة مستقلة لكل اتصال: مرفقا حدثين ثنائيين من اتصالين متداخلين يصلان لصاحبيهما', async () => {
  const B = boot(), W = B.W, t0 = 1700000040;
  const a = B.open(), b = B.open();
  B.setNow(t0 * 1000);
  B.text(a, '451-["updateStream",{"_placeholder":true,"num":0}]');
  B.text(b, '451-["updateHistoryNewFast",{"_placeholder":true,"num":0}]');
  const hist = []; for (let s = 0; s < 600; s++) hist.push([t0 - 600 + s + .3, 1.1 + s * 1e-6]);
  B.bin(b, JSON.stringify({ asset: 'AUDCAD_otc', history: hist }));
  B.bin(a, JSON.stringify([[A, t0 + .5, 1.2345]]));
  await B.flush();
  assert.ok((W.S.candles.AUDCAD_otc || []).length >= 9, 'التاريخ لم يُحمَّل للأصل الصحيح');
  assert.ok(W.S.candles[A] && lastCandle(B).c === 1.2345, 'تيك الاتصال الأول ضاع (v3.6: expect مشتركة)');
});

test('F2 بروتوكول Socket.IO: مرفقات متعددة، namespace، رقم ack', async () => {
  const B = boot(), W = B.W, t0 = 1700000040;
  if (!W.core || !W.core.sio) return assert.fail('لا يوجد محلل Socket.IO (v3.6)');
  const { parseText, fillPlaceholders } = W.core.sio;
  const m = parseText('452-/po,17["updateStream",{"_placeholder":true,"num":0},{"_placeholder":true,"num":1}]');
  assert.equal(m.sio, 'binary_event'); assert.equal(m.attachments, 2); assert.equal(m.nsp, '/po'); assert.equal(m.id, 17);
  assert.deepEqual(JSON.parse(JSON.stringify(fillPlaceholders(m.data, [[1], [2]]))), ['updateStream', [1], [2]]);
  assert.throws(() => fillPlaceholders(m.data, [[1]]), /مفقود/);
  assert.equal(parseText('2').eio, 'ping'); assert.equal(parseText('40').sio, 'connect');
  assert.match(parseText('9x').error, /غير معروف/);
  const ws = B.open(); B.setNow(t0 * 1000);
  B.text(ws, '42/po,["updateStream",[["' + A + '",' + (t0 + .1) + ',1.5]]]');
  B.text(ws, '4255["updateStream",[["' + A + '",' + (t0 + .2) + ',1.6]]]');
  B.text(ws, '452-["updateStream",{"_placeholder":true,"num":0},{"_placeholder":true,"num":1}]');
  B.bin(ws, JSON.stringify([[A, t0 + .3, 1.7]])); B.bin(ws, '{"extra":1}');
  await B.flush();
  assert.equal(lastCandle(B).nt, 3); assert.equal(lastCandle(B).c, 1.7);
});

test('F3 فشل تحليل الرسائل يُسجَّل ولا يُبتلع بصمت', async () => {
  const B = boot(), W = B.W;
  const ws = B.open();
  B.text(ws, '42["updateStream",[[');                 // JSON مقطوع
  B.bin(ws, 'not json');                               // إطار ثنائي بلا حدث
  B.text(ws, '451-["updateStream",{"_placeholder":true,"num":0}]'); B.bin(ws, '{bad');
  await B.flush();
  const codes = W.S.errors.filter(e => e.code === 'WS_PARSE');
  assert.ok(codes.length >= 2, 'أخطاء مسجّلة: ' + codes.length);
  assert.ok(codes.some(e => /JSON/.test(e.msg)));
});

test('F4 التحقق من التيك: وقت بالمللي ثانية، سعر غير صالح، قفزة شاذة، وتكرار — كلها لا تدخل الشموع', async () => {
  const B = boot(), W = B.W, t0 = 1700000040;
  const ws = B.open(); B.setNow(t0 * 1000 + 10000);
  B.ticks(ws, [[A, t0 + 1, 1.1], [A, t0 + 2, 1.1001]]);
  B.ticks(ws, [[A, (t0 + 3) * 1000, 1.1002]]);         // مللي ثانية
  B.ticks(ws, [[A, t0 + 4, 0], [A, t0 + 4, 'x']]);     // سعر صفر/نص
  B.ticks(ws, [[A, t0 + 5, 1.6]]);                      // قفزة 45%
  B.ticks(ws, [[A, t0 + 2, 1.1001], [A, t0 + 2, 1.1001]]); // تكرار حرفي
  await B.flush();
  const c = lastCandle(B);
  assert.equal(W.S.candles[A].length, 1, 'شموع: ' + W.S.candles[A].map(x => x.t));
  assert.equal(c.nt, 2, 'عدد التيكات تضخم بالتكرار أو المرفوض'); assert.equal(c.h, 1.1001);
  if (!W.feedView) return assert.fail('لا عدّادات تحقق (v3.6)');
  const f = W.feedView();
  assert.equal(f.ticks.ok, 2); assert.equal(f.ticks.dup, 2); assert.equal(f.ticks.rej, 4);
  // v4.0.1: أُزيل رفض «الوقت المستقبلي» مقارنة بساعة الجهاز: كان يرفض كل التيكات إن كانت ساعة المنصة مزاحة (F15)
  for (const re of [/مللي/, /غير موجب/, /غير رقمي/, /قفزة/]) assert.ok(Object.keys(f.ticks.reasons).some(k => re.test(k)), re + ' ' + JSON.stringify(f.ticks.reasons));
});

test('F5 آلة حالات البيانات (بحتة): «حية» فقط مع اتصال مفتوح وتيك صالح حديث', () => {
  const { feedStatus } = require('../src/core/feed');
  const T = { liveMs: 3000, delayMs: 8000, unavailableMs: 60000, waitMs: 15000 };
  const x = (o) => feedStatus({ openConns: 1, connecting: 0, everOpen: true, lastOpenAt: 0, lastCloseAt: 0, lastValidAt: 0, errorBurst: false, now: 100000, ...o }, T);
  assert.equal(x({ openConns: 0 }), 'disconnected');
  assert.equal(x({ openConns: 0, connecting: 1 }), 'connecting');
  assert.equal(x({ lastOpenAt: 95000 }), 'connected');            // مفتوح بلا بيانات بعد
  assert.equal(x({ lastOpenAt: 50000 }), 'unavailable');          // مفتوح طويلًا بلا بيانات
  assert.equal(x({ lastOpenAt: 50000, lastValidAt: 99000 }), 'live');
  assert.equal(x({ lastOpenAt: 50000, lastValidAt: 95000 }), 'delayed');
  assert.equal(x({ lastOpenAt: 50000, lastValidAt: 60000 }), 'stale');
  assert.equal(x({ lastOpenAt: 0, lastValidAt: 30000 }), 'unavailable');
  assert.equal(x({ lastOpenAt: 50000, lastValidAt: 99000, openConns: 0 }), 'disconnected'); // لا «حية» بلا اتصال
  assert.equal(x({ lastOpenAt: 90000, errorBurst: true }), 'error');
  assert.equal(x({ lastOpenAt: 90000, lastValidAt: 20000 }), 'connected'); // تيكات من اتصال سابق لا تُحسب لاتصال جديد
});

test('F6 حالة البيانات عبر المسار الحقيقي: يتصل ← متصل ← حي ← متأخر ← قديم ← غير متصل ← يعود حيًا', async () => {
  const B = boot(), W = B.W, t0 = 1700000040;
  if (!W.feedCheck) return assert.fail('لا مراقب تغذية (v3.6)');
  const seen = []; W.on('feed', x => seen.push(x.to));
  const at = ms => { B.setNow(t0 * 1000 + ms); return W.feedCheck(); };
  const ws = new B.ctx.WebSocket('wss://x');
  assert.equal(at(0), 'connecting');
  ws.emit('open'); assert.equal(at(100), 'connected');
  W.S.cur = null;
  B.setNow(t0 * 1000 + 1000); B.ticks(ws, [[A, t0 + 1, 1.1]]);
  assert.equal(at(1500), 'live');
  assert.equal(at(1000 + 5000), 'delayed');
  assert.equal(at(1000 + 20000), 'stale');
  B.setNow(t0 * 1000 + 22000); ws.emit('close');
  assert.equal(at(22000), 'disconnected');
  B.setNow(t0 * 1000 + 25000);
  const ws2 = new B.ctx.WebSocket('wss://x'); ws2.emit('open');
  assert.equal(at(25000), 'connected');
  B.setNow(t0 * 1000 + 26000); B.ticks(ws2, [[A, t0 + 26, 1.1001]]);
  assert.equal(at(26500), 'live');
  assert.deepEqual(seen, ['connecting', 'connected', 'live', 'delayed', 'stale', 'disconnected', 'connected', 'live']);
  const f = W.feedView();
  assert.equal(f.reconnects, 1); assert.equal(f.downMs, 3000);
});

test('F7 «حية» لا تظهر أبدًا مع بيانات مرفوضة فقط', async () => {
  const B = boot(), W = B.W, t0 = 1700000040;
  if (!W.feedCheck) return assert.fail('لا مراقب تغذية (v3.6)');
  const ws = B.open(); B.setNow(t0 * 1000);
  for (let i = 0; i < 50; i++) B.ticks(ws, [[A, (t0 + i) * 1000, 1.1]]);
  assert.notEqual(W.feedCheck(), 'live');
  assert.equal(W.feedView().ticks.ok, 0);
});

test('F8 حارس الحقن المزدوج: تشغيل السكربت مرتين في نفس الصفحة لا يكرر المستمعات', async () => {
  const B = boot(), W = B.W;
  const vm = require('vm');
  vm.runInContext(H.source(), B.ctx);                    // حقن ثانٍ
  assert.equal(B.ctx.__WSNF25, W, 'أُنشئ محرك ثانٍ');
  const ws = B.open(), t0 = 1700000040; B.setNow(t0 * 1000);
  B.ticks(ws, [[A, t0 + 1, 1.1]]);
  assert.equal(lastCandle(B).nt, 1, 'التيك عولج مرتين');
});

test('F9 حد الذاكرة: شموع عدد محدود من الأصول، والأصل الحالي لا يُحذف', async () => {
  const B = boot(), W = B.W, t0 = 1700000040;
  const ws = B.open(); B.setNow(t0 * 1000);
  for (let k = 0; k < 20; k++) B.ticks(ws, [['AS' + k + '_otc', t0 + k, 1 + k / 100]]);
  const n = Object.keys(W.S.candles).length;
  assert.ok(n <= 8, 'أصول في الذاكرة: ' + n);
  assert.ok(W.S.candles.AS19_otc, 'الأصل الحالي حُذف');
});

test('F10 أداة الاستكشاف لا تسجّل أي قيمة حساسة ولا العنوان الكامل، وتسجّل بنية الأحداث السوقية', async () => {
  const B = boot(), W = B.W, t0 = 1700000040;
  if (!W.discovery) return assert.fail('لا أداة استكشاف (v3.6)');
  W.discovery.start();
  const ws = B.open(); B.setNow(t0 * 1000);
  B.text(ws, '42["successauth",{"uid":987654,"email":"me@example.com","balance":1234.56,"isDemo":1}]');
  B.text(ws, '42["updateBalance",{"balance":999.99,"currency":"USD"}]');
  B.text(ws, '42["userInfo",{"token":"tok_ABCDEF","name":"Ahmad","phone":"0555"}]');
  B.ticks(ws, [[A, t0 + 1, 1.1234]]);
  B.text(ws, '42["updateCharts",{"asset":"EURUSD_otc","period":60,"candles":[[1700000000,1.1,1.2,1.0,1.15]]}]');
  await B.flush();
  const rep = JSON.stringify(W.discovery.report());
  for (const secret of ['987654', 'me@example.com', '1234.56', '999.99', 'tok_ABCDEF', 'Ahmad', '0555', 'SECRET', 'sid=', 'api.po.test/socket.io'])
    assert.ok(!rep.includes(secret), 'تسرّب: ' + secret);
  const r = JSON.parse(rep);
  assert.ok(r.events.successauth && r.events.updateBalance && r.events.userInfo, 'أسماء الأحداث موجودة');
  assert.deepEqual(r.events.successauth.samples, []);
  assert.ok(r.events.successauth.sensitive.includes('email'));
  assert.ok(r.events.updateStream.samples.length === 1 && JSON.stringify(r.events.updateStream.samples).includes('1.1234'), 'عيّنة السوق');
  assert.ok(r.events.updateCharts.samples.length === 1);
  assert.deepEqual(Object.keys(r.hosts), ['api.po.test']);
});

test('F11 تغيّر الأصل يُرصد ويُصدر حدثًا', async () => {
  const B = boot(), W = B.W, t0 = 1700000040;
  if (!W.feedView) return assert.fail('لا مراقب تغذية (v3.6)');
  const ch = []; W.on('asset', x => ch.push(x.from + '→' + x.to));
  const ws = B.open(); B.setNow(t0 * 1000);
  B.ticks(ws, [[A, t0 + 1, 1.1], ['GBPUSD_otc', t0 + 2, 1.3], ['GBPUSD_otc', t0 + 3, 1.3001]]);
  assert.deepEqual(ch, [A + '→GBPUSD_otc']);
  assert.equal(W.feedView().assets.length, 2);
});

test('F14 بيانات حالة التغذية لا تحتوي قيمًا غير معرّفة (الناقص = null صراحةً)', async () => {
  const B = boot(), W = B.W, t0 = 1700000040;
  if (!W.feedView) return assert.fail('لا مراقب تغذية (v3.6)');
  const undef = o => Object.entries(o).filter(([, v]) => v === undefined).map(([k]) => k);
  assert.deepEqual(undef(W.feedView()), [], 'قبل أي بيانات');
  const ws = B.open(); B.setNow(t0 * 1000); B.ticks(ws, [[A, t0 + 1, 1.2345]]);
  const f = W.feedView();
  assert.deepEqual(undef(f), []);
  assert.equal(f.lastPrice, 1.2345); assert.equal(f.lastTs, t0 + 1); assert.equal(f.ageMs, 0);
});

test('F15 ساعة المنصة مزاحة عن ساعة الجهاز (+2 س موثّقة في مكتبة مفتوحة المصدر، أو −2 س): التيكات تُقبل ويُقاس الفرق', async () => {
  // مصدر الإزاحة: lordralinc/pocket_option (constants.py: TIMESTAMP_OFFSET = -7200). لا نفترضها؛ نقبل أي إزاحة ثابتة.
  for (const shift of [7200, -7200, 0]) {
    const B = boot(), W = B.W, t0 = 1700000040;
    const ws = B.open();
    for (let s = 0; s < 130; s++) { B.setNow((t0 + s) * 1000 + 150); B.ticks(ws, [[A, t0 + shift + s + .3, 1.1 + s * 1e-5]]); }
    const c = W.S.candles[A];
    assert.ok(c && c.length >= 2, 'إزاحة ' + shift + ': لم تُبنَ شموع (التيكات رُفضت)');
    if (!W.feedView) continue;
    const f = W.feedView();
    assert.equal(f.ticks.ok, 130, 'إزاحة ' + shift + ': ' + JSON.stringify(f.ticks.reasons));
    assert.ok(Math.abs(f.clockOffsetS - shift) <= 1, 'الإزاحة المقاسة ' + f.clockOffsetS + ' بدل ' + shift);
    assert.ok(f.latencyMs !== null && f.latencyMs <= 200, 'التأخر ' + f.latencyMs);
  }
});

test('F12 التاريخ: المدخلات التالفة تُرفض وتُعدّ، والصالحة تُحمَّل كما كانت', async () => {
  const B = boot(), W = B.W, t0 = 1700000040;
  if (!W.feedView) return assert.fail('لا مراقب تغذية (v3.6)');
  const ws = B.open(); B.setNow(t0 * 1000);
  const h = []; for (let s = 0; s < 300; s++) h.push([t0 - 300 + s + .3, 1.1]);
  const bad = h.slice(); bad.splice(10, 0, [null, 1], [t0 * 1000, 1.1], 'x', [t0, -1]);
  B.text(ws, '42["updateHistoryNewFast",' + JSON.stringify({ asset: A, history: bad }) + ']');
  const f = W.feedView();
  assert.equal(f.hist.rej, 4); assert.equal(f.hist.ok, 300);
  assert.equal(W.S.candles[A].length, 5);
});

test('F13 البوت لا يرسل أي شيء عبر WebSocket المنصة', async () => {
  const B = boot(), W = B.W;
  const ws = B.open();
  H.runFeed(B, A, H.randomWalkTicks(5, 7200), 3600);
  const t = H.randomWalkTicks(6, 3600, { t0: 1.7e9 + 7200 });
  for (const [ts, p] of t) { B.setNow(ts * 1000); B.ticks(ws, [[A, ts, p]]); }
  W.discovery && W.discovery.start();
  B.ticks(ws, [[A, t[t.length - 1][0] + 1, 1.1]]);
  assert.equal(ws.sent || 0, 0);
  assert.doesNotMatch(H.source(), /\.send\(/);
});

// ---------- v4.0.1: مراحل خط البيانات (عيّنات بصيغ موثّقة — ليست مسجّلة من المنصة، انظر test/fixtures) ----------
const FX = require('./fixtures/po_documented_samples.json');
const T0 = 1700000040;
function session(B) {
  const ws = B.open(); B.setNow(T0 * 1000);
  B.text(ws, FX.incoming.open); B.text(ws, FX.incoming.connect);
  return ws;
}
const pipe = W => W.feedView().pipeline;

test('F16 المراحل الخمس على جلسة بالصيغ الموثّقة: كل مرحلة تظهر فقط عند وصول دليلها، والتشخيص يسمّي المرحلة الناقصة', async () => {
  const B = boot(), W = B.W;
  if (!W.feedStages) return assert.fail('لا مراحل (قبل v4.0.1)');
  const ws = session(B);
  let P = pipe(W);
  assert.deepEqual([P.stages.connected.ok, P.stages.authenticated.ok, P.stages.subscribed.ok, P.stages.receiving.ok, P.stages.valid.ok], [true, false, false, false, false]);
  assert.match(P.why, /successauth/);
  B.text(ws, FX.incoming.successauth_hdr);
  B.text(ws, FX.incoming.updateCharts_ui);                       // حدث واجهة، ليس أسعارًا
  P = pipe(W); assert.equal(P.stages.authenticated.ok, true); assert.equal(P.stages.receiving.ok, false); assert.match(P.why, /changeSymbol/);
  ws.send(FX.outgoing.changeSymbol_str);                          // عميل المنصة يطلب الاشتراك (لا البوت)
  assert.deepEqual(ws.out, [FX.outgoing.changeSymbol_str], 'الإرسال لم يكن شفافًا');
  P = pipe(W); assert.equal(P.stages.subscribed.ok, true); assert.equal(P.subAsset, 'EURUSD_otc'); assert.match(P.why, /لا تصل رسائل الأسعار/);
  B.text(ws, FX.incoming.updateStream_hdr); B.bin(ws, JSON.stringify([['EURUSD_otc', T0 + .4, 1.08451]]));
  await B.flush();
  P = pipe(W);
  assert.deepEqual([P.stages.receiving.ok, P.stages.valid.ok], [true, true]);
  assert.equal(P.why, '');
  assert.equal(W.feedView().lastPrice, 1.08451);
});

test('F17 حل الأصل: changeSymbol برقم يُترجم عبر جدول updateAssets، والرقم المجهول يظهر صراحةً لا يُخمَّن', async () => {
  const B = boot(), W = B.W;
  if (!W.feedStages) return assert.fail('لا مراحل (قبل v4.0.1)');
  const ws = session(B);
  B.text(ws, FX.incoming.successauth_hdr);
  B.text(ws, FX.incoming.updateAssets_hdr); B.bin(ws, JSON.stringify(FX.incoming.updateAssets_bin));
  await B.flush();
  assert.equal(W.feedView().assetsKnown, 2);
  ws.send(FX.outgoing.changeSymbol_id);
  assert.equal(pipe(W).subAsset, 'EURUSD_otc');
  ws.send(FX.outgoing.changeSymbol_unknown);
  assert.equal(pipe(W).subAsset, null);
  assert.match(pipe(W).stages.subscribed.detail, /#999 \(غير معروف/);
});

test('F18 الرسائل الصادرة: لا تُسجَّل أي قيمة (جلسة/معرّف)، فقط الاسم', async () => {
  const B = boot(), W = B.W;
  if (!W.feedStages) return assert.fail('لا مراحل (قبل v4.0.1)');
  const ws = session(B);
  ws.send(FX.outgoing.auth); ws.send(FX.outgoing.ping_reply);
  const all = JSON.stringify(W.feedView()) + JSON.stringify(W.feedState()) + JSON.stringify(W.S.errors);
  for (const secret of ['SECRETSESSION', '424242']) assert.ok(!all.includes(secret), 'تسرّب ' + secret);
  assert.equal(W.feedView().outgoing.auth, 1);
  assert.deepEqual(ws.out, [FX.outgoing.auth, FX.outgoing.ping_reply]);
});

test('F19 بعد إعادة الاتصال: «مشترك» يعود ✖ حتى تعيد المنصة الاشتراك على الاتصال الجديد', async () => {
  const B = boot(), W = B.W;
  if (!W.feedStages) return assert.fail('لا مراحل (قبل v4.0.1)');
  let ws = session(B);
  B.text(ws, FX.incoming.successauth_hdr); ws.send(FX.outgoing.changeSymbol_str);
  B.ticks(ws, [['EURUSD_otc', T0 + .3, 1.1]]);
  assert.equal(pipe(W).stages.valid.ok, true);
  B.setNow(T0 * 1000 + 2000); ws.emit('close');
  assert.equal(pipe(W).stages.connected.ok, false);
  ws = B.open(); B.setNow(T0 * 1000 + 4000);
  B.text(ws, FX.incoming.successauth_hdr);
  let P = pipe(W);
  assert.deepEqual([P.stages.connected.ok, P.stages.authenticated.ok, P.stages.subscribed.ok], [true, true, false]);
  assert.equal(P.stages.valid.ok, false, 'تيكات الاتصال السابق لا تجعل الجديد «صالحًا»');
  ws.send(FX.outgoing.changeSymbol_str);
  B.ticks(ws, [['EURUSD_otc', T0 + 4.3, 1.1001]]);
  P = pipe(W); assert.equal(P.stages.valid.ok, true); assert.equal(W.feedView().reconnects, 1);
});

test('F20 تصل الأسعار لكن كلها مرفوضة: التشخيص يذكر الأسباب، ولا شموع ولا إشارات', async () => {
  const B = boot(), W = B.W;
  if (!W.feedStages) return assert.fail('لا مراحل (قبل v4.0.1)');
  const ws = session(B);
  B.text(ws, FX.incoming.successauth_hdr); ws.send(FX.outgoing.changeSymbol_str);
  for (let i = 0; i < 300; i++) B.ticks(ws, [['EURUSD_otc', (T0 + i) * 1000, 1.1]]);  // مللي ثانية: كلها تُرفض
  const P = pipe(W);
  assert.equal(P.stages.receiving.ok, true); assert.equal(P.stages.valid.ok, false);
  assert.match(P.why, /كل التيكات تُرفض.*مللي/);
  assert.equal((W.S.candles.EURUSD_otc || []).length, 0);
  assert.equal(W.S.log.length, 0);
});

test('F21 إطار ثنائي بلا حدث ينتظره: يُعدّ وتُحفظ بنيته فقط (بلا قيم)، وليس خطأ', async () => {
  const B = boot(), W = B.W;
  if (!W.feedStages) return assert.fail('لا مراحل (قبل v4.0.1)');
  const ws = session(B);
  B.bin(ws, JSON.stringify({ balance: 777.77, isDemo: 1 }));
  B.bin(ws, JSON.stringify([['EURUSD_otc', T0 + .5, 1.0901]]));
  await B.flush();
  const f = W.feedView(), js = JSON.stringify(f);
  assert.equal(f.unpaired.n, 2);
  assert.ok(!js.includes('777.77') && !js.includes('1.0901'), 'قيم في التشخيص');
  assert.ok(f.unpaired.skeletons.some(s => s.includes('balance')));
  assert.equal(f.parseErrors.length, 0);
  assert.equal(f.ticks.ok, 0, 'إطار غير مقترن لا يُعامل كأسعار بالتخمين');
});

test('F22 NotAuthorized يظهر في المرحلة والتشخيص وسجل الأخطاء', async () => {
  const B = boot(), W = B.W;
  if (!W.feedStages) return assert.fail('لا مراحل (قبل v4.0.1)');
  const ws = session(B);
  B.text(ws, FX.incoming.notauthorized);
  assert.match(pipe(W).why, /NotAuthorized/);
  assert.ok(W.S.errors.some(e => e.code === 'PO_AUTH'));
});

test('F23 فحص بيئة الصفحة: Worker وSharedWorker وiframe تُعدّ دون تعديل سلوكها', () => {
  const { installEnvProbe } = require('../src/platform/env');
  const made = [];
  class NativeWorker { constructor(u, o) { made.push([u, o]); } }
  const win = { location: { href: 'https://pocketoption.com/en/cabinet/' }, Worker: NativeWorker, document: { querySelectorAll: () => [{ src: 'https://charts.example/x' }, { src: '' }] } };
  const seen = [];
  const p = installEnvProbe(win, s => seen.push(s.workers));
  const w = new win.Worker('/js/quotes.worker.js', { type: 'module' });
  assert.ok(w instanceof NativeWorker);
  assert.deepEqual(made, [['/js/quotes.worker.js', { type: 'module' }]]);
  const s = p.snapshot();
  assert.equal(s.workers, 1); assert.equal(s.workerHosts['pocketoption.com'], 1); assert.equal(s.frames, 2);
  installEnvProbe(win, () => {}); new win.Worker('/a.js');
  assert.equal(made.length, 2, 'التركيب المزدوج لا يكرر');
});
