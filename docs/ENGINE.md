# بنية المحرك (v3.6 — المرحلة C)

الكود في `src/` موزّع على وحدات CommonJS. يجمعها `build.js` (بلا أي مكتبة خارجية) في ملف واحد `dist/wsnf.user.js`،
وهو ما يُثبَّت في Tampermonkey. كل وحدة تُغلَّف في دالة لها نطاقها الخاص، فلا توجد متغيرات عامة مشتركة بين الوحدات.
نفس الوحدات تُستخدم مباشرة في Node للاختبار بـ `require('../src/...')`.

## الطبقات واتجاه الاعتماد

```
 ┌────────────────────────── main.js (المتصفح) ──────────────────────────┐
 │ يبني env من window ← createEngine(env) ← يركّب المنصة والواجهة ويربطها │
 └───────────────┬───────────────────────┬──────────────────────┬────────┘
                 │                       │                      │
     platform/ (ws.js, dom.js)      ui/ui.js              recorder/
     يقرأ WebSocket وDOM فقط       يعرض فقط               يستمع لأحداث المحرك
                 │ feedTick/loadHistory   │ vm.* (قراءة)          │ on('candle'|'ws'|...)
                 │ connOpen/connLost      │ cmd.* (أوامر)         │
                 ▼                       ▼                      ▼
 ┌────────────────────────── engine/ (حالة، بلا DOM) ─────────────────────┐
 │ engine.js   تيك ← شمعة ← إغلاق ← تسوية ← analyzeWindow ← ظلّية/افتراضية │
 │ paper.js    المحاكاة وحدود المخاطرة    lab.js  التجارب واختيار النسخ     │
 │ persist.js  الحفظ والاستعادة          viewmodel.js  قراءة فقط → بيانات  │
 │ commands.js الأوامر (الكتابة الوحيدة من الواجهة)  context.js  الربط والأحداث│
 └───────────────────────────────┬────────────────────────────────────────┘
                                 │ استدعاءات بمدخلات صريحة فقط
                                 ▼
 ┌─────────────────────────── core/ (دوال بحتة) ──────────────────────────┐
 │ indicators  strategies  quality  context  decision  learning  clusters │
 │ stats  catalog          — لا DOM، لا تخزين، لا ساعة، لا حالة عامة       │
 └────────────────────────────────────────────────────────────────────────┘
```

الاعتماد يتجه دائمًا إلى الأسفل. `core/` لا تستورد إلا من `core/`، والواجهة لا تستورد أي وحدة.
اختبارات البنية (C-ARCH1–6 في `test/engine.test.js`) تفرض هذه القواعد آليًا: أي مخالفة تُفشل الاختبارات.

## الوحدات

| الوحدة | المسؤولية | ما يُحقن فيها |
|---|---|---|
| `core/indicators.js` | EMA، RSI (Wilder)، ATR، بولينجر، Heikin-Ashi، الأنماط، المستويات، القمم/القيعان، ADX، الإطار الأعلى | لا شيء؛ `tf` يُمرَّر صراحةً |
| `core/strategies.js` | الاستراتيجيات الـ17 ونسخها المعدّلة؛ `evaluate()` يصوّت فقط | `useNew(k)`، `onErr` |
| `core/quality.js` | صلاحية الشموع، جودة البيانات، الفجوات والانقطاع، **عقد الشموع المغلقة** | معاملات صريحة |
| `core/context.js` | تصنيف حالة السوق (اتجاه/نطاق/اختراق صالح أو وهمي/انعكاس/انضغاط/فوضى) | `{ tf, htfK }` |
| `core/learning.js` | أوزان الاستراتيجيات، البوابة، مقارنة النسخ والمدد | `createLearner({ cfg, book, isLoading, sv, BE })` — عرض ضيق للقراءة |
| `core/clusters.js` | قياس الترابط بين الأصوات وتخفيف الأدلة المترابطة | `createClusters({ cfg, corr, corrH, isLoading })` |
| `core/decision.js` | `analyze(cs, deps)`: تصويت ← أوزان ← تخفيف الترابط ← سياق ← فلاتر ← قرار | كل شيء عبر `deps` |
| `core/catalog.js`، `core/stats.js` | ثوابت (مدد، حالات، تجارب) وأدوات إحصائية (Wilson، …) | — |
| `engine/engine.js` | بناء الشموع من التيك، إغلاقها، تسوية نتائج الشمعة السابقة، استدعاء التحليل، الحالة الظلية والافتراضية | — |
| `engine/paper.js` | المحاكاة فقط: دورة الصفقة الافتراضية وحدود المخاطرة | — |
| `engine/lab.js` | الصفقات الظلّية والتجارب واختيار النسخ المعدّلة | — |
| `engine/persist.js` | localStorage (المفاتيح نفسها كما في v3.5) والنسخة الثانية في IndexedDB والسجل | `env.storage`، `env.indexedDB` |
| `engine/viewmodel.js` | **قراءة فقط**: يحوّل الحالة إلى بيانات للعرض (نسخ، لا مراجع) | — |
| `engine/commands.js` | القناة الوحيدة التي تغيّر بها الواجهة المحرك | — |
| `engine/context.js` | الربط بين أجزاء المحرك (`provide`/`use`) وناقل الأحداث (`on`/`emit`) | `env` |
| `recorder/format.js` | قواعد صحة السجل، منع التكرار، الفجوات، JSONL/CSV (بحتة؛ لم تتغير) | — |
| `recorder/recorder.js` | حالة المسجّل وتخزينه؛ يستمع لأحداث المحرك | `env.indexedDB`، `env.IDBKeyRange`، `env.recMem` |
| `platform/ws.js` | اعتراض WebSocket (قراءة فقط) وترجمة رسائل المنصة إلى أوامر المحرك | `window` |
| `platform/dom.js` | قراءة اسم الأصل المعروض، وتنزيل الملفات | `document` |
| `ui/ui.js` | HTML/CSS والرسم فقط | كائن `app` (أدناه) |

## كيف تتواصل الأجزاء

**1) من التيك إلى القرار (مسار متزامن واحد، بالترتيب نفسه كما في v3.5):**

```
WebSocket ─(platform/ws)→ feedTick(asset, ts, price)
  └─ عند أول تيك بعد نهاية الشمعة: onClose(asset, arr, tNew, tsNow)
       ├─ تدقيق المستقبل (tsNow ≥ نهاية الشمعة)
       ├─ emit('candle') ─→ المسجّل
       ├─ settleShadows (lab) → تسوية نتيجة الشمعة السابقة (rec في دفتر الإحصاء) → settle (paper)
       ├─ liveBlock (core/quality): انقطاع/فجوة؟ ← لا تحليل
       ├─ analyzeWindow(arr.slice(-300), A, asset, asOf = tsNow)
       │     └─ core/decision.analyze(cs, { cfg, A, learner, clusters, asOf, useNew, sdh, tickAgeMs, onQuality, onStratErr, onError })
       ├─ trackCorr / rebuildClusters / evalVariants
       ├─ registerShadows (lab)
       └─ maybeTrade (paper) → emit('signal') ─→ الواجهة
```

**2) عقد الشموع المغلقة:** `analyze` تتطلب `asOf`، وهو وقت المنصة للتيك الذي أغلق الشمعة.
تُرفض النافذة إذا كانت أي شمعة فيها تنتهي بعد `asOf`، أو إذا لم يُعطَ `asOf` أصلًا.
الاستثناء الوحيد علَم صريح `allowOpen: true` مخصّص للأبحاث: النتيجة تحمل حينها `incomplete: true` وملاحظة ظاهرة.
المحرك لا يستخدم هذا العلَم إطلاقًا (اختبارا C1 وC2).

**3) الواجهة ↔ المحرك:** الواجهة لا ترى إلا كائن `app`:

| | المحتوى | الاتجاه |
|---|---|---|
| `app.vm` | `view(shown)`، `lab()`، `recorder()`، `chart()`، `settings()` — بيانات منسوخة، والإحصاءات والأحكام محسوبة مسبقًا | قراءة |
| `app.cmd` | `toggleAuto`، `kill`، `toggleGate`، `setMinConf`، `setPayoutPct`، `setTf`، `toggleLock`، `adopt`، `resetRules`، `exportMemory`، `importMemory`، `resetLearning`، `clearErrors` | كتابة (الوحيدة) |
| `app.rec` | أوامر المسجّل: تشغيل، تصدير، استيراد، فحص الفجوات، مسح | كتابة للمسجّل |
| `app.on('signal' \| 'result', fn)` | أحداث المحرك | إشعار |

**4) أحداث المحرك** (`E.on`/`E.emit`): `candle`، `ws`، `history`، `stale`، `tf`، `signal`، `result`.
خطأ داخل مستمع لا يوقف المحرك.

**5) البيئة المحقونة:**
`createEngine({ now, storage, indexedDB?, IDBKeyRange?, console?, recMem? })`.
في المتصفح يبنيها `main.js` من `window`، وفي Node تبنيها الاختبارات.
يمكن إنشاء أكثر من محرك في العملية نفسها دون أي تداخل بينها (اختبار C9).

## إضافات v4 — طبقة الاستقبال

```
WebSocket الصفحة ─(platform/ws.js: حالة لكل اتصال، core/sio.js: تحليل Socket.IO)─→ handle(kind, data, connId)
   ├─ stream → engine/feed.ingestTicks: core/feed.tickError (تحقق) ← كشف التكرار ← feedTick ← عدّادات لكل أصل
   ├─ hist   → engine/feed.ingestHistory: تحقق أساسي ← loadHistory
   └─ كل حدث → platform/discovery.observe (عند تفعيل الاستكشاف فقط)
engine/feed.feedCheck (كل ثانية) ─→ core/feed.feedStatus ─→ emit('feed') عند التغيّر · emit('reloadAdvice')
engine/feed.feedView ─→ viewmodel.feed ─→ بطاقة «اتصال المنصة وحالة البيانات»
```

## ما لم يتغير عمدًا

* **قواعد التحليل والقرار والتعلّم والمحاكاة:** متطابقة بايتًا ببايت مع v3.5 (الاختبار الذهبي G، 26 مقارنة).
* **مفاتيح التخزين** `wsnf33s_*` وقاعدتا IndexedDB (`wsnf33s`، `wsnf33s_rec`): **لا ترحيل** (اختبار C-ARCH6).
* **قواعد المسجّل وصيغه:** `recorder/format.js` نُقل كما هو. الفرق الوحيد أن `rx` (ساعة الجهاز) يُمرَّر بدل قراءته داخل الوحدة.

## التغييرات السلوكية المقصودة (موثّقة ومختبرة)

1. **نموذج العرض لم يعد يكتب في الحالة.** في v3.5 كان `view()`/`labView()` يستدعي `getA(asset)`،
   فيُنشئ سجل إحصاء فارغًا لمجرد عرض الصفحة (مثلًا `EURUSD_otc@30` فور تغيير الإطار).
   القرارات لم تتأثر بذلك، لكن الحالة المحفوظة كانت تختلف بحسب ما إذا كانت الواجهة مفتوحة أم لا.
   مُثبت على v3.5 وعلى v3.6 في `test/ui.engine.browser.js` (U2)، وفي C11.
2. **التحليل بلا `asOf` يُرفض.** في v3.5 كانت `analyze` تفترض ضمنيًا أن آخر شمعة مغلقة.
   داخل المحرك يُمرَّر `asOf` دائمًا، فلا أثر على المسار الطبيعي (الاختبار الذهبي متطابق).
   الأثر الوحيد في مسار «فشل تدقيق المستقبل» النظري: لم تعد قراءات تلك الشمعة تدخل التعلّم.

## البناء

```bash
node build.js           # src/ → dist/wsnf.user.js
node build.js --check   # يفشل إن كان dist غير مطابق لـ src (جزء من npm test)
```
