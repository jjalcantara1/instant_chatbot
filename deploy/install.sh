#!/usr/bin/env bash
# Installs an extracted build and restarts the service. Runs ON THE VM, from the
# directory the payload was extracted into:
#
#   bash ~/sitechat/deploy/install.sh
#
# deploy/deploy.sh calls this too, so there is one copy of the install logic.
set -euo pipefail

REMOTE="/srv/sitechat"

# The payload root is the parent of this script's deploy/ directory.
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SRC"

# Fail loudly now rather than silently serving a 404 widget or, worse, an empty
# blocklist -- loadBlockedDomains() swallows a missing file.
for required in server/dist/index.js server/config/blocked-domains.txt \
                web/dist/index.html widget/dist/widget.js; do
  [ -s "$required" ] || { echo "MISSING OR EMPTY: $required" >&2; exit 1; }
done

if [ ! -f "${REMOTE}/.env" ]; then
  echo "!! ${REMOTE}/.env does not exist." >&2
  echo "   Create it from deploy/env.production.example before installing." >&2
  exit 1
fi

echo "==> Dependencies (native build happens here, not on the workstation)"
sudo mkdir -p "${REMOTE}/server"
sudo cp server/package.json "${REMOTE}/server/package.json"
# ONNXRUNTIME_NODE_INSTALL=skip: on linux/x64, onnxruntime-node's postinstall
# otherwise downloads the CUDA/TensorRT runtime from NuGet -- hundreds of MB,
# useless on a CPU-only VM, and one more thing that can fail a deploy. The CPU
# runtime the local embedder uses ships inside the package. Passed through
# `env` because sudo's default policy may refuse a bare VAR=value.
( cd "${REMOTE}/server" && sudo env ONNXRUNTIME_NODE_INSTALL=skip npm install --omit=dev --no-audit --no-fund --loglevel=error )

echo "==> Application files"
sudo rm -rf "${REMOTE}/server/dist" "${REMOTE}/server/config"
sudo cp -r server/dist   "${REMOTE}/server/dist"
sudo cp -r server/config "${REMOTE}/server/config"
sudo rm -rf "${REMOTE}/web"
sudo cp -r web/dist "${REMOTE}/web"
sudo mkdir -p "${REMOTE}/widget"
sudo rm -rf "${REMOTE}/widget/dist"
sudo cp -r widget/dist "${REMOTE}/widget/dist"
sudo install -m 755 deploy/backup.sh "${REMOTE}/backup.sh"

# Node reads the widget from ../widget/dist relative to its cwd, and Caddy reads
# the page from /srv/sitechat/web. Both are root-owned; sitechat only ever needs
# to write data/.
sudo chown -R root:root "${REMOTE}/server" "${REMOTE}/web" "${REMOTE}/widget"
sudo mkdir -p "${REMOTE}/data" "${REMOTE}/backups"
sudo chown -R sitechat:sitechat "${REMOTE}/data" "${REMOTE}/backups"

echo "==> systemd + Caddy"
sudo cp deploy/sitechat.service /etc/systemd/system/sitechat.service
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
# validate instantiates the logger, so running it as root creates
# /var/log/caddy/*.log owned by root:root 0600 -- after which the caddy user
# cannot open its own log and the service dies with 'permission denied'.
sudo mkdir -p /var/log/caddy
sudo chown -R caddy:caddy /var/log/caddy
sudo systemctl daemon-reload
sudo systemctl enable sitechat >/dev/null 2>&1 || true
sudo systemctl restart sitechat
# reload-or-restart, not reload: a plain reload cannot bring caddy back if it
# is sitting in a failed state from a previous bad config.
sudo systemctl reload-or-restart caddy

echo "==> Health"
for _ in $(seq 1 15); do
  if curl -fsS --max-time 3 http://localhost:8080/healthz >/dev/null 2>&1; then
    curl -fsS http://localhost:8080/healthz; echo
    echo "OK"
    exit 0
  fi
  sleep 1
done

echo "Health check never came up. Last 40 log lines:" >&2
sudo journalctl -u sitechat -n 40 --no-pager >&2
exit 1
