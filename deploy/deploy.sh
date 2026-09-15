#!/usr/bin/env bash
# Build locally, ship to the GCE VM, restart. Run from the repo root:
#
#   VM=sitechat ZONE=us-central1-a ./deploy/deploy.sh
#
# Uses `gcloud compute scp` rather than rsync: rsync is not present in Git Bash
# on Windows, and gcloud is already a dependency of this deployment.
set -euo pipefail

VM="${VM:-sitechat}"
ZONE="${ZONE:-us-central1-a}"
REMOTE="/srv/sitechat"
STAGE="/tmp/sitechat-deploy"

cd "$(dirname "$0")/.."

echo "==> Building"
npm run build

# node_modules is deliberately NOT shipped. better-sqlite3 is a native module;
# a binary built on this machine would be the wrong platform for the VM, so the
# install runs over there against the same package.json.
echo "==> Packaging"
TARBALL="$(mktemp -t sitechat-XXXXXX).tar.gz"
tar -czf "$TARBALL" \
  server/dist server/package.json server/config \
  web/dist widget/dist \
  deploy/Caddyfile deploy/sitechat.service deploy/backup.sh deploy/provision.sh deploy/install.sh

echo "==> Uploading to ${VM} (${ZONE})"
gcloud compute ssh "$VM" --zone "$ZONE" --command "rm -rf ${STAGE} && mkdir -p ${STAGE}"
gcloud compute scp "$TARBALL" "${VM}:${STAGE}/payload.tar.gz" --zone "$ZONE"
rm -f "$TARBALL"

echo "==> Installing"
# The install half lives in deploy/install.sh so the console-driven path in
# deploy/README.md runs exactly the same steps this does.
gcloud compute ssh "$VM" --zone "$ZONE" --command "cd ${STAGE} && tar -xzf payload.tar.gz && bash deploy/install.sh"

echo "==> Deployed."
