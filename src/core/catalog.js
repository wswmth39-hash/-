'use strict';
// النواة — ثوابت مشتركة: مدد الانتهاء، حالات السوق، الفلاتر، التجارب، الإعدادات الافتراضية لقواعد القرار.
const HZ = [1, 2, 3, 5];
const RGS = ['اتجاهي', 'عرضي', 'مختلط', 'متقلب'];
const VETOS = ['قفزة سعرية', 'ملاحقة متأخرة', 'تذبذب الإشارة', 'مقاومة قريبة', 'دعم قريب', 'مؤشر واحد مهيمن'];
const DEFAULTS = { minAgree: 3, minConf: 65, minScore: .15, useHtf: true, veto: true, regimes: null, useCtx: true, minClarity: 45, dyn: true };
const hzLabel = (h, tf) => { const s = h * tf; return s < 60 || s % 60 ? s + ' ث' : s / 60 + ' د'; };
// كل تجربة = تعديل واحد على قواعد القرار. تُختبر بصفقات ظلّية على نفس الشموع دون أن تؤثر على القرار الفعلي.
const EXPS = [
  { k: 'base', n: 'الأساس (الإعداد الحالي)', o: {} },
  { k: 'noveto', n: 'بدون فلتر الإشارات الكاذبة', o: { veto: false } },
  { k: 'agree4', n: 'اتفاق 4 مجموعات فأكثر', o: { minAgree: 4 } },
  { k: 'conf72', n: 'ثقة 72% فأكثر', o: { minConf: 72 } },
  { k: 'score25', n: 'قوة إشارة أعلى (> 0.25)', o: { minScore: .25 } },
  { k: 'nohtf', n: 'بدون فلتر الإطار الأعلى', o: { useHtf: false } },
  { k: 'trend', n: 'الأسواق الاتجاهية فقط', o: { regimes: ['اتجاهي'] } },
  { k: 'static', n: 'تجميع ثابت للمؤشرات (بدون دمج ديناميكي)', o: { dyn: false } },
  { k: 'noctx', n: 'بدون فلتر حالة السوق', o: { useCtx: false } },
  { k: 'clar60', n: 'وضوح حالة السوق 60% فأكثر', o: { minClarity: 60 } },
  { k: 'notvol', n: 'استبعاد السوق المتقلب', o: { regimes: ['اتجاهي', 'عرضي', 'مختلط'] } },
  { k: 'forced', n: 'مرجع: بدون امتناع (كل شمعة)', o: { force: true, minConf: 0 }, ref: true }
];
const RGC = { 'اتجاهي': 't', 'عرضي': 'r', 'مختلط': 'm', 'متقلب': 'v' };
const qk = (k, h, rg) => 'q|' + k + '|' + h + '|' + (RGC[rg] || 'x');
module.exports = { HZ, RGS, VETOS, DEFAULTS, hzLabel, EXPS, RGC, qk };
