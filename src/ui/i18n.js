'use strict';
// الواجهة — نصوص الواجهة الجديدة (V1.0) بالعربية والإنجليزية. بحتة: لا DOM ولا حالة.
// ملاحظة: نصوص الأسباب التي يولّدها محرك التحليل نفسه (أسباب الامتناع، ملاحظات المؤشرات) ما زالت عربية فقط؛
// ترجمتها ضمن المرحلة 6 (نظام الإشارات). الواجهة تذكر ذلك صراحةً في الوضع الإنجليزي.
const AR = {
  brand_sub: 'تحليل فقط · لا تنفيذ',
  dev: 'V1.0 قيد التطوير',
  nav_dash: 'لوحة التحكم', nav_market: 'السوق', nav_signals: 'الإشارات', nav_history: 'السجل', nav_alerts: 'التنبيهات', nav_settings: 'الإعدادات', nav_adv: 'متقدم',
  minimize: 'تصغير', lang_switch: 'English', na: 'غير متاح', none: 'لا يوجد', ago_s: 'منذ {n} ث', ago_m: 'منذ {n} د', now: 'الآن',
  // حالات البيانات
  fs_disconnected: 'غير متصل', fs_connecting: 'جارٍ الاتصال', fs_connected: 'متصل — بانتظار البيانات', fs_live: 'بيانات حية',
  fs_delayed: 'بيانات متأخرة', fs_stale: 'بيانات قديمة', fs_unavailable: 'البيانات غير متاحة', fs_error: 'خطأ في البيانات',
  // محرك التوقيت
  tm_wait: 'WAIT · انتظار', tm_analyzing: 'ANALYZING · تحليل', tm_favorable: 'FAVORABLE · ظروف مناسبة', tm_no_trade: 'NO TRADE · لا فرصة',
  tc_data: 'بانتظار بيانات حية من المنصة', tc_history: 'تحميل تاريخ الأصل', tc_collect: 'تجميع الشموع {n}/{need}', tc_first: 'بانتظار إغلاق أول شمعة',
  tc_stale: 'السعر متقادم — التحليل متوقف', tc_signal: 'توافقت شروط المحرك على إشارة', tc_engine: 'المحرك امتنع',
  tm_prelim: 'مشتقة من قرار المحرك الحالي. محرك التوقيت المستقل والتقييم من 100: المرحلة 5.',
  // محرك التحليل
  an_idle: 'لا بيانات', an_loading: 'يحمّل التاريخ', an_paused: 'متوقف — البيانات غير حية', an_collecting: 'يجمع الشموع', an_active: 'يعمل',
  // اللوحة
  d_bot: 'حالة البوت', d_bot_on: 'يعمل', d_bot_wait: 'بانتظار البيانات', d_bot_sub: 'تحليل وإشارات فقط — لا ينفّذ صفقات',
  d_conn: 'الاتصال بمصدر البيانات', d_src: 'المصدر: Pocket Option — اتصال الصفحة (قراءة فقط)',
  d_asset: 'الأصل الحالي', d_asset_none: 'لم تصل بيانات أي أصل بعد', d_locked: 'مثبّت يدويًا', d_follow: 'يتبع الأصل المفتوح في المنصة',
  d_tf: 'الإطار الزمني', d_trend: 'اتجاه السوق', d_strength: 'قوة الإشارة', d_strength_sub: 'درجة توافق المؤشرات — ليست احتمال نجاح',
  d_last: 'آخر تحديث للأسعار', d_scanned: 'الأصول المفحوصة', d_scanned_sub: 'أصول وصلت بياناتها في هذه الجلسة',
  d_signals: 'الإشارات المسجّلة', d_signals_sub: 'آخر 200 محفوظة · الإجمالي الحي {n}',
  d_engine: 'محرك التحليل', d_timing: 'محرك اختيار التوقيت', d_recent: 'آخر التحليلات', d_no_recent: 'لا إشارات مسجّلة بعد',
  d_candles: '{n} شمعة', d_next: 'إغلاق الشمعة بعد {n} ث', d_price: 'السعر',
  up: 'صاعد', down: 'هابط', flat: 'غير محدد',
  rg_trend: 'اتجاهي', rg_range: 'عرضي', rg_mixed: 'مختلط', rg_volatile: 'متقلب',
  // السوق
  m_chart: 'الشارت — {a}', m_chart_sub: 'آخر 90 شمعة مغلقة · EMA 9 و EMA 21', m_wait: 'بانتظار البيانات...',
  m_assets: 'الأصول التي وصلت بياناتها', m_assets_note: 'المنصة تبث الأصل المفتوح على الشارت فقط. افتح أصلًا في المنصة ليظهر هنا (حتى {n} أصول في الذاكرة).',
  m_col_asset: 'الأصل', m_col_price: 'آخر سعر', m_col_age: 'آخر تحديث', m_col_candles: 'الشموع', m_col_sig: 'آخر تحليل', m_col_act: 'الإجراء',
  m_lock: 'حلّل هذا الأصل فقط', m_unlock: 'إلغاء التثبيت', m_current: 'الحالي', m_no_assets: 'لا أصول بعد',
  m_ohlc: 'فتح {o} · أعلى {h} · أدنى {l} · إغلاق {c}',
  // الإشارات
  s_current: 'الإشارة الحالية', s_none: 'لا إشارة الآن', s_call: 'CALL · صعود', s_put: 'PUT · هبوط',
  s_asset: 'الأصل', s_time: 'وقت الإشارة', s_tf: 'الإطار الزمني', s_eval: 'مدة التقييم', s_eval_v: 'شمعة واحدة ({n} ث) — تُسجَّل النتيجة عند إغلاق الشمعة التالية',
  s_price: 'السعر وقت الإشارة', s_strength: 'قوة الإشارة', s_pro: 'المؤشرات المؤيدة', s_con: 'المؤشرات المعارضة', s_reason: 'سبب القرار',
  s_timing: 'حالة التوقيت', s_quality: 'جودة البيانات', s_ctx: 'سياق السوق', s_clarity: 'وضوح {n}%', s_agree: 'عناقيد مستقلة متفقة: {n}', s_opp: 'وزن الأصوات المعاكسة: {n}%',
  s_no_prob: 'لا تُعرض نسبة نجاح متوقعة: القوة تقيس توافق المؤشرات فقط. الدقة الفعلية في صفحة «السجل» من النتائج المسجّلة.',
  s_recent: 'آخر الإشارات', s_engine_ar: '',
  s_besthz: 'أنسب مدة مسجّلة: {s} ث (دقة {p}% في السجلات)',
  // السجل
  h_total: 'إجمالي الإشارات', h_right: 'الصحيحة', h_wrong: 'غير الصحيحة', h_acc: 'نسبة الدقة', h_ci: 'فاصل ثقة 95%: {lo}% – {hi}%', h_small: 'العينة صغيرة — النسبة غير موثوقة بعد',
  h_by_asset: 'أداء كل أصل', h_by_tf: 'أداء كل إطار زمني', h_by_strat: 'أداء كل مؤشر (دقة تصويته على الشموع الحية)',
  h_col_k: 'البند', h_col_n: 'العدد', h_col_w: 'صحيحة', h_col_acc: 'الدقة', h_col_ci: 'فاصل 95%',
  h_log: 'سجل الإشارات (آخر 200)', h_id: 'الرقم', h_asset: 'الأصل', h_dir: 'الاتجاه', h_time: 'وقت الإشارة', h_entry: 'السعر عند الإشارة', h_exit: 'السعر عند التقييم',
  h_res: 'النتيجة', h_score: 'القوة', h_why: 'السبب',
  r_win: 'صحيحة', r_loss: 'غير صحيحة', r_tie: 'تعادل', r_pending: 'قيد التقييم', r_unknown: 'غير معروفة', r_void: 'ملغاة',
  h_empty: 'لا نتائج مسجّلة بعد', h_note: 'كل الأرقام من نتائج فعلية مسجّلة على أسعار المنصة. الإطار الزمني لكل صف ورقم تسلسلي دائم: المرحلة 6.',
  h_disclaimer: 'الدقة السابقة لا تضمن النتائج القادمة. لا يوجد دليل على أن هذا النظام مربح.',
  // التنبيهات
  a_title: 'مركز التنبيهات', a_clear: 'مسح الكل', a_empty: 'لا تنبيهات',
  n_signal: 'إشارة جديدة: {a} {d} · قوة {c}', n_result_w: 'نتيجة إشارة: صحيحة', n_result_l: 'نتيجة إشارة: غير صحيحة',
  n_asset: 'تغيّر الأصل: {from} ← {to}', n_feed: 'حالة البيانات: {s}', n_reload: 'لم تُعِد المنصة الاتصال — أعد تحميل الصفحة',
  n_timing: 'محرك التوقيت: {s}', n_trend: 'تغيّر حالة السوق: {from} ← {to}', n_quality: 'جودة البيانات منخفضة: {q}%', n_conflict: 'تضارب في المؤشرات: {n}% أصوات معاكسة',
  // الإعدادات
  st_mode: 'وضع اختيار الأصل', st_mode_d: 'يدوي: يحلل الأصل الذي تثبّته فقط. متابعة المنصة: يحلل الأصل المفتوح على شارت المنصة.',
  st_manual: 'يدوي', st_follow: 'متابعة المنصة', st_manual_need: 'لا أصل لتثبيته بعد — افتح أصلًا في المنصة أولًا',
  st_tf: 'مدة الشمعة', st_tf_d: 'الأطر المتاحة الآن من التيكات الحية. تغييرها يعيد بناء الشموع من جديد. M5 إلى H1: المرحلة 4.',
  st_min: 'الحد الأدنى لقوة الإشارة', st_min_d: 'لا تصدر إشارة تحت هذه الدرجة (50–90).',
  st_lang: 'اللغة', st_lang_d: 'لغة الواجهة.',
  st_alerts: 'التنبيهات', st_toasts: 'إشعارات منبثقة', st_toasts_d: 'تظهر أعلى الشاشة عند كل حدث مفعّل.', st_sound: 'صوت التنبيه', st_sound_d: 'نغمة قصيرة مع الإشعار. قد يتطلب المتصفح نقرة في الصفحة أولًا.',
  st_types: 'أنواع التنبيهات', ty_signal: 'إشارة جديدة ونتيجتها', ty_conn: 'الاتصال وحالة البيانات', ty_asset: 'تغيّر الأصل', ty_quality: 'ضعف جودة البيانات', ty_timing: 'تغيّر حالة التوقيت', ty_trend: 'تغيّر حالة السوق', ty_conflict: 'تضارب المؤشرات',
  st_ui: 'الواجهة', st_compact: 'عرض مضغوط', st_compact_d: 'هوامش وخطوط أصغر.', st_motion: 'الحركة والانتقالات', st_motion_d: 'عطّلها لواجهة ثابتة.',
  st_conn: 'الاتصال', st_conn_d: 'المصدر الوحيد: قراءة سلبية لاتصال صفحة Pocket Option. غير موثّق رسميًا من المنصة. البوت لا يرسل أي رسالة ولا يستخدم رمز الجلسة.',
  st_conn_live: 'حية حتى', st_conn_delay: 'متأخرة حتى (بعدها يتوقف التحليل)', st_conn_unav: 'غير متاحة بعد', st_conn_ro: 'عتبات الحداثة للعرض فقط؛ تعديلها ضمن المرحلة 3.',
  st_pending: 'إعدادات لم تُبنَ بعد', st_p1: 'تفعيل وتعطيل المؤشرات — المرحلة 4', st_p2: 'أوزان التقييم من 100 — المرحلة 5', st_p3: 'الاختيار التلقائي لأفضل أصل وإطار — المرحلة 5',
  on: 'مفعّل', off: 'معطّل', sec: '{n} ث',
  // متقدم
  adv_title: 'الأدوات المتقدمة', adv_d: 'صفحات الإصدار السابق كما هي: الاستراتيجيات، المختبر، مسجّل الشموع، الذاكرة، سجل الأخطاء وأداة استكشاف بيانات المنصة. الصفقات الافتراضية مخفية من الواجهة.',
  adv_open: 'فتح الأدوات المتقدمة', adv_back: '← رجوع للواجهة', adv_errors: 'أخطاء مسجّلة: {n}', adv_store: 'تعذّر الحفظ في المتصفح',
  disclaimer: 'أداة تحليل مستقلة غير تابعة لـ Pocket Option. الإشارات ليست نصيحة مالية ولا ضمان فيها.'
};
const EN = {
  brand_sub: 'Analysis only · no execution',
  dev: 'V1.0 in development',
  nav_dash: 'Dashboard', nav_market: 'Market', nav_signals: 'Signals', nav_history: 'History', nav_alerts: 'Alerts', nav_settings: 'Settings', nav_adv: 'Advanced',
  minimize: 'Minimize', lang_switch: 'العربية', na: 'N/A', none: 'None', ago_s: '{n}s ago', ago_m: '{n}m ago', now: 'now',
  fs_disconnected: 'Disconnected', fs_connecting: 'Connecting', fs_connected: 'Connected — waiting for data', fs_live: 'Live data',
  fs_delayed: 'Delayed data', fs_stale: 'Stale data', fs_unavailable: 'Data unavailable', fs_error: 'Data error',
  tm_wait: 'WAIT', tm_analyzing: 'ANALYZING', tm_favorable: 'FAVORABLE', tm_no_trade: 'NO TRADE',
  tc_data: 'Waiting for live data from the platform', tc_history: 'Loading asset history', tc_collect: 'Collecting candles {n}/{need}', tc_first: 'Waiting for the first candle close',
  tc_stale: 'Price is stale — analysis paused', tc_signal: 'Engine conditions aligned on a signal', tc_engine: 'Engine abstained',
  tm_prelim: 'Derived from the current engine decision. Standalone timing engine and 100-point score: phase 5.',
  an_idle: 'No data', an_loading: 'Loading history', an_paused: 'Paused — data not live', an_collecting: 'Collecting candles', an_active: 'Running',
  d_bot: 'Bot status', d_bot_on: 'Running', d_bot_wait: 'Waiting for data', d_bot_sub: 'Analysis and signals only — places no trades',
  d_conn: 'Data source connection', d_src: 'Source: Pocket Option — page connection (read-only)',
  d_asset: 'Current asset', d_asset_none: 'No asset data received yet', d_locked: 'Pinned manually', d_follow: 'Following the asset open on the platform',
  d_tf: 'Timeframe', d_trend: 'Market direction', d_strength: 'Signal strength', d_strength_sub: 'Indicator agreement score — not a win probability',
  d_last: 'Last price update', d_scanned: 'Assets scanned', d_scanned_sub: 'Assets whose data arrived this session',
  d_signals: 'Signals logged', d_signals_sub: 'Last 200 kept · live total {n}',
  d_engine: 'Analysis engine', d_timing: 'Timing engine', d_recent: 'Recent analyses', d_no_recent: 'No signals logged yet',
  d_candles: '{n} candles', d_next: 'Candle closes in {n}s', d_price: 'Price',
  up: 'Up', down: 'Down', flat: 'Undetermined',
  rg_trend: 'Trending', rg_range: 'Ranging', rg_mixed: 'Mixed', rg_volatile: 'Volatile',
  m_chart: 'Chart — {a}', m_chart_sub: 'Last 90 closed candles · EMA 9 and EMA 21', m_wait: 'Waiting for data...',
  m_assets: 'Assets with received data', m_assets_note: 'The platform streams only the asset open on its chart. Open an asset there to see it here (up to {n} assets in memory).',
  m_col_asset: 'Asset', m_col_price: 'Last price', m_col_age: 'Updated', m_col_candles: 'Candles', m_col_sig: 'Last analysis', m_col_act: 'Action',
  m_lock: 'Analyze this asset only', m_unlock: 'Unpin', m_current: 'Current', m_no_assets: 'No assets yet',
  m_ohlc: 'O {o} · H {h} · L {l} · C {c}',
  s_current: 'Current signal', s_none: 'No signal now', s_call: 'CALL', s_put: 'PUT',
  s_asset: 'Asset', s_time: 'Signal time', s_tf: 'Timeframe', s_eval: 'Evaluation period', s_eval_v: 'One candle ({n}s) — the outcome is recorded at the next candle close',
  s_price: 'Price at signal', s_strength: 'Signal strength', s_pro: 'Supporting indicators', s_con: 'Opposing indicators', s_reason: 'Decision reason',
  s_timing: 'Timing state', s_quality: 'Data quality', s_ctx: 'Market context', s_clarity: 'clarity {n}%', s_agree: 'Independent clusters agreeing: {n}', s_opp: 'Opposing vote weight: {n}%',
  s_no_prob: 'No expected win rate is shown: strength only measures indicator agreement. Actual accuracy is on the History page, from recorded outcomes.',
  s_recent: 'Recent signals', s_engine_ar: 'Reason texts generated by the analysis engine are still Arabic-only; translation is planned for phase 6.',
  s_besthz: 'Best recorded duration: {s}s ({p}% accuracy in records)',
  h_total: 'Total signals', h_right: 'Correct', h_wrong: 'Incorrect', h_acc: 'Accuracy', h_ci: '95% confidence interval: {lo}% – {hi}%', h_small: 'Small sample — the rate is not reliable yet',
  h_by_asset: 'Performance by asset', h_by_tf: 'Performance by timeframe', h_by_strat: 'Performance by indicator (vote accuracy on live candles)',
  h_col_k: 'Item', h_col_n: 'Count', h_col_w: 'Correct', h_col_acc: 'Accuracy', h_col_ci: '95% CI',
  h_log: 'Signal log (last 200)', h_id: 'ID', h_asset: 'Asset', h_dir: 'Direction', h_time: 'Signal time', h_entry: 'Price at signal', h_exit: 'Price at evaluation',
  h_res: 'Outcome', h_score: 'Strength', h_why: 'Reason',
  r_win: 'Correct', r_loss: 'Incorrect', r_tie: 'Tie', r_pending: 'Pending', r_unknown: 'Unknown', r_void: 'Voided',
  h_empty: 'No recorded outcomes yet', h_note: 'All figures come from actual outcomes recorded on platform prices. Per-row timeframe and a permanent serial number: phase 6.',
  h_disclaimer: 'Past accuracy does not guarantee future results. There is no evidence that this system is profitable.',
  a_title: 'Alert center', a_clear: 'Clear all', a_empty: 'No alerts',
  n_signal: 'New signal: {a} {d} · strength {c}', n_result_w: 'Signal outcome: correct', n_result_l: 'Signal outcome: incorrect',
  n_asset: 'Asset changed: {from} → {to}', n_feed: 'Data status: {s}', n_reload: 'The platform has not reconnected — reload the page',
  n_timing: 'Timing engine: {s}', n_trend: 'Market state changed: {from} → {to}', n_quality: 'Low data quality: {q}%', n_conflict: 'Indicator conflict: {n}% opposing votes',
  st_mode: 'Asset selection mode', st_mode_d: 'Manual: analyzes only the asset you pin. Follow platform: analyzes the asset open on the platform chart.',
  st_manual: 'Manual', st_follow: 'Follow platform', st_manual_need: 'No asset to pin yet — open one on the platform first',
  st_tf: 'Candle duration', st_tf_d: 'Timeframes available now from live ticks. Changing it rebuilds candles from scratch. M5 to H1: phase 4.',
  st_min: 'Minimum signal strength', st_min_d: 'No signal is issued below this score (50–90).',
  st_lang: 'Language', st_lang_d: 'Interface language.',
  st_alerts: 'Alerts', st_toasts: 'Pop-up notifications', st_toasts_d: 'Shown at the top of the screen for each enabled event.', st_sound: 'Alert sound', st_sound_d: 'A short tone with the notification. The browser may require a click on the page first.',
  st_types: 'Alert types', ty_signal: 'New signal and its outcome', ty_conn: 'Connection and data status', ty_asset: 'Asset change', ty_quality: 'Low data quality', ty_timing: 'Timing state change', ty_trend: 'Market state change', ty_conflict: 'Indicator conflict',
  st_ui: 'Interface', st_compact: 'Compact view', st_compact_d: 'Smaller spacing and type.', st_motion: 'Motion and transitions', st_motion_d: 'Turn off for a static interface.',
  st_conn: 'Connection', st_conn_d: 'Single source: passive reading of the Pocket Option page connection. Not officially documented by the platform. The bot sends no messages and does not use the session token.',
  st_conn_live: 'Live up to', st_conn_delay: 'Delayed up to (analysis stops after)', st_conn_unav: 'Unavailable after', st_conn_ro: 'Freshness thresholds are read-only here; editing them is part of phase 3.',
  st_pending: 'Settings not built yet', st_p1: 'Enable/disable indicators — phase 4', st_p2: '100-point score weights — phase 5', st_p3: 'Automatic best asset and timeframe selection — phase 5',
  on: 'On', off: 'Off', sec: '{n}s',
  adv_title: 'Advanced tools', adv_d: 'Pages from the previous version, unchanged: strategies, lab, candle recorder, memory, error log and the platform data discovery tool. Virtual trades are hidden from the interface.',
  adv_open: 'Open advanced tools', adv_back: '← Back to interface', adv_errors: 'Logged errors: {n}', adv_store: 'Could not save to browser storage',
  disclaimer: 'Independent analysis tool, not affiliated with Pocket Option. Signals are not financial advice and carry no guarantee.'
};
const DICT = { ar: AR, en: EN };
const LANGS = ['ar', 'en'];
function t(lang, key, vars) {
  const d = DICT[lang] || AR;
  let s = d[key];
  if (s === undefined) s = AR[key];
  if (s === undefined) return key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => vars[k] === undefined || vars[k] === null ? '' : String(vars[k])) : s;
}
module.exports = { DICT, LANGS, t };
