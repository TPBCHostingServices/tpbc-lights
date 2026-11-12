#!/usr/bin/env bash
# Install TPBC Lights on a fresh Raspberry Pi OS Lite (64-bit) Pi 5.
# Run as a user with sudo:  bash deploy/install-pi.sh
set -euo pipefail

REPO=https://github.com/TPBCHostingServices/tpbc-lights.git
DIR=/opt/tpbc-lights

echo "== time zone (service lock windows use local time)"
sudo timedatectl set-timezone America/New_York

echo "== Node.js 24 LTS"
# Needs Node 22.18+ (runs TypeScript directly)
if ! command -v node >/dev/null || ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)'; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo apt-get install -y git

echo "== service user and code"
id tpbc >/dev/null 2>&1 || sudo useradd --system --create-home --shell /bin/bash tpbc
if [ ! -d "$DIR/.git" ]; then sudo git clone "$REPO" "$DIR"; fi
sudo chown -R tpbc:tpbc "$DIR"
sudo -u tpbc bash -c "cd $DIR && npm ci && npm run check"

echo "== systemd"
sudo cp "$DIR/deploy/tpbc-lights.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tpbc-lights
sleep 2
systemctl --no-pager status tpbc-lights | head -12
curl -s localhost:8080/api/status | head -20
echo
echo "Done. Art-Net output starts OFF (shadow mode). See README 'Cutover' to turn it on."
