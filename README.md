# WSNF Smart Bot — audit & rework

- `original/wsnf_v3.3.user.js` — النسخة الأصلية كما استُلمت (نسخة احتياطية، لا تُعدَّل).
- `docs/AUDIT_REPORT.md` — تقرير الفحص الشامل (المرحلة الأولى).
- `audit/` — سكربتات تشغّل الملف الأصلي دون تعديل في Node للتحقق من المشكلات:
  `node audit/exp1.js original/wsnf_v3.3.user.js 7` و `node audit/exp2.js original/wsnf_v3.3.user.js 8`
