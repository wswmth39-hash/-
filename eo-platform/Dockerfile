FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 EO_HOME=/data EO_HOST=0.0.0.0
WORKDIR /app
COPY vendor/TradingAgents /app/vendor/TradingAgents
COPY requirements.txt /app/
RUN pip install --no-cache-dir -e /app/vendor/TradingAgents -r requirements.txt
COPY eoplatform /app/eoplatform
COPY bridge /app/bridge
RUN useradd --system --uid 10001 eo && mkdir -p /data && chown eo /data
USER eo
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/healthz',timeout=4)"
STOPSIGNAL SIGTERM
CMD ["python", "-m", "eoplatform", "serve"]
