#!/usr/bin/env bash
# First-time setup for a fresh Debian 12 GCE VM. Run once, ON THE VM, as a user
# with sudo. Idempotent -- safe to re-run if a step fails partway.
#
#   curl -fsSL .../provision.sh | bash     # or just scp it up and run it
set -euo pipefail

DOMAIN="${DOMAIN:-sitechat.kleio-software.dev}"

echo "==> 1/7  Base packages"
sudo apt-get update -qq
# build-essential/python3: better-sqlite3 compiles from source if no prebuilt
# binary matches the VM's Node ABI.
sudo apt-get install -y -qq ca-certificates curl gnupg debian-keyring debian-archive-keyring apt-transport-https sqlite3 build-essential python3

echo "==> 2/7  Node 22 (NodeSource)"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi
node -v

echo "==> 3/7  Caddy"
if ! command -v caddy >/dev/null 2>&1; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | sudo gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq caddy
fi
caddy version

echo "==> 4/7  Service account and directory layout"
# --system: no login shell, no home. It only ever runs one binary.
id -u sitechat >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin sitechat
sudo mkdir -p /srv/sitechat/{server,web,widget/dist,data,backups}
sudo chown -R sitechat:sitechat /srv/sitechat/data /srv/sitechat/backups
sudo chown -R root:root /srv/sitechat/server /srv/sitechat/web /srv/sitechat/widget

echo "==> 5/7  Swap"
# Crawls are the memory hog: CONCURRENT_CRAWLS x 6 bodies in flight, each up to
# 2 MB. Swap is the difference between a slow crawl and an OOM kill.
if ! sudo swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi
free -h | head -3

echo "==> 6/7  Nightly backup at 03:17"
sudo install -m 755 -o root -g root /tmp/sitechat-deploy/backup.sh /srv/sitechat/backup.sh 2>/dev/null || true
# Built in a temp file rather than piped. On a box with no root crontab yet,
# `crontab -l` exits 1 and, under `set -euo pipefail`, that both aborts the
# script and pipes an empty crontab over the top of whatever was there.
CRON_TMP="$(mktemp)"
sudo crontab -l 2>/dev/null | grep -v 'sitechat/backup.sh' > "$CRON_TMP" || true
echo "17 3 * * * DATABASE_PATH=/srv/sitechat/data/sitechat.db /srv/sitechat/backup.sh >/dev/null 2>&1" >> "$CRON_TMP"
sudo crontab "$CRON_TMP"
rm -f "$CRON_TMP"

echo "==> 7/7  Log directory for Caddy"
sudo mkdir -p /var/log/caddy
sudo chown caddy:caddy /var/log/caddy

cat <<DONE

Provisioned. Remaining manual steps, in order:

  1. Point DNS: an A record for ${DOMAIN} at this VM's static external IP.
     Caddy will not get a certificate until that resolves.

  2. Create /srv/sitechat/.env from deploy/env.production.example and fill in
     GEMINI_API_KEY, VOYAGE_API_KEY, and freshly generated secrets:

        openssl rand -hex 32     # IP_HASH_SALT
        openssl rand -hex 32     # ADMIN_TOKEN

     Then lock it down -- it is world-readable by default:

        sudo chown root:sitechat /srv/sitechat/.env
        sudo chmod 640 /srv/sitechat/.env

  3. Run deploy/deploy.sh from your workstation to push the built artifacts.

DONE
