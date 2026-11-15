document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('err');
  err.textContent = '';
  const r = await fetch('/api/login', {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({username: document.getElementById('u').value, password: document.getElementById('p').value})});
  if (r.ok) { location.href = '/'; return; }
  const d = await r.json().catch(() => ({}));
  err.textContent = r.status === 409 ? 'لا يوجد مستخدم بعد. نفّذ: python -m eoplatform create-admin'
    : r.status === 401 ? 'بيانات غير صحيحة أو محاولات كثيرة (انتظر 10 دقائق)' : (d.detail || 'خطأ');
});
