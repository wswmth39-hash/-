'use strict';
// طبقة المنصة — قراءات من صفحة المنصة (للعرض فقط) وتنزيل الملفات. لا نقر على أي عنصر من عناصر المنصة.
const ASSET_SEL = ['.current-symbol', '.pair-name', '.chart-item .pair', '.symbol-name', '[class*="current-symbol"]', '[class*="symbol-name"]'];
function readShownAsset(doc) {
  try { for (const s of ASSET_SEL) { const el = doc.querySelector(s); const t = el && (el.textContent || '').trim(); if (t) return t; } } catch (e) {}
  return null;
}
// تنزيل ملف ينشئه البوت نفسه (رابط مؤقت يُنقر ثم يُزال) — النقر الوحيد على رابط، وهو عنصر يملكه البوت
function downloadText(win, name, text, mime) {
  const doc = win.document, blob = new win.Blob([text], { type: mime || 'text/plain' });
  const url = win.URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url; a.download = name;
  doc.body.appendChild(a); a.click(); a.remove(); // تنزيل ملف فقط
  win.setTimeout(() => win.URL.revokeObjectURL(url), 5000);
}
module.exports = { readShownAsset, downloadText, ASSET_SEL };
