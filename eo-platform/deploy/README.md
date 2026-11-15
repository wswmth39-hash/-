# التشغيل الدائم وبعد إعادة تشغيل الجهاز

اختر طريقة واحدة:

## 1) Linux مع systemd (موصى به)
```bash
curl -fsSL https://ollama.com/install.sh | sh        # يثبّت Ollama كخدمة systemd تبدأ مع الجهاز
ollama pull qwen3.5:9b
sudo deploy/install.sh                               # يثبّت المنصة كخدمة eoplatform (Restart=always) ويفعّلها عند الإقلاع
```
* الحالة: `systemctl status eoplatform ollama`
* السجلات: `journalctl -u eoplatform -f`، والسجل المنظّم JSON في `/var/lib/eoplatform/logs/`
* الإيقاف الآمن: `sudo systemctl stop eoplatform`، يحفظ البيانات قبل الخروج (مختبر بـSIGTERM)

## 2) Docker (Linux / Windows / macOS)
```bash
cp .env.example .env
docker compose up -d                                  # restart: unless-stopped ← يعود بعد الإقلاع إذا كان Docker يبدأ تلقائيًا
docker compose exec ollama ollama pull qwen3.5:9b
docker compose exec app python -m eoplatform create-admin
```
في Docker Desktop فعّل «Start Docker Desktop when you sign in».

## 3) دون صلاحيات root (cron)
```bash
(crontab -l 2>/dev/null; echo "@reboot cd $PWD && .venv/bin/python -m eoplatform serve >> var/serve.log 2>&1") | crontab -
```

## Ollama: الأولوية والإبقاء في الذاكرة
* المنصة تعيد تثبيت `keep_alive` كل 4 دقائق (`EO_LLM_KEEP_ALIVE`)، لأن التحميل البارد استغرق 29.9 ث عند القياس.
* لحماية زمن الإشارات أثناء عمل النموذج، شغّل Ollama بأولوية أقل من المنصة.
  القياس على 4 أنوية: زاد ذيل الزمن p95 بنحو 34 مللي ثانية فقط، ولم يتغير الوسيط.
  ```bash
  sudo systemctl edit ollama   # ثم أضف:
  # [Service]
  # Nice=10
  # Environment=OLLAMA_KEEP_ALIVE=60m
  ```

## التنبيهات
ضع `EO_ALERT_WEBHOOK=https://ntfy.sh/<موضوع-خاص-بك>` في `.env`، ثم ثبّت تطبيق ntfy على جوالك واشترك في الموضوع نفسه.
ستصلك تنبيهات عند:
* توقف أي خدمة وإعادة تشغيلها
* انقطاع مصدر البيانات أكثر من دقيقة
* انخفاض مساحة القرص
* الإيقاف التلقائي أو الطارئ للتداول التجريبي

لم أختبر هذا الإرسال إلى خدمة حقيقية: اختُبر على خادم محلي فقط.
