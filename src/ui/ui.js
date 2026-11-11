'use strict';
// الواجهة — عرض فقط. لا تحسب أي مؤشر أو إحصاء ولا تكتب في حالة المحرك مباشرة:
// تقرأ بيانات جاهزة من نموذج العرض (engine/viewmodel.js) وتنفّذ أوامر صريحة (engine/commands.js).
// لا يوجد فيها أي زر أو كود تنفيذ على المنصة. النقرات الوحيدة: رابط تنزيل وحقلا اختيار ملف يملكهما البوت.
const UI_KEY = 'wsnf33s_ui';
const ESC = s => String(s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const pc = (x, d = 0) => (x * 100).toFixed(d) + '%';
const cellAcc = (n, w) => n ? Math.round(w / n * 1000) / 10 + '%' : '-';
function resLabel(e) {
  if (e.win === null) return e.failed ? 'فشل (افتراضي)' : e.voided ? 'ملغاة' : e.stale ? 'غير معروفة' : e.tie ? 'تعادل' : '...';
  return (e.win ? 'ربح' : 'خسارة') + ' افتراضي';
}
const kindLabel = e => e.auto ? 'صفقة افتراضية' : e.try ? 'محاولة افتراضية' : 'إشارة فقط';
const EV_LABEL = { start: 'بدء', gap: 'فجوة', ws_down: 'انقطاع الاتصال', ws_up: 'عودة الاتصال', stale: 'تقادم السعر', reject: 'رفض شمعة', hist: 'تاريخ من المنصة', tf: 'تغيير الإطار', cap: 'بلوغ الحد', import: 'استيراد', clear: 'مسح', rec_on: 'تشغيل التسجيل', rec_off: 'إيقاف التسجيل' };
const utc = s => s === null || s === undefined ? '-' : new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ');

const CSS = `
:host{all:initial}*{box-sizing:border-box;margin:0}
.full{position:fixed;inset:0;z-index:2147483647;overflow:auto;direction:rtl;font:13px/1.6 "Segoe UI",Tahoma,sans-serif;color:#e8ecff;background:#070b1ef7;padding:18px;animation:fin .5s ease both}
.full::before{content:"";position:fixed;inset:-20%;background:radial-gradient(600px 400px at 80% 10%,#4b5bff33,transparent 70%),radial-gradient(500px 380px at 10% 90%,#3ddbb022,transparent 70%);animation:drift 18s ease-in-out infinite alternate;pointer-events:none;z-index:-1}
@keyframes drift{from{transform:translate(0,0)}to{transform:translate(40px,-30px)}}
@keyframes fin{from{opacity:0;transform:scale(.985)}to{opacity:1;transform:none}}
.full.hide{display:none}
.splash{position:fixed;inset:0;z-index:2147483647;display:grid;place-content:center;justify-items:center;gap:18px;background:radial-gradient(circle at 50% 40%,#1b2a7a,#070b1e 70%);direction:rtl;transition:opacity .8s ease,visibility .8s}
.splash.out{opacity:0;visibility:hidden}
.sp-ring{position:absolute;width:260px;height:260px;border-radius:50%;border:2px solid transparent;border-top-color:#7aa2ff;border-right-color:#3ddbb0;animation:spin 1.6s linear infinite;opacity:.8}
.sp-ring.r2{width:200px;height:200px;border-top-color:#3ddbb0;border-right-color:transparent;animation-duration:1.1s;animation-direction:reverse}
@keyframes spin{to{transform:rotate(360deg)}}
.sp-logo{position:relative;font-size:46px;font-weight:900;letter-spacing:2px;display:flex;gap:2px;direction:ltr}
.sp-logo .ch{display:inline-block;background:linear-gradient(180deg,#fff,#7aa2ff 55%,#3ddbb0);-webkit-background-clip:text;background-clip:text;color:transparent;opacity:0;transform:translateY(-40px) scale(.6);animation:drop .7s cubic-bezier(.2,1.4,.4,1) forwards;animation-delay:calc(var(--i) * .08s + .2s)}
.sp-logo .sp{width:14px}
@keyframes drop{to{opacity:1;transform:none}}
.sp-sub{position:relative;color:#8fa0d6;font-size:13px;letter-spacing:1px;opacity:0;animation:fadeup .6s ease forwards 1.4s}
.sp-bar{position:relative;width:260px;height:4px;border-radius:4px;background:#1f2a60;overflow:hidden;opacity:0;animation:fadeup .4s ease forwards 1.2s}
.sp-bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#7aa2ff,#3ddbb0);box-shadow:0 0 12px #3ddbb0;animation:load 1.6s ease forwards 1.2s}
@keyframes load{to{width:100%}}
@keyframes fadeup{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px;padding:10px 14px;border:1px solid #1f2a60;border-radius:16px;background:linear-gradient(90deg,#0e1538cc,#0b1230cc)}
.brand{font-size:20px;font-weight:900;display:flex;gap:2px;align-items:center;letter-spacing:.5px;direction:ltr}
.brand .ch{display:inline-block;background:linear-gradient(180deg,#ffffff,#7aa2ff 60%,#3ddbb0);-webkit-background-clip:text;background-clip:text;color:transparent;animation:wave 2.6s ease-in-out infinite;animation-delay:calc(var(--i) * .09s)}
.brand .sp{width:6px}
.brand .dot{width:10px;height:10px;border-radius:50%;background:#3ddbb0;box-shadow:0 0 14px #3ddbb0;animation:pl 1.6s infinite;margin-inline-start:8px}
.brand small{color:#7f8cc4;font-weight:500;font-size:11.5px;margin-inline-start:8px;letter-spacing:0;direction:rtl}
@keyframes wave{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
@keyframes pl{50%{opacity:.35;transform:scale(.7)}}
.nav{display:flex;gap:6px;flex-wrap:wrap}
.nav button{border-radius:12px;padding:7px 14px;background:transparent;border:1px solid #26336e;color:#9fb0e6}
.nav button.on{background:linear-gradient(135deg,#3b4fd6,#1fa98a);color:#fff;border-color:transparent;box-shadow:0 6px 18px #3b4fd655}
.chips{display:flex;gap:8px;flex-wrap:wrap}
.chip{padding:2px 10px;border-radius:20px;font-size:11.5px;border:1px solid #26336e;background:#131c42;white-space:nowrap}
.c-u{color:#3ddbb0;border-color:#3ddbb066}.c-d{color:#ff6b7a;border-color:#ff6b7a66}.c-g{color:#f5c45e;border-color:#f5c45e66}.c-m{color:#8d9ad0}
button,select,input{font:inherit;color:#e8ecff;background:#131c42;border:1px solid #26336e;border-radius:10px;padding:6px 12px;cursor:pointer;transition:transform .15s,background .2s,border-color .2s,box-shadow .2s}
button:hover{transform:translateY(-1px);border-color:#4a5bb0;box-shadow:0 4px 14px #0006}
button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #f5c45e}
.page{display:none;animation:fin .35s ease both}
.page.on{display:grid;gap:14px}
.p-home{grid-template-columns:340px 1fr}
.p-chart,.p-log{grid-template-columns:1fr}
.p-strat{grid-template-columns:1.3fr 1fr}
@media(max-width:1000px){.p-home,.p-strat{grid-template-columns:1fr}}
.card{background:linear-gradient(160deg,#16204bd9,#0c1334d9);border:1px solid #1f2a60;border-radius:18px;padding:14px;box-shadow:0 14px 34px #0007;animation:fin .5s ease both;position:relative;overflow:hidden}
.card h3{font-size:12.5px;color:#8fa0d6;font-weight:700;margin-bottom:10px;letter-spacing:.3px;display:flex;justify-content:space-between;align-items:center;gap:8px}
.hero{text-align:center;transition:box-shadow .5s,border-color .5s}
.hero.u{border-color:#3ddbb0;box-shadow:0 0 44px #3ddbb033}
.hero.d{border-color:#ff6b7a;box-shadow:0 0 44px #ff6b7a33}
.gw{position:relative;width:190px;height:190px;margin:6px auto}
.gw svg{width:100%;height:100%;transform:rotate(-90deg)}
.gw circle{fill:none;stroke-width:10;stroke-linecap:round}
.gbg{stroke:#1f2a60}
.gfg{stroke:#8d9ad0;stroke-dasharray:326.7;stroke-dashoffset:326.7;transition:stroke-dashoffset 1s cubic-bezier(.2,.8,.2,1),stroke .4s;filter:drop-shadow(0 0 6px currentColor)}
.gm{position:absolute;inset:0;display:grid;place-content:center}
.gm b{font-size:30px;font-weight:900}
.arrow{font-size:34px;line-height:1;transition:transform .4s}
.hero.u .arrow{animation:bob 1.2s ease-in-out infinite}
.hero.d .arrow{animation:bob 1.2s ease-in-out infinite reverse}
@keyframes bob{50%{transform:translateY(-5px)}}
.dirT{font-size:19px;font-weight:800;margin:6px 0}
.notes{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin:8px 0}
.cdb{height:6px;border-radius:6px;background:#1f2a60;overflow:hidden;margin-top:8px}
.cdb i{display:block;height:100%;width:0;background:linear-gradient(90deg,#7aa2ff,#3ddbb0);transition:width 1s linear}
.row{display:flex;gap:8px;align-items:center;justify-content:space-between;margin:8px 0;flex-wrap:wrap}
.tgl{min-width:130px;font-weight:700}
.tgl.on{background:linear-gradient(135deg,#3ddbb0,#1fa98a)!important;color:#06281f!important;border-color:transparent!important}
.checks{list-style:none;padding:0;display:grid;gap:6px}
.checks li{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;padding:6px 8px;border-radius:10px;background:#0a0f2a88;border:1px solid #1f2a60}
.checks li b{width:16px;text-align:center;flex:none}
.checks li.ok b{color:#3ddbb0}.checks li.no b{color:#ff6b7a}
.checks li.ok{border-color:#3ddbb044}
.score{display:flex;align-items:center;justify-content:space-around;gap:10px;padding:6px 0}
.score div{text-align:center}
.score b{display:block;font-size:44px;font-weight:900;line-height:1;text-shadow:0 0 22px currentColor}
.score span{color:#8fa0d6;font-size:12px}
.score .vs{font-size:30px;color:#3b4a88;text-shadow:none}
.wr{height:10px;border-radius:10px;background:#1f2a60;overflow:hidden;margin-top:12px}
.wr i{display:block;height:100%;width:0;background:linear-gradient(90deg,#ff6b7a,#f5c45e,#3ddbb0);transition:width .8s cubic-bezier(.2,.8,.2,1)}
.wrt{display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;font-size:11.5px;color:#8fa0d6;margin-top:4px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.st{background:#0a0f2a99;border:1px solid #1f2a60;border-radius:12px;padding:8px 10px}
.st span{color:#8fa0d6;font-size:11px;display:block}
.st b{display:block;font-size:17px}
.st small{font-size:11px;color:#8fa0d6}
.mem{display:grid;gap:8px;font-size:12px}
.mem .row{margin:0}
canvas{width:100%;height:420px;display:block;border-radius:12px;background:#0a0f29}
table{width:100%;border-collapse:collapse;font-size:12px}
th{color:#8fa0d6;font-weight:600;text-align:right;padding:6px 5px;position:sticky;top:0;background:#0f1638}
td{padding:6px 5px;border-top:1px solid #1f2a6088}
tbody tr{transition:background .2s}tbody tr:hover{background:#1a2456aa}
.wb{display:block;height:6px;border-radius:6px;background:linear-gradient(90deg,#7aa2ff,#3ddbb0)}
.w{color:#3ddbb0}.l{color:#ff6b7a}
.scroll{max-height:480px;overflow:auto}
.note{color:#8fa0d6;font-size:11.5px;line-height:1.8}
.warn{color:#f5c45e}
.btn-danger{color:#ff8a95;border-color:#ff6b7a55}
.modal{position:fixed;inset:0;display:none;place-items:center;background:#020510aa;z-index:2147483647;direction:rtl;font:13px/1.6 "Segoe UI",Tahoma,sans-serif;color:#e8ecff}
.modal.show{display:grid}
.mbox{width:min(460px,92vw);padding:18px;border-radius:20px;background:linear-gradient(160deg,#16204b,#0c1334);border:2px solid #4a5bb0;box-shadow:0 20px 60px #000c;animation:fin .25s ease both}
.mbox h2{font-size:17px;margin-bottom:10px}
.mok{background:linear-gradient(135deg,#3b4fd6,#1fa98a);border-color:transparent;font-weight:800}
.mok:disabled{opacity:.35;cursor:not-allowed}
.exbtns{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.ex{padding:14px 8px;font-size:16px;font-weight:900;border-radius:14px;letter-spacing:.3px}
.ex.call:not(:disabled){background:linear-gradient(135deg,#3ddbb0,#1fa98a);color:#06281f;border-color:transparent}
.ex.put:not(:disabled){background:linear-gradient(135deg,#ff6b7a,#d63a4b);color:#2a060b;border-color:transparent}
.ex:disabled{opacity:.35;cursor:not-allowed;transform:none;box-shadow:none}
.ex:not(:disabled){animation:pl 1.4s infinite}
.shine::after{content:"";position:absolute;inset:0;background:linear-gradient(110deg,transparent 30%,#ffffff12 50%,transparent 70%);transform:translateX(-100%);animation:shine 5s ease-in-out infinite;pointer-events:none}
@keyframes shine{0%,60%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
.flash{position:fixed;inset:0;display:none;place-items:center;pointer-events:none;z-index:2147483646}
.flash.show{display:grid}
.fbox{padding:26px 38px;border-radius:24px;text-align:center;background:#0b1230e6;border:2px solid;box-shadow:0 0 60px currentColor;animation:pop 2.2s ease forwards}
.fbox b{display:block;font-size:44px;font-weight:900;letter-spacing:1px}
.fbox span{font-size:14px;color:#c9d3ff}
.flash.call .fbox,.flash.win .fbox{color:#3ddbb0}
.flash.put .fbox,.flash.loss .fbox{color:#ff6b7a}
@keyframes pop{0%{opacity:0;transform:scale(.4) rotate(-6deg)}12%{opacity:1;transform:scale(1.08) rotate(0)}22%{transform:scale(1)}78%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(.96)}}
.tick{display:flex;gap:6px;overflow:hidden;white-space:nowrap;flex-wrap:wrap}
.tick span{padding:3px 10px;border-radius:8px;font-size:11.5px;animation:slide .6s ease both;border:1px solid #26336e}
@keyframes slide{from{transform:translateY(-8px);opacity:0}to{transform:none;opacity:1}}
.mini{position:fixed;z-index:2147483647;width:74px;height:74px;border-radius:20px;display:none;place-content:center;text-align:center;cursor:pointer;user-select:none;touch-action:none;background:linear-gradient(160deg,#1b2556,#0f1638);border:2px solid #26336e;color:#e8ecff;font:12px/1.3 "Segoe UI",Tahoma,sans-serif;box-shadow:0 8px 28px #0009;transition:border-color .4s,box-shadow .4s;animation:fin .4s ease both}
.mini.show{display:grid}
.mini b{font-size:24px;display:block}
.mini.u{border-color:#3ddbb0;box-shadow:0 0 22px #3ddbb055}
.mini.d{border-color:#ff6b7a;box-shadow:0 0 22px #ff6b7a55}
.mini .ad{position:absolute;top:6px;right:6px;width:9px;height:9px;border-radius:50%;background:#3ddbb0;display:none}
.mini.auto .ad{display:block;animation:pl 1.2s infinite}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;
const NAME = 'wsnf smart bot';
const letters = s => [...s].map((ch, i) => ch === ' ' ? '<span class="sp"></span>' : `<span class="ch" style="--i:${i}">${ch}</span>`).join('');
const HTML = `
<div class="splash" id="splash">
  <div class="sp-ring"></div><div class="sp-ring r2"></div>
  <div class="sp-logo">${letters(NAME)}</div>
  <div class="sp-sub">تحليل • تعلّم • محاكاة</div>
  <div class="sp-bar"><i></i></div>
</div>
<div class="full" id="full">
<header>
  <div class="brand">${letters(NAME)}<i class="dot"></i><small>v4.0 (تطوير) · محاكاة فقط</small></div>
  <nav class="nav" id="nav">
    <button data-p="home" class="on">الرئيسية</button>
    <button data-p="chart">الشارت</button>
    <button data-p="strat">الاستراتيجيات</button>
    <button data-p="lab">المختبر</button>
    <button data-p="log">السجل</button>
    <button data-p="rec">المسجّل</button>
    <button data-p="mem">الذاكرة</button>
    <button data-p="err">الأخطاء</button>
  </nav>
  <div class="chips" id="chips"></div>
  <button id="min">تصغير ▾</button>
</header>
<section class="page p-home on" data-page="home">
  <div style="display:grid;gap:14px;align-content:start">
    <div class="card" id="feedCard" data-v4>
      <h3>اتصال المنصة وحالة البيانات <span class="chip" id="feedBadge">—</span></h3>
      <div class="stats" id="feedSt"></div>
      <div class="note" id="feedNote"></div>
    </div>
    <div class="card hero shine" id="hero">
      <h3><span id="assetT">—</span></h3>
      <div class="gw">
        <svg viewBox="0 0 120 120"><circle class="gbg" cx="60" cy="60" r="52"/><circle class="gfg" id="arc" cx="60" cy="60" r="52"/></svg>
        <div class="gm"><div class="arrow" id="arrow">—</div><b id="conf">0</b><small style="display:block;font-size:10px;opacity:.75">قوة الإشارة (ليست احتمالًا)</small></div>
      </div>
      <div class="dirT" id="dirT">أحلّل السوق...</div>
      <div class="chip" id="badge">—</div>
      <div class="notes" id="notes"></div>
      <div class="cdb"><i id="cdb"></i></div>
      <div class="note" id="cdt"></div>
    </div>
    <div class="card" id="simCard">
      <h3>وضع المحاكاة (Paper Trading)</h3>
      <div class="note"><b class="w">🛡 محاكاة فقط:</b> البوت لا ينقر أي زر في المنصة ولا يرسل أي أمر ولا يقرأ المبلغ أو الرصيد. كل «صفقة» هنا افتراضية تُحسب نتيجتها من أسعار التيك، ولا علاقة لها بحسابك.</div>
      <div class="note" id="simSt"></div>
    </div>
    <div class="card">
      <h3>التحكم</h3>
      <div class="row">
        <button class="tgl" id="auto">الدخول الآلي الافتراضي: متوقف</button>
        <button class="tgl" id="gate">بوابة الإثبات: تعمل</button>
      </div>
      <div class="row"><button class="btn-danger" id="kill">⛔ إيقاف طارئ</button></div>
      <div class="row"><span>أقل قوة إشارة <b id="cv">65</b></span><input id="cs" type="range" min="50" max="90" value="65" style="flex:1"></div>
      <div class="row"><span>مدة الشمعة</span>
        <select id="tf"><option value="15">15 ثانية</option><option value="30">30 ثانية</option><option value="60" selected>دقيقة</option></select>
        <button id="lock">قفل الأصل</button>
      </div>
      <div class="row"><span>العائد % للأصل الحالي</span><input id="po" type="number" min="60" max="98" value="92" style="width:80px"><span class="note" id="beN"></span></div>
      <div class="note" id="ctlnote"></div>
    </div>
  </div>
  <div style="display:grid;gap:14px;align-content:start">
    <div class="card shine">
      <h3>نتائج الإشارات (افتراضية) <span id="sessNote" class="note"></span></h3>
      <div class="score">
        <div><b class="w" id="sw">0</b><span>ربح</span></div>
        <div class="vs">:</div>
        <div><b class="l" id="sl">0</b><span>خسارة</span></div>
      </div>
      <div class="wr"><i id="wr"></i></div>
      <div class="wrt"><span id="wrL">نسبة الربح: —</span><span id="lifeL">الإجمالي: —</span></div>
    </div>
    <div class="card">
      <h3>فحص الإشارة قبل الدخول</h3>
      <ul class="checks" id="checks"></ul>
      <div class="note" id="decNote"></div>
    </div>
    <div class="card">
      <h3>الإحصاءات</h3>
      <div class="stats" id="stats"></div>
    </div>
  </div>
</section>
<section class="page p-chart" data-page="chart">
  <div class="card">
    <h3><span>الشارت (آخر 90 شمعة من أصل 5000)</span></h3>
    <div class="tick" id="tick" style="margin-bottom:10px"></div>
    <canvas id="cv2"></canvas>
  </div>
</section>
<section class="page p-strat" data-page="strat">
  <div class="card">
    <h3>الاستراتيجيات الـ17 (تتعلم ذاتيًا)</h3>
    <div class="scroll">
      <table><thead><tr><th>الاسم</th><th>النوع</th><th>عينة</th><th>دقة</th><th>حد أدنى</th><th>وزن</th><th>الحالة</th></tr></thead><tbody id="strat"></tbody></table>
    </div>
  </div>
  <div class="card">
    <h3>دقة الإشارات حسب الثقة (حي فقط)</h3>
    <table><thead><tr><th>الفئة</th><th>عينة</th><th>دقة</th><th>الدخول الآلي</th></tr></thead><tbody id="bks"></tbody></table>
  </div>
</section>
<section class="page p-lab" data-page="lab" style="grid-template-columns:1fr">
  <div class="card">
    <h3>جودة البيانات والتدقيق</h3>
    <div class="stats" id="labQ"></div>
    <div class="note">تُقاس الفجوات الزمنية والشموع المسطحة والقفزات الشاذة وتأخر التيك. تحت حد الجودة لا تصدر توصية. التدقيق يتأكد أن كل تحليل بُني على شمعة مغلقة وأن قراءات الشمعة السابقة لا تتغير بعد إغلاقها. أثناء إعادة تشغيل التاريخ لا يُستخدم إلا ما تعلّمه البوت حتى تلك اللحظة.</div>
  </div>
  <div class="card">
    <h3>مقارنة مدد الانتهاء (على إشارات الأساس)</h3>
    <div class="scroll"><table><thead><tr><th>المدة</th><th>حي: عينة</th><th>دقة</th><th>حد أدنى</th><th>تاريخ: عينة</th><th>دقة</th><th></th></tr></thead><tbody id="labH"></tbody></table></div>
    <div class="note" id="labHn"></div>
    <div class="scroll"><table id="labRM"></table></div>
    <div class="note">المدد مضاعفات الشمعة. الدقة في المصفوفة تجمع الحي والتاريخ لكل حالة سوق (تظهر بعد 20 حالة).</div>
  </div>
  <div class="card">
    <h3>فلتر الإشارات الكاذبة: أداء الإشارات المحجوبة</h3>
    <div class="scroll"><table><thead><tr><th>الفحص</th><th>عدد المحجوبة</th><th>دقتها لو دخلنا</th><th>الحكم</th></tr></thead><tbody id="labV"></tbody></table></div>
    <div class="note">الفحص مفيد إذا كانت الإشارات التي يحجبها أقل دقة من نقطة التعادل. إن حجب إشارات رابحة فهو مرشح للإلغاء.</div>
  </div>
  <div class="card">
    <h3>أداء كل حالة سوق (لو دخلنا بلا فلتر الحالة)</h3>
    <div class="scroll"><table><thead><tr><th>الحالة</th><th>عدد الإشارات</th><th>الدقة</th><th>الحكم</th></tr></thead><tbody id="labCX"></tbody></table></div>
    <div class="note">قبل كل توصية يحدد البوت حالة السوق (اتجاه، نطاق، اختراق صالح/وهمي، انعكاس، انضغاط، فوضى). «انضغاط/فوضوي/غير واضح» ممنوع فيها الدخول، وبقية الحالات يُسمح فيها باتجاه واحد فقط. هذا الجدول يقيس هل الحالة المسموحة رابحة فعلًا.</div>
  </div>
  <div class="card">
    <h3>مقارنة الاستراتيجيات: الأصل × حالة السوق × مدة الصفقة</h3>
    <div class="scroll"><table id="labSC"></table></div>
    <div class="note" id="labSCn"></div>
    <div class="note">كل خلية دقة إشارة الاستراتيجية بعد N شمعات على هذا الأصل وفي حالة السوق الحالية. الاستراتيجية «المختارة» هي التي يتجاوز حدها الأدنى (Wilson) نقطة التعادل، وتُوزن في القرار حسب أدائها في هذه الحالة. «أنسب مدة» تظهر في شرائح التحليل للإشارة الحالية؛ مدة الصفقة الفعلية تبقى ما تضبطه أنت في المنصة.</div>
  </div>
  <div class="card">
    <h3>اختبار الاستراتيجيات المعدّلة قبل اعتمادها (✦)</h3>
    <div class="scroll"><table><thead><tr><th>الاستراتيجية</th><th>القديمة</th><th>المعدّلة</th><th>العينة</th><th>المستخدمة الآن</th><th>الحكم</th></tr></thead><tbody id="labVT"></tbody></table></div>
    <div class="note" id="labVL"></div>
    <div class="note">النسختان تعملان على نفس الشموع. لا تُعتمد المعدّلة إلا بعد ≥100 إشارة لكل منهما وتفوق ≥1% بدلالة z ≥ 1 ودون فقدان أكثر من ثلاثة أرباع التغطية، وتُسحب تلقائيًا إن ثبت أنها أسوأ. النتائج الحية تُفضَّل على التاريخية.</div>
  </div>
  <div class="card">
    <h3>عزل المؤشرات المتشابهة</h3>
    <div class="scroll"><table><thead><tr><th>العنقود (يُعدّ دليلًا مستقلًا واحدًا)</th><th>الحالة</th></tr></thead><tbody id="labCR"></tbody></table></div>
    <div class="note" id="labCRn"></div>
    <div class="note">داخل كل عنقود يُخفَّض وزن كل مؤشر حسب الارتباط المقاس بين إشاراتها (مؤشران متطابقان = دليل واحد). إن ثبت تطابق مجموعتين مختلفتين (متوسط ρ ≥ 0.6 عبر ≥3 أزواج، كل زوج ≥100 حالة) دُمجتا، فلا تُحسبان اتفاقًا مستقلًا.</div>
  </div>
  <div class="card">
    <h3>الامتناع عند غياب فرصة واضحة</h3>
    <div class="stats" id="labAb"></div>
    <div class="note">الامتناع مفيد إذا كانت دقة الحالات التي امتنع عنها أقل من دقة المُصدرة.</div>
  </div>
  <div class="card">
    <h3>مختبر التجارب (صفقات ظلّية لا تؤثر على القرار)</h3>
    <div class="scroll"><table><thead><tr><th>التجربة</th><th>حي: عينة</th><th>دقة</th><th>حد ويلسون</th><th>تاريخ: عينة</th><th>دقة</th><th>الحالة</th><th></th></tr></thead><tbody id="labX"></tbody></table></div>
    <div class="note">لا تُعتمد تجربة إلا بعد عينة حية كافية وحد أدنى فوق التعادل وتفوّق على الأساس بـ 2% على الأقل.</div>
    <div class="row"><button id="labReset">إرجاع القواعد للإعدادات الافتراضية</button></div>
  </div>
  <div class="card">
    <h3>الدفتر والنسخة الاحتياطية</h3>
    <div class="stats" id="labJ"></div>
    <div class="note">كل إشارة مرشحة ونتائجها بمدد مختلفة تُحفظ في المتصفح ونسخة ثانية في IndexedDB. إن مُسح التخزين المحلي تُستعاد الذاكرة تلقائيًا.</div>
  </div>
</section>
<section class="page p-log" data-page="log">
  <div class="card">
    <h3>سجل الإشارات والصفقات الافتراضية (محفوظ)</h3>
    <div class="scroll">
      <table><thead><tr><th>الوقت</th><th>الأصل</th><th>الاتجاه</th><th>القوة</th><th>النوع</th><th>النتيجة</th><th>السبب / سبب عدم الدخول</th></tr></thead><tbody id="log"></tbody></table>
    </div>
  </div>
</section>
<section class="page p-rec" data-page="rec" style="grid-template-columns:1fr">
  <div class="card">
    <h3>مسجّل الشموع (محلي — للمحاكاة والتحليل فقط)</h3>
    <div class="stats" id="recSt"></div>
    <div class="row">
      <button class="tgl" id="recOn">التسجيل: يعمل</button>
      <button id="recExpJ">تصدير الكل JSONL</button>
      <button id="recExpC">تصدير الكل CSV</button>
      <button id="recExpCur">تصدير الأصل الحالي JSONL</button>
      <button id="recImp">استيراد (JSONL/CSV)</button>
      <input type="file" id="recImpFile" accept=".jsonl,.json,.csv,text/plain" style="display:none">
      <button id="recScan">فحص الفجوات المخزّنة</button>
    </div>
    <div class="note" id="recMsg"></div>
    <div class="note">تُحفظ كل شمعة مكتملة بعد انتهائها فقط في قاعدة IndexedDB منفصلة داخل متصفحك. لا يُرسل شيء خارج المتصفح. الشموع الناقصة تُرفض ولا تُخزَّن، والمكررة لا تُكرَّر (التسجيل الحي يستبدل التاريخي للشمعة نفسها). مصدر الأسعار تيكات المنصة: دقة القمة/القاع محدودة بمعدل التيكات (عددها محفوظ مع كل شمعة).</div>
  </div>
  <div class="card">
    <h3>السلاسل المحفوظة (أصل × إطار)</h3>
    <div class="scroll"><table><thead><tr><th>الأصل</th><th>الإطار</th><th>الشموع</th><th>من (UTC)</th><th>إلى (UTC)</th><th>فجوات</th><th>شموع مفقودة</th></tr></thead><tbody id="recSer"></tbody></table></div>
  </div>
  <div class="card">
    <h3>أسباب رفض الشموع (هذه الجلسة)</h3>
    <div class="scroll"><table><thead><tr><th>السبب</th><th>العدد</th></tr></thead><tbody id="recRej"></tbody></table></div>
  </div>
  <div class="card">
    <h3>أحداث التسجيل (الفجوات، الانقطاع، التاريخ...)</h3>
    <div class="scroll"><table><thead><tr><th>الوقت</th><th>الحدث</th><th>التفاصيل</th></tr></thead><tbody id="recEv"></tbody></table></div>
    <div class="row"><button class="btn-danger" id="recClr">مسح كل الشموع المسجّلة</button></div>
  </div>
</section>
<section class="page p-mem" data-page="mem" style="grid-template-columns:1fr">
  <div class="card">
    <h3>ذاكرة البوت</h3>
    <div class="mem">
      <div class="st"><span>آخر حفظ</span><b id="memAt" style="font-size:14px">—</b></div>
      <div class="st"><span>أفضل فئة ثقة تعلّمها</span><b id="memBest" style="font-size:14px">—</b></div>
      <div class="st"><span>الصفقات المحفوظة في السجل</span><b id="memLog">0</b></div>
      <div class="row">
        <button id="exp">تصدير نسخة احتياطية</button>
        <button id="imp">استيراد نسخة</button>
        <input type="file" id="impFile" accept="application/json" style="display:none">
      </div>
      <div class="row"><button class="btn-danger" id="reset">مسح كل التعلّم</button></div>
      <div class="note">الذاكرة وإعدادات الحماية والإحصاءات تُحفظ تلقائيًا داخل المتصفح. إن مسحت بيانات الموقع ستضيع، لذلك صدّر نسخة احتياطية من وقت لآخر.</div>
    </div>
  </div>
</section>
<section class="page p-err" data-page="err" style="grid-template-columns:1fr">
  <div class="card" data-v4>
    <h3>استكشاف بيانات المنصة (تشخيص)</h3>
    <div class="note">تسجّل هذه الأداة <b>أسماء</b> الرسائل التي تصل من المنصة و<b>بنيتها</b> (الأنواع والمفاتيح) لمعرفة الصيغ الحقيقية بدل تخمينها. لا تسجّل قيم أي رسالة فيها مفتاح يوحي بالحساب أو الهوية (رصيد، بريد، مستخدم، جلسة…)، ولا الرسائل الصادرة، ولا عناوين الاتصال الكاملة. تتوقف تلقائيًا بعد 10 دقائق. راجع الملف قبل مشاركته.</div>
    <div class="row"><button class="tgl" id="discOn">بدء الاستكشاف</button><button id="discExp">تصدير التقرير</button></div>
    <div class="note" id="discSt"></div>
  </div>
  <div class="card" data-v4>
    <h3>رسائل المنصة والأخطاء في البيانات</h3>
    <div class="stats" id="feedMsgs"></div>
    <div class="scroll"><table><thead><tr><th>الحدث</th><th>العدد</th><th>النوع</th></tr></thead><tbody id="feedEv"></tbody></table></div>
    <div class="scroll"><table><thead><tr><th>سبب رفض التيك</th><th>العدد</th></tr></thead><tbody id="feedRej"></tbody></table></div>
    <div class="scroll"><table><thead><tr><th>الوقت</th><th>خطأ تحليل رسالة</th></tr></thead><tbody id="feedErr"></tbody></table></div>
  </div>
  <div class="card">
    <h3>سجل الأخطاء والأحداث</h3>
    <div class="row"><button id="expDiag">تصدير التشخيص</button><button id="clrErr">مسح السجل</button></div>
    <div class="scroll"><table><thead><tr><th>الوقت</th><th>الرمز</th><th>الوصف</th></tr></thead><tbody id="errs"></tbody></table></div>
  </div>
  <div class="card">
    <h3>تتبع أحداث المحاكاة (آخر 40)</h3>
    <div class="scroll"><table><thead><tr><th>الوقت</th><th>النوع</th><th>الحدث</th></tr></thead><tbody id="trc"></tbody></table></div>
    <div class="note">أحداث الأوامر الافتراضية فقط. لا تُرسل أي أوامر إلى المنصة.</div>
  </div>
</section>
</div>
<div class="flash" id="flash"><div class="fbox" id="fbox"><b id="fA">—</b><span id="fS"></span></div></div>
<div class="mini" id="mini"><span class="ad"></span><div><b id="mA">—</b><span id="mT">انتظار</span></div></div>`;


// app: الواجهة لا تعرف المحرك إلا عبر هذا الكائن:
//   app.vm   { view(shown), lab(), recorder(), chart(), settings() }  — قراءة فقط (نسخ)
//   app.cmd  أوامر المحرك (القناة الوحيدة للكتابة)                   — engine/commands.js
//   app.rec  { setOn, exportFile, importFile, scanGaps, clear }       — أوامر المسجّل
//   app.on(type, fn)  أحداث المحرك ('signal'، 'result')
//   app.readShown()   اسم الأصل المعروض في صفحة المنصة (طبقة المنصة)
//   app.downloadText(name, text, mime) · app.diagnostics() · app.prefs { get(k, d), set(k, v) } تفضيلات العرض فقط
//   app.win / app.doc النافذة والمستند
function buildUI(app) {
  const doc = app.doc, win = app.win;
  if (doc.getElementById('wsnf25-host')) return null;
  const host = doc.createElement('div');
  host.id = 'wsnf25-host';
  doc.documentElement.appendChild(host);
  const sh = host.attachShadow({ mode: 'open' });
  sh.innerHTML = '<style>' + CSS + '</style>' + HTML;
  const $ = id => sh.getElementById(id);
  const ui = app.prefs.get(UI_KEY, { min: false, x: 12, y: 90 });
  const full = $('full'), mini = $('mini'), flash = $('flash'), fbox = $('fbox'), splash = $('splash');
  const st0 = app.vm.settings();
  $('cs').value = st0.minConf; $('po').value = Math.round(st0.payout * 100); $('tf').value = String(st0.tf);

  win.setTimeout(() => splash.classList.add('out'), 3000);
  win.setTimeout(() => { splash.style.display = 'none'; }, 3900);

  const setMin = m => {
    ui.min = m; app.prefs.set(UI_KEY, ui);
    full.classList.toggle('hide', m);
    mini.classList.toggle('show', m);
  };
  mini.style.left = ui.x + 'px';
  mini.style.top = ui.y + 'px';
  $('min').onclick = () => setMin(true);
  let drag = null;
  mini.onpointerdown = e => { drag = { sx: e.clientX, sy: e.clientY, x: mini.offsetLeft, y: mini.offsetTop, mv: false }; mini.setPointerCapture(e.pointerId); };
  mini.onpointermove = e => {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 5) drag.mv = true;
    if (drag.mv) { mini.style.left = Math.max(0, drag.x + dx) + 'px'; mini.style.top = Math.max(0, drag.y + dy) + 'px'; }
  };
  mini.onpointerup = () => {
    if (drag && !drag.mv) setMin(false);
    else if (drag) { ui.x = mini.offsetLeft; ui.y = mini.offsetTop; app.prefs.set(UI_KEY, ui); }
    drag = null;
  };

  const cv = $('cv2');
  $('nav').onclick = e => {
    const b = e.target.closest('button[data-p]');
    if (!b) return;
    sh.querySelectorAll('#nav button').forEach(x => x.classList.toggle('on', x === b));
    sh.querySelectorAll('.page').forEach(p => p.classList.toggle('on', p.dataset.page === b.dataset.p));
    if (b.dataset.p === 'chart') drawChart(cv, app.vm.chart());
  };

  const cmd = app.cmd;
  $('auto').onclick = () => { cmd.toggleAuto(); paint(); };
  $('kill').onclick = () => { cmd.kill(); paint(); };
  $('clrErr').onclick = () => { cmd.clearErrors(); };
  const tappedOk = app.tapped !== false;
  $('discOn').onclick = () => { if (app.discovery.status().on) app.discovery.stop(); else app.discovery.start(); paint(); };
  $('discExp').onclick = () => app.downloadText('wsnf-platform-discovery-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.json', JSON.stringify(app.discovery.report(), null, 1), 'application/json');
  $('expDiag').onclick = () => app.downloadText('wsnf-diag-' + Date.now() + '.json', JSON.stringify(app.diagnostics(), null, 1), 'application/json');
  $('gate').onclick = () => { cmd.toggleGate(); };
  $('labX').onclick = e => { const b = e.target.closest('button[data-adopt]'); if (b) cmd.adopt(b.dataset.adopt); };
  $('labReset').onclick = () => { cmd.resetRules(); };
  $('cs').oninput = e => { $('cv').textContent = cmd.setMinConf(+e.target.value); };
  $('po').onchange = e => { $('po').value = cmd.setPayoutPct(+e.target.value); };
  $('tf').onchange = e => { if (!cmd.setTf(+e.target.value)) $('tf').value = String(app.vm.settings().tf); };
  $('lock').onclick = e => { e.target.textContent = cmd.toggleLock(app.readShown()) ? 'فك القفل' : 'قفل الأصل'; };

  $('exp').onclick = () => app.downloadText('wsnf-memory-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(cmd.exportMemory()), 'application/json');
  // ---- المسجّل ----
  const recMsg = (t, cls) => { $('recMsg').innerHTML = '<span class="' + (cls || '') + '">' + ESC(t) + '</span>'; };
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const recDl = (fmt, a) => {
    recMsg('جارٍ التصدير...');
    const tf = app.vm.settings().tf;
    app.rec.exportFile(fmt, a || null, a ? tf : null).then(x => {
      if (!x.count) { recMsg('لا توجد شموع للتصدير', 'warn'); return; }
      app.downloadText('wsnf-candles-' + (a ? a + '-' + tf + 's-' : '') + stamp() + '.' + (fmt === 'csv' ? 'csv' : 'jsonl'), x.text, fmt === 'csv' ? 'text/csv' : 'application/x-ndjson');
      recMsg('صُدّرت ' + x.count + ' شمعة (' + x.series.length + ' سلسلة)', 'w');
    }).catch(e => recMsg('فشل التصدير: ' + (e && e.message || e), 'l'));
  };
  $('recOn').onclick = () => { app.rec.setOn(!app.vm.recorder().on); paint(); };
  $('recExpJ').onclick = () => recDl('jsonl');
  $('recExpC').onclick = () => recDl('csv');
  $('recExpCur').onclick = () => { const cur = app.vm.settings().cur; if (!cur) recMsg('لا يوجد أصل حالي', 'warn'); else recDl('jsonl', cur); };
  $('recImp').onclick = () => $('recImpFile').click();
  $('recImpFile').onchange = e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const rd = new win.FileReader();
    rd.onload = () => {
      recMsg('جارٍ الاستيراد...');
      app.rec.importFile(String(rd.result)).then(o => {
        const rs = Object.entries(o.reasons).map(([k, v]) => k + ' ×' + v).join('، ');
        recMsg('قُرئ ' + o.read + ' · أُضيف ' + o.added + ' · استُبدل ' + o.replaced + ' · مكرر ' + o.dup + ' · متعارض (أُبقي الموجود) ' + o.conflicts + ' · مرفوض ' + o.rejected + (rs ? ' (' + rs + ')' : ''), o.rejected ? 'warn' : 'w');
      }).catch(err => recMsg('رُفض الملف: ' + (err && err.message || err), 'l'));
    };
    rd.readAsText(f);
    e.target.value = '';
  };
  $('recScan').onclick = () => { recMsg('جارٍ الفحص...'); app.rec.scanGaps().then(o => recMsg('اكتمل فحص ' + o.length + ' سلسلة', 'w')).catch(e => recMsg('فشل الفحص: ' + (e && e.message || e), 'l')); };
  $('recClr').onclick = () => {
    if (!win.confirm('سيُحذف كل ما سجّله المسجّل من شموع وأحداث نهائيًا. صدّر نسخة أولًا إن احتجتها. متابعة؟')) return;
    app.rec.clear().then(() => recMsg('مُسحت الشموع المسجّلة', 'warn'));
  };
  $('imp').onclick = () => $('impFile').click();
  $('impFile').onchange = e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const rd = new win.FileReader();
    rd.onload = () => {
      try { cmd.importMemory(String(rd.result)); win.alert('تم استيراد الذاكرة بنجاح'); }
      catch (err) { win.alert('فشل الاستيراد: ' + err.message); }
    };
    rd.readAsText(f);
    e.target.value = '';
  };
  $('reset').onclick = () => {
    if (!win.confirm('سيتم مسح كل ما تعلّمه البوت نهائيًا. متابعة؟')) return;
    cmd.resetLearning();
  };

  const showFlash = (cls, main, sub) => {
    flash.className = 'flash show ' + cls;
    fbox.style.animation = 'none'; void fbox.offsetWidth; fbox.style.animation = '';
    $('fA').textContent = main; $('fS').textContent = sub;
    win.clearTimeout(showFlash.t);
    showFlash.t = win.setTimeout(() => { flash.className = 'flash'; }, 2300);
  };
  // الواجهة تستمع لأحداث المحرك ولا تُدخل نفسها في مساره
  app.on('signal', e => {
    const buy = e.dir === 'call';
    showFlash(buy ? 'call' : 'put', buy ? '▲ إشارة صعود' : '▼ إشارة هبوط', (e.try ? 'صفقة افتراضية (محاكاة)' : 'إشارة فقط — لا صفقة') + ' · قوة ' + e.conf);
    const tk = $('tick');
    tk.insertAdjacentHTML('afterbegin', `<span style="color:${buy ? '#3ddbb0' : '#ff6b7a'}">${buy ? '▲' : '▼'} ${e.conf}</span>`);
    while (tk.children.length > 10) tk.lastElementChild.remove();
  });
  app.on('result', win2 => showFlash(win2 ? 'win' : 'loss', win2 ? '✔ ربح افتراضي' : '✖ خسارة افتراضية', 'نتيجة محاكاة — ليست صفقة حقيقية'));

  let lastLab = '';
  function paintRec() {
    const R = app.vm.recorder(), ss = R.sess, ser = R.series, tot = ser.reduce((a, s) => a + s.count, 0);
    $('recOn').textContent = 'التسجيل: ' + (R.on ? 'يعمل' : 'متوقف');
    $('recOn').classList.toggle('on', R.on);
    $('recSt').innerHTML =
      `<div class="st"><span>الحالة</span><b class="${R.on && R.ready && !R.err ? 'w' : 'l'}">${!R.on ? 'متوقف' : !R.ready ? 'يُهيّأ...' : R.err ? 'تحذير' : 'يسجّل'}</b><small>${ESC(R.err || (R.kind === 'indexeddb' ? 'IndexedDB (دائم)' : R.kind))}</small></div>` +
      `<div class="st"><span>الشموع المحفوظة</span><b>${tot}</b><small>${ser.length} سلسلة · ≈ ${(tot * R.bytesPer / 1048576).toFixed(1)} MB (تقدير)</small></div>` +
      `<div class="st"><span>آخر حفظ</span><b>${ss.lastFlush ? new Date(ss.lastFlush).toTimeString().slice(0, 8) : '-'}</b><small>بانتظار الحفظ: ${R.queue}${ss.flushErr ? ' · خطأ: ' + ESC(ss.flushErr) : ''}</small></div>` +
      `<div class="st"><span>هذه الجلسة</span><b>${ss.added}</b><small>جديدة · استُبدلت ${ss.replaced} · مكررة ${ss.dup} · متعارضة ${ss.conflicts}${ss.conflicts ? ' (أقصى فرق ' + (ss.maxDiff * 100).toFixed(4) + '%)' : ''}</small></div>` +
      `<div class="st"><span>مرفوضة (ناقصة/غير صالحة)</span><b class="${ss.rejected ? 'warn' : ''}">${ss.rejected}</b></div>` +
      `<div class="st"><span>فجوات مكتشفة حيًا</span><b class="${ss.gaps ? 'warn' : ''}">${ss.gaps}</b>${ss.dropped ? '<small class="l">سجلات أُسقطت: ' + ss.dropped + '</small>' : ''}</div>`;
    const sc = R.scan ? Object.fromEntries(R.scan.out.map(x => [x.a + '|' + x.tf, x])) : {};
    $('recSer').innerHTML = ser.sort((x, y) => x.a < y.a ? -1 : x.a > y.a ? 1 : x.tf - y.tf).map(s => {
      const g = sc[s.a + '|' + s.tf];
      return `<tr><td>${ESC(s.a)}</td><td>${s.tf} ث</td><td>${s.count}${s.capped ? ' <span class="chip c-d">الحد</span>' : ''}</td><td>${utc(s.first)}</td><td>${utc(s.last)}</td><td>${g ? g.gaps : '?'}</td><td>${g ? g.missing : '?'}</td></tr>`;
    }).join('') || '<tr><td colspan="7" class="note">لا شموع محفوظة بعد</td></tr>';
    $('recRej').innerHTML = Object.entries(ss.reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${ESC(k)}</td><td>${v}</td></tr>`).join('') || '<tr><td colspan="2" class="note">لا شيء</td></tr>';
    $('recEv').innerHTML = R.events.map(e => {
      const d = e.type === 'gap' ? e.a + ' ' + e.tf + 'ث: ' + utc(e.from) + ' → ' + utc(e.to) + ' (' + e.n + ' شمعة)'
        : e.type === 'reject' ? e.a + ' ' + utc(e.t) + ': ' + e.why
        : e.type === 'hist' ? e.a + ': ' + e.ticks + ' تيك'
        : e.type === 'stale' ? e.a + ': ' + e.age + ' ث بلا سعر'
        : e.type === 'tf' ? e.from + ' → ' + e.to + ' ث'
        : e.type === 'import' ? e.fmt + ': أُضيف ' + e.added + ' من ' + e.read + ' (مرفوض ' + e.rejected + ')'
        : e.type === 'cap' ? e.a + ' ' + e.tf + 'ث: ' + e.n : e.store || '';
      return `<tr><td>${new Date(e.at).toTimeString().slice(0, 8)}</td><td>${EV_LABEL[e.type] || ESC(e.type)}</td><td class="note">${ESC(d)}</td></tr>`;
    }).join('') || '<tr><td colspan="3" class="note">لا أحداث بعد</td></tr>';
  }
  const FEED_CLS = { live: 'c-u', delayed: 'c-g', connected: 'c-g', connecting: 'c-g', stale: 'c-d', unavailable: 'c-d', disconnected: 'c-d', error: 'c-d' };
  const NA = '<span class="note">غير متاح</span>';
  const ago = ms => ms === null || ms === undefined ? NA : ms < 1000 ? 'الآن' : ms < 60000 ? Math.round(ms / 1000) + ' ث' : ms < 36e5 ? Math.round(ms / 60000) + ' د' : Math.round(ms / 36e5) + ' س';
  function paintFeed(V) {
    const f = app.vm.feed(), shown = app.readShown(), dq = V.dq;
    $('feedBadge').textContent = f.label;
    $('feedBadge').className = 'chip ' + (FEED_CLS[f.status] || 'c-m');
    const st = (k, v, s, cls) => `<div class="st"><span>${k}</span><b class="${cls || ''}">${v}</b>${s ? '<small>' + s + '</small>' : ''}</div>`;
    $('feedSt').innerHTML =
      st('الحالة', ESC(f.label), 'منذ ' + ago(Date.now() - f.since), f.status === 'live' ? 'w' : f.status === 'delayed' || f.status === 'connected' || f.status === 'connecting' ? 'warn' : 'l') +
      st('مصدر البيانات', f.source === 'platform-ws' ? 'Pocket Option' : ESC(f.source), 'WebSocket الصفحة — قراءة فقط') +
      st('الأصل المحلَّل', f.asset ? ESC(f.asset) : NA, 'المعروض في الصفحة: ' + (shown ? ESC(shown) : 'غير متاح')) +
      st('آخر سعر', f.lastPrice != null ? f.lastPrice : NA, f.lastTs ? 'وقت المنصة ' + new Date(f.lastTs * 1000).toLocaleTimeString('ar', { hour12: false }) : '') +
      st('آخر تحديث', ago(f.ageMs), f.lagS !== null ? 'فرق ساعة المنصة عن جهازك ≈ ' + f.lagS + ' ث' : '') +
      st('التيكات', f.ticks.ok, 'مستلمة ' + f.ticks.rx + ' · مكررة ' + f.ticks.dup + ' · مرفوضة ' + f.ticks.rej, f.ticks.rej ? 'warn' : '') +
      st('الشموع المعالجة', f.candles, 'حية منذ تشغيل الصفحة') +
      st('جودة البيانات', dq ? dq.q + '%' : NA, dq && dq.issues.length ? ESC(dq.issues.join(' | ')) : '', dq && dq.q < V.cfg.minQ ? 'l' : '') +
      st('الاتصال', f.open + ' مفتوح', 'إعادة اتصال ' + f.reconnects + ' · انقطاع كلي ' + ago(f.downMs), f.open ? '' : 'l');
    $('feedNote').innerHTML = (f.reloadAdvice ? '<span class="l">⚠ لم تُعِد المنصة الاتصال: أعد تحميل الصفحة.</span> ' : '') +
      (tappedOk ? '' : '<span class="l">⚠ لم يُركَّب مراقب WebSocket: لن تصل أي بيانات. أعد تحميل الصفحة.</span> ') +
      '«بيانات حية» تظهر فقط عند وصول تيك صالح للأصل خلال آخر 3 ث عبر اتصال مفتوح؛ الاتصال وحده لا يكفي.';
    if (sh.querySelector('.p-err.on')) {
      const D = app.discovery.status();
      $('discOn').textContent = D.on ? 'إيقاف الاستكشاف' : 'بدء الاستكشاف';
      $('discOn').classList.toggle('on', D.on);
      $('discSt').textContent = D.on ? 'يعمل منذ ' + ago(Date.now() - D.startedAt) + ' · رسائل ' + D.messages + ' · أنواع ' + D.types : D.messages ? 'متوقف (' + (D.stopReason || '') + ') · رسائل ' + D.messages + ' · أنواع ' + D.types : 'غير مفعّل';
      $('feedMsgs').innerHTML = st('رسائل مستلمة', f.msgs, Math.round(f.bytes / 1024) + ' KB') + st('اتصالات', f.conns.length, 'مفتوحة ' + f.open) + st('أخطاء تحليل', f.parseErrors.length, '', f.parseErrors.length ? 'warn' : '') +
        st('التاريخ', f.hist.ok, 'تحميلات ' + f.hist.loads + ' · مرفوضة ' + f.hist.rej, f.hist.rej ? 'warn' : '');
      const ev = Object.entries(f.known).map(([k, n]) => [k, n, 'مقروء']).concat(Object.entries(f.unknown).map(([k, n]) => [k, n, 'غير مقروء'])).sort((a, b) => b[1] - a[1]);
      $('feedEv').innerHTML = ev.slice(0, 40).map(([k, n, t]) => `<tr><td style="direction:ltr;text-align:left">${ESC(k)}</td><td>${n}</td><td class="${t === 'مقروء' ? 'w' : 'note'}">${t}</td></tr>`).join('') || '<tr><td colspan="3" class="note">لم تصل رسائل بعد</td></tr>';
      const rj = Object.entries(f.ticks.reasons).concat(Object.entries(f.hist.reasons).map(([k, n]) => ['تاريخ: ' + k, n]));
      $('feedRej').innerHTML = rj.map(([k, n]) => `<tr><td>${ESC(k)}</td><td>${n}</td></tr>`).join('') || '<tr><td colspan="2" class="note">لا شيء</td></tr>';
      $('feedErr').innerHTML = f.parseErrors.slice().reverse().map(e => `<tr><td>${new Date(e.at).toTimeString().slice(0, 8)}</td><td>${ESC(e.why)}</td></tr>`).join('') || '<tr><td colspan="2" class="note">لا أخطاء</td></tr>';
    }
  }
  function paint() {
    const V = app.vm.view(app.readShown()), R = app.vm.recorder(), r = V.r, d = r ? r.d : 'none', st = V.st, C = V.cfg;
    const col = d === 'call' ? '#3ddbb0' : d === 'put' ? '#ff6b7a' : '#f5c45e';
    paintFeed(V);
    $('assetT').textContent = V.asset
      ? V.asset + ' | ' + V.n + ' شمعة' + (V.price ? ' | ' + V.price : '')
      : 'لا بيانات بعد: حدّث الصفحة (F5) وانتظر';
    $('hero').className = 'card hero shine ' + (d === 'call' ? 'u' : d === 'put' ? 'd' : '');
    $('arc').style.strokeDashoffset = 326.7 * (1 - (r && d !== 'none' ? r.conf / 100 : .12));
    $('arc').style.stroke = col;
    $('arrow').textContent = d === 'call' ? '▲' : d === 'put' ? '▼' : '—';
    $('arrow').style.color = col;
    $('conf').textContent = (r && d !== 'none' ? r.conf : 0);
    $('dirT').textContent = !r ? 'أحلّل السوق...' : d === 'call' ? 'إشارة شراء' : d === 'put' ? 'إشارة بيع' : 'لا توجد فرصة واضحة الآن' + (r.abst && r.abst.length ? ' — ' + r.abst[0] : '');
    $('dirT').style.color = col;
    $('badge').textContent = V.g.ok ? '✔ ' + V.g.why : d === 'none' ? (r ? r.regime + ' | امتناع' : '—') : '⏳ ' + V.g.why;
    $('badge').className = 'chip ' + (V.g.ok ? 'c-u' : 'c-g');
    $('notes').innerHTML = r && r.notes ? r.notes.slice(0, 8).map(n => '<span class="chip">' + ESC(n) + '</span>').join('') : '';
    $('cdb').style.width = V.cd === null ? '0' : (100 - V.cd / C.tf * 100) + '%';
    $('cdt').textContent = V.cd === null ? '' : 'تُغلق الشمعة بعد ' + Math.ceil(V.cd) + ' ث';
    $('chips').innerHTML =
      '<span class="chip c-u">🛡 محاكاة فقط</span>' +
      (R.on ? `<span class="chip ${R.err || R.sess.flushErr ? 'c-d' : 'c-m'}">⏺ تسجيل ${R.series.reduce((a, s) => a + s.count, 0)}</span>` : '<span class="chip c-g">التسجيل متوقف</span>') +
      (C.auto ? '<span class="chip c-g">صفقات افتراضية تلقائية</span>' : '<span class="chip c-m">إشارات فقط</span>') +
      `<span class="chip ${V.asset ? 'c-u' : 'c-d'}">${V.asset ? '✓ بيانات حية' : 'لا بيانات'}</span>` +
      (V.loaded ? `<span class="chip c-m">تاريخ: ${V.loaded}</span>` : '') +
      (V.asset && V.dq ? `<span class="chip ${V.dq.q >= C.minQ ? 'c-m' : 'c-d'}">جودة البيانات ${V.dq.q}%</span>` : '') +
      (st.halted ? '<span class="chip c-d">توقف: ' + ESC(st.haltWhy || 'حد الخسارة') + '</span>' : '') +
      (st.unkRow ? '<span class="chip c-g">صفقة بلا نتيجة ×' + st.unkRow + '</span>' : '') +
      (V.paused ? '<span class="chip c-g">استراحة بعد خسائر</span>' : '') +
      (V.cooling && !V.paused ? '<span class="chip c-g">تهدئة</span>' : '') +
      (st.wsUp === false ? '<span class="chip c-d">انقطاع الاتصال</span>' : '') +
      (st.pending ? '<span class="chip c-g">بانتظار تأكيد المحاكاة</span>' : '') +
      (st.open ? '<span class="chip c-m">صفقة افتراضية مفتوحة</span>' : '') +
      (V.stale ? '<span class="chip c-d">بيانات قديمة: التحليل متوقف</span>' : '') +
      (st.storeErr ? '<span class="chip c-d">تعذّر الحفظ في المتصفح</span>' : '');
    $('auto').textContent = C.auto ? 'الدخول الآلي الافتراضي: يعمل' : 'الدخول الآلي الافتراضي: متوقف';
    $('auto').classList.toggle('on', C.auto);
    if (sh.activeElement !== $('po')) $('po').value = Math.round(V.payout * 100);
    $('beN').textContent = 'نقطة التعادل ' + pc(V.be, 1);
    $('simSt').innerHTML = 'صافي المحاكاة: <b class="' + (st.net >= 0 ? 'w' : 'l') + '">' + (st.net >= 0 ? '+' : '') + st.net.toFixed(2) + '</b> وحدة (مبلغ 1 لكل صفقة) · صفقات افتراضية: ' + V.sim.w + ' ربح / ' + V.sim.l + ' خسارة / ' + V.sim.tie + ' تعادل · ملغاة/فاشلة: ' + V.sim.bad +
      (st.open ? ' · <span class="warn">صفقة مفتوحة ' + ESC(st.open.asset) + '</span>' : '');
    $('gate').textContent = C.gate ? 'بوابة الإثبات: تعمل' : 'بوابة الإثبات: متجاوَزة';
    $('gate').classList.toggle('on', C.gate);
    $('cv').textContent = C.minConf;
    $('ctlnote').innerHTML =
      '«الدخول الآلي الافتراضي» يفتح صفقات محاكاة فقط ويبدأ متوقفًا بعد كل إعادة تحميل. «القوة» درجة اتفاق المؤشرات وليست احتمال نجاح؛ نسبة النجاح المقاسة تظهر في الإحصاءات مع حجم العينة.<br>' +
      (C.gate
        ? 'البوابة: لا صفقة افتراضية إلا إذا أثبتت فئة القوة نجاحًا فوق التعادل على ' + C.minLive + ' إشارة حية (z=' + C.gateZ + ') ونجحت أيضًا في آخر ' + C.recentN + ' إشارة.'
        : '<span class="warn">البوابة متجاوَزة: كل إشارة فوق حد القوة تفتح صفقة افتراضية.</span>');
    $('decNote').innerHTML = st.decision
      ? 'قرار آخر (' + new Date(st.decision.t).toTimeString().slice(0, 8) + '): ' + (st.decision.entered ? 'فُتحت صفقة افتراضية' : 'لم تُفتح صفقة افتراضية' + (st.decision.why.length ? ': ' + ESC(st.decision.why.join(' | ')) : ''))
      : 'لا قرارات بعد';
    $('errs').innerHTML = st.errors.map(e => `<tr><td>${new Date(e.t).toTimeString().slice(0, 8)}</td><td>${ESC(e.code)}</td><td>${ESC(e.msg)}</td></tr>`).join('') || '<tr><td colspan="3" class="note">لا أخطاء</td></tr>';
    $('trc').innerHTML = st.trace.map(x => `<tr><td>${new Date(x.t).toTimeString().slice(0, 8)}</td><td>${ESC(x.dir)}</td><td style="direction:ltr;text-align:left">${ESC(x.raw)}</td></tr>`).join('') || '<tr><td colspan="3" class="note">لا أحداث بعد</td></tr>';
    $('checks').innerHTML = V.checks.map(c => `<li class="${c.ok ? 'ok' : 'no'}"><b>${c.ok ? '✔' : '✖'}</b><span>${ESC(c.t)}</span></li>`).join('');
    const tot = V.sessW + V.sessL;
    $('sw').textContent = V.sessW;
    $('sl').textContent = V.sessL;
    $('sessNote').textContent = tot ? '(في السجل الحالي: ' + tot + ' — إشارات وصفقات افتراضية)' : '';
    $('wr').style.width = (tot ? V.sessW / tot * 100 : 0) + '%';
    $('wrL').textContent = 'نسبة النجاح: ' + (tot ? pc(V.sessW / tot, 1) + ' من ' + tot + (tot < 100 ? ' (عينة صغيرة)' : '') : '—');
    const lt = V.lifeW + V.lifeL;
    $('lifeL').textContent = 'كل الإشارات الحية: ' + V.lifeW + ' / ' + V.lifeL + (lt ? ' (' + pc(V.lifeW / lt, 1) + ')' : '');
    const n = V.liveN, w = V.liveW, po = V.payout, lo95 = V.lo95, hi95 = V.hi95, p = n ? w / n : 0;
    const ev = x => x * po - (1 - x);
    const evS = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%';
    $('stats').innerHTML =
      `<div class="st"><span>إشارات حية (هذا الأصل)</span><b>${n}</b><small>${n < 30 ? 'عينة غير كافية لأي استنتاج' : n < 300 ? 'عينة صغيرة' : 'عينة مقبولة'}</small></div>` +
      `<div class="st"><span>نسبة النجاح الحية</span><b>${n ? pc(p, 1) : '-'}</b><small>${n ? 'فاصل 95%: ' + pc(lo95, 1) + ' – ' + pc(hi95, 1) : ''}</small></div>` +
      `<div class="st"><span>نقطة التعادل</span><b>${pc(V.be, 1)}</b><small>عائد ${Math.round(po * 100)}%</small></div>` +
      (n >= 30
        ? `<div class="st"><span>التوقع الرياضي / صفقة</span><b class="${lo95 > V.be ? 'w' : hi95 < V.be ? 'l' : ''}">${evS(ev(p))}</b><small>المدى 95%: ${evS(ev(lo95))} إلى ${evS(ev(hi95))}${lo95 <= V.be && hi95 >= V.be ? ' — غير مثبت' : ''}</small></div>`
        : `<div class="st"><span>التوقع الرياضي / صفقة</span><b>—</b><small>لا يُحسب قبل 30 إشارة حية (${n}/30)</small></div>`) +
      `<div class="st"><span>إعادة تشغيل التاريخ (تدريب)</span><b>${V.histN ? pc(V.histW / V.histN, 1) : '-'}</b><small>${V.histN} إشارة — داخل العينة، ليست دليلًا</small></div>` +
      `<div class="st"><span>صافي المحاكاة</span><b class="${st.net >= 0 ? 'w' : 'l'}">${st.net >= 0 ? '+' : ''}${st.net.toFixed(2)}</b><small>وحدة افتراضية</small></div>` +
      `<div class="st"><span>صفقات افتراضية هذه الساعة</span><b>${st.hourly}/${C.maxPerHour}</b></div>` +
      `<div class="st"><span>صفقات افتراضية</span><b>${V.sim.w}/${V.sim.l}</b><small>ربح/خسارة · ملغاة/فاشلة ${V.sim.bad}</small></div>`;
    $('strat').innerHTML = V.strat.map(s =>
      `<tr><td>${s.name}${s.improved ? ' <small class="note">✦ معدّلة</small>' : ''}</td><td>${s.kind === 'T' ? 'اتجاه' : s.kind === 'R' ? 'ارتداد' : 'نمط'}</td><td>${s.n}</td><td>${s.n ? pc(s.p, 1) : '-'}</td><td>${s.n ? pc(s.lb, 0) : '-'}</td><td><i class="wb" style="width:${Math.min(100, s.w * 80)}%"></i></td><td><span class="chip c-${s.cls}">${s.mode}</span><small class="note"> ${s.src}${s.rg ? ' · ' + s.rg : ''}${s.rp !== undefined ? ' · آخر' + C.driftN + ': ' + pc(s.rp, 0) : ''}</small></td></tr>`).join('');
    $('bks').innerHTML = V.bks.map(b =>
      `<tr><td>${b.k}+</td><td>${b.n}</td><td>${b.n ? pc(b.acc, 1) : '-'}</td><td><span class="chip c-${b.ok ? 'u' : 'm'}">${b.ok ? 'مسموحة' : b.n < C.minLive ? 'عينة ' + b.n + '/' + C.minLive : 'غير مثبتة'}</span></td></tr>`).join('') || '<tr><td colspan="4" class="note">لم تتجمع بيانات بعد</td></tr>';
    $('log').innerHTML = V.log.map(e => {
      const tm = new Date(e.t).toTimeString().slice(0, 8);
      const why = (e.why || []).join(' · ') + (e.skip && e.skip.length ? ' — لم تُفتح: ' + e.skip.join(' | ') : '') + (e.reason ? ' — ' + e.reason : '');
      return `<tr><td>${tm}</td><td>${ESC(e.asset)}</td><td>${e.dir === 'call' ? '▲ صعود' : '▼ هبوط'}</td><td>${e.conf}</td><td>${kindLabel(e)}</td><td class="${e.win === null ? '' : e.win ? 'w' : 'l'}">${resLabel(e)}</td><td class="note">${ESC(why)}</td></tr>`;
    }).join('') || '<tr><td colspan="7" class="note">لا إشارات بعد</td></tr>';
    $('memAt').textContent = V.savedAt ? new Date(V.savedAt).toLocaleString('ar-SA') : 'لم يُحفظ بعد';
    $('memBest').textContent = V.best ? V.best.k + '+ بدقة ' + pc(V.best.acc, 1) + ' من ' + V.best.n : 'تحتاج عينة أكبر';
    $('memLog').textContent = V.logCount;
    if (sh.querySelector('.p-rec.on')) paintRec();
    if (sh.querySelector('.p-lab.on')) {
      const H = labHtml(app.vm.lab()), key = Object.values(H).join('\u0001');
      if (key !== lastLab) {
        lastLab = key;
        $('labQ').innerHTML = H.q; $('labH').innerHTML = H.h; $('labHn').textContent = H.hn; $('labRM').innerHTML = H.rm;
        $('labV').innerHTML = H.v; $('labCX').innerHTML = H.cx; $('labSC').innerHTML = H.scT; $('labSCn').textContent = H.scn; $('labVT').innerHTML = H.vt; $('labVL').textContent = H.vl ? 'آخر التبديلات: ' + H.vl : ''; $('labCR').innerHTML = H.cr; $('labCRn').textContent = H.crn ? 'أزواج شديدة التطابق: ' + H.crn : ''; $('labAb').innerHTML = H.ab; $('labX').innerHTML = H.x; $('labJ').innerHTML = H.j;
      }
    }
    mini.className = 'mini' + (ui.min ? ' show' : '') + (d === 'call' ? ' u' : d === 'put' ? ' d' : '') + (C.auto ? ' auto' : '');
    $('mA').textContent = d === 'call' ? '▲' : d === 'put' ? '▼' : '—';
    $('mA').style.color = col;
    $('mT').textContent = r && d !== 'none' ? 'قوة ' + r.conf : 'انتظار';
  }
  const t1 = win.setInterval(() => { try { paint(); } catch (e) { try { win.console.warn('wsnf paint', e); } catch (_) {} } }, 1000);
  const t2 = win.setInterval(() => {
    if (ui.min || !sh.querySelector('.p-chart.on')) return;
    try { drawChart(cv, app.vm.chart()); } catch (e) {}
  }, 400);
  setMin(ui.min);
  paint();
  return { paint, host, stop() { win.clearInterval(t1); win.clearInterval(t2); } };
}

// صفحة المختبر: تحويل بيانات نموذج العرض إلى HTML (لا حساب هنا)
function labHtml(L) {
  const dq = L.dq, au = L.audit;
  const q = `<div class="st"><span>جودة بيانات الأصل الحالي</span><b class="${dq && dq.q >= L.minQ ? 'w' : 'l'}">${dq ? dq.q + '%' : '-'}</b><small>${dq && dq.issues.length ? ESC(dq.issues.join(' | ')) : 'لا مشاكل'}</small></div>` +
    `<div class="st"><span>تدقيق عدم استخدام المستقبل</span><b class="${au.bad ? 'l' : 'w'}">${au.n - au.bad}/${au.n}</b><small>${au.bad ? ESC(au.last) : 'كل تحليل بُني على شمعة مغلقة'}</small></div>` +
    `<div class="st"><span>اختبار ثبات القراءات</span><b class="${au.testBad ? 'l' : 'w'}">${au.tests - au.testBad}/${au.tests}</b><small>إعادة حساب قراءة الشمعة السابقة</small></div>`;
  const h = L.hz.map(x => `<tr><td>${x.label}</td><td>${x.z.ln}</td><td>${cellAcc(x.z.ln, x.z.lw)}</td><td>${x.lbPct !== null ? x.lbPct + '%' : '-'}</td><td>${x.z.hn}</td><td>${cellAcc(x.z.hn, x.z.hw)}</td><td>${x.best ? '<span class="chip c-u">الأفضل' + (L.bestLive ? '' : ' (تمهيدي)') + '</span>' : ''}</td></tr>`).join('');
  const rm = '<thead><tr><th>الحالة \\ المدة</th>' + L.rm.cols.map(x => '<th>' + x + '</th>').join('') + '</tr></thead><tbody>' +
    L.rm.rows.map(r => '<tr><td>' + r.g + '</td>' + r.cells.map(c => '<td>' + (c.n >= 20 ? cellAcc(c.n, c.w) + ' <small class="note">(' + c.n + ')</small>' : '-') + '</td>').join('') + '</tr>').join('') + '</tbody>';
  const v = L.vetos.map(x => `<tr><td>${x.name}</td><td>${x.n}</td><td>${cellAcc(x.n, x.w)}</td><td><span class="chip ${x.useful ? 'c-u' : x.harmful ? 'c-d' : 'c-m'}">${x.useful ? 'يحجب خاسرة' : x.harmful ? 'يحجب رابحة' : 'عينة صغيرة'}</span></td></tr>`).join('');
  const cx = L.cx.map(x => `<tr><td>${x.label}</td><td>${x.n}</td><td>${cellAcc(x.n, x.w)}</td><td><span class="chip ${x.win ? 'c-u' : x.lose ? 'c-d' : 'c-m'}">${x.win ? 'رابحة' : x.lose ? 'خاسرة' : 'عينة صغيرة/متوسطة'}</span></td></tr>`).join('');
  let scT = '<tbody><tr><td class="note">لا أصل حالي</td></tr></tbody>';
  if (L.matrix) {
    scT = '<thead><tr><th>الاستراتيجية</th>' + L.matrix.cols.map(x => '<th>' + x + '</th>').join('') + '<th>الاختيار التلقائي</th></tr></thead><tbody>' +
      L.matrix.rows.map(r => '<tr><td>' + r.name + (r.improved ? ' ✦' : '') + '</td>' + r.cells.map(c =>
        '<td class="' + c.cls + '">' + (c.n ? cellAcc(c.n, c.w) + ' <small class="note">(' + c.n + (c.general ? ' عام' : '') + ')</small>' + (c.best ? ' ★' : '') : '-') + '</td>').join('') +
        '<td><span class="chip c-' + r.cls + '">' + r.st + '</span></td></tr>').join('') + '</tbody>';
  }
  const scn = L.matrix ? L.matrix.note : '';
  const vt = L.variants.map(x => `<tr><td>${x.name}</td><td>${x.no ? cellAcc(x.no, x.wo) + ' <small class="note">(' + x.no + ')</small>' : '-'}</td><td>${x.nn ? cellAcc(x.nn, x.wn) + ' <small class="note">(' + x.nn + ')</small>' : '-'}</td><td>${x.src}</td><td><span class="chip ${x.cur ? 'c-u' : 'c-m'}">${x.cur ? 'المعدّلة' : 'القديمة'}</span></td><td>${ESC(x.why)}</td></tr>`).join('');
  const vl = L.svLog.map(x => ESC(x.name) + ' → ' + (x.to === 'new' ? 'المعدّلة' : 'القديمة') + ' (' + new Date(x.t).toTimeString().slice(0, 5) + ')').join('، ');
  const cr = L.clusters.map(x => `<tr><td>${x.names.join('، ')}</td><td><span class="chip ${x.merged > 1 ? 'c-g' : 'c-m'}">${x.merged > 1 ? 'دُمجت ' + x.merged + ' مجموعات (تطابق مقاس)' : 'عنقود مستقل'}</span></td></tr>`).join('');
  const crn = L.pairs.map(p => p.names.join(' ↔ ') + ' ' + Math.round(p.agree * 100) + '%').join(' | ');
  const { zf, zb, za, be } = L.ab;
  const ab = `<div class="st"><span>كل الشموع (بدون امتناع)</span><b>${cellAcc(zf.ln + zf.hn, zf.lw + zf.hw)}</b><small>${zf.ln + zf.hn} حالة</small></div>` +
    `<div class="st"><span>الإشارات المُصدرة</span><b>${cellAcc(zb.ln + zb.hn, zb.lw + zb.hw)}</b><small>${zb.ln + zb.hn} حالة</small></div>` +
    `<div class="st"><span>التي امتنع عنها</span><b>${cellAcc(za.ln + za.hn, za.lw + za.hw)}</b><small>${za.ln + za.hn} حالة</small></div>` +
    `<div class="st"><span>نقطة التعادل</span><b>${pc(be, 1)}</b></div>`;
  const x = L.exps.map(e => {
    const st = e.base ? '<span class="chip c-m">المعتمد</span>' : e.ref ? '<span class="chip c-m">مرجع</span>' : e.cur ? '<span class="chip c-u">مُعتمدة</span>' : e.ready ? '<span class="chip c-u">جاهزة</span>' : '<span class="chip c-m">' + ESC(e.why) + '</span>';
    const btn = !e.ref && !e.base && !e.cur && e.ready ? `<button data-adopt="${e.k}">اعتمد</button>` : '';
    return `<tr><td>${e.n}</td><td>${e.z.ln}</td><td>${cellAcc(e.z.ln, e.z.lw)}</td><td>${e.lbPct !== null ? e.lbPct + '%' : '-'}</td><td>${e.z.hn}</td><td>${cellAcc(e.z.hn, e.z.hw)}</td><td>${st}</td><td>${btn}</td></tr>`;
  }).join('');
  const J = L.journal;
  const j = `<div class="st"><span>إشارات الدفتر</span><b>${J.n}</b><small>${J.done} اكتملت نتيجتها</small></div>` +
    `<div class="st"><span>النسخة الثانية (IndexedDB)</span><b class="${J.idbErr ? 'l' : 'w'}">${J.idbErr ? 'غير متاحة' : J.idbAt ? new Date(J.idbAt).toTimeString().slice(0, 8) : J.idbReady ? 'بانتظار أول حفظ' : 'تُفحص...'}</b></div>` +
    `<div class="st"><span>تجارب معتمدة</span><b>${J.adopted.length}</b><small>${J.adopted.slice(0, 3).map(a => ESC(a.k)).join('، ')}</small></div>`;
  return { q, h, hn: L.hzNote, rm, v, cx, scT, scn, vt, vl, cr, crn, ab, x, j };
}

// الشارت: يرسم بيانات جاهزة من نموذج العرض (الشموع، المتوسطات، العلامات)
function drawChart(cv, D) {
  const arr = D.arr;
  const ctx = cv.getContext('2d');
  const dpr = (typeof devicePixelRatio !== 'undefined' && devicePixelRatio) || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W) return;
  if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (arr.length < 3) {
    ctx.fillStyle = '#8d9ad0'; ctx.font = '14px sans-serif';
    ctx.fillText('بانتظار البيانات...', 20, 30);
    return;
  }
  let hi = -1e9, lo = 1e9;
  arr.forEach(c => { hi = Math.max(hi, c.h); lo = Math.min(lo, c.l); });
  const pad = (hi - lo) * .08 || 1e-6; hi += pad; lo -= pad;
  const y = v => H - (v - lo) / (hi - lo) * H, cw = W / arr.length;
  ctx.strokeStyle = '#26336e88'; ctx.lineWidth = 1;
  for (let i = 1; i < 5; i++) { ctx.beginPath(); ctx.moveTo(0, H * i / 5); ctx.lineTo(W, H * i / 5); ctx.stroke(); }
  arr.forEach((c, i) => {
    const x = i * cw + cw / 2, up = c.c >= c.o;
    ctx.strokeStyle = ctx.fillStyle = up ? '#3ddbb0' : '#ff6b7a';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(x, y(c.h)); ctx.lineTo(x, y(c.l)); ctx.stroke();
    ctx.fillRect(x - cw * .32, Math.min(y(c.o), y(c.c)), cw * .64, Math.max(1.5, Math.abs(y(c.o) - y(c.c))));
  });
  D.lines.forEach(({ col, v }) => {
    ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.beginPath();
    v.forEach((val, i) => { const x = i * cw + cw / 2; i ? ctx.lineTo(x, y(val)) : ctx.moveTo(x, y(val)); });
    ctx.stroke();
  });
  D.marks.forEach(m => {
    const x = m.i * cw + cw / 2, yy = y(m.entry);
    ctx.fillStyle = m.win === null ? '#f5c45e' : m.win ? '#3ddbb0' : '#ff6b7a';
    ctx.beginPath();
    if (m.dir === 'call') { ctx.moveTo(x, yy - 9); ctx.lineTo(x - 6, yy + 2); ctx.lineTo(x + 6, yy + 2); }
    else { ctx.moveTo(x, yy + 9); ctx.lineTo(x - 6, yy - 2); ctx.lineTo(x + 6, yy - 2); }
    ctx.fill();
  });
}
module.exports = { buildUI, labHtml, drawChart, CSS, HTML, ESC };
