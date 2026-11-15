#!/usr/bin/env bash
# Installs the platform as a systemd service on Linux. Run from the eo-platform directory: sudo deploy/install.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
SRC="$(cd "$(dirname "$0")/.." && pwd)"
id eoplatform >/dev/null 2>&1 || useradd --system --home /var/lib/eoplatform --shell /usr/sbin/nologin eoplatform
mkdir -p /opt/eoplatform /etc/eoplatform /var/lib/eoplatform
rm -rf /opt/eoplatform/app && cp -r "$SRC" /opt/eoplatform/app
python3 -m venv /opt/eoplatform/venv
/opt/eoplatform/venv/bin/pip install -q -U pip
/opt/eoplatform/venv/bin/pip install -q -e /opt/eoplatform/app/vendor/TradingAgents -r /opt/eoplatform/app/requirements.txt
if [ ! -f /etc/eoplatform/eoplatform.env ]; then
  cp "$SRC/.env.example" /etc/eoplatform/eoplatform.env
  echo "EO_HOME=/var/lib/eoplatform" >> /etc/eoplatform/eoplatform.env
fi
chmod 600 /etc/eoplatform/eoplatform.env
chown -R eoplatform:eoplatform /var/lib/eoplatform
cp "$SRC/deploy/eoplatform.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now eoplatform
echo "Create the dashboard login:"
echo "  sudo -u eoplatform env \$(grep -v '^#' /etc/eoplatform/eoplatform.env | xargs) /opt/eoplatform/venv/bin/python -m eoplatform create-admin"
echo "Status: systemctl status eoplatform   Logs: journalctl -u eoplatform -f"
