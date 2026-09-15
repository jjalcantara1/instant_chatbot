# Deploying Instant Site Chat

## Where this runs, and why

**One `e2-micro` Compute Engine VM in `us-central1-a`, single origin behind Caddy.**

> Deployed 2026-09-03 to project `instant-chat-507506`, instance `sitechat`,
> static IP `34.121.219.224`, serving `sitechat.kleiosoftware.com`.

The app pins itself to a single persistent process:

- `server/src/http/jobs.ts:45` keeps live crawls in an in-process `Map` — the
  event buffer *and* the SSE subscriber list. If the POST that starts a crawl
  and the `EventSource` that watches it land on different instances, the visitor
  watches an empty log. That is the whole demo.
- `jobs.ts:63` is an in-process semaphore, so `CONCURRENT_CRAWLS=3` means three
  *per instance*, not three in total.
- `better-sqlite3` is a native module writing a WAL-mode file that must survive
  restarts.

So: exactly one process, one writable disk. That rules out the obvious options.

| Option | Verdict |
|---|---|
| **Vercel** | No. Serverless functions have no filesystem that outlives a request and no process that outlives one either — the jobs `Map` evaporates between the POST and the `EventSource`. Would need Postgres + Redis + a worker, i.e. a rewrite. |
| **Firebase Functions / App Hosting** | No. Same serverless model (App Hosting is Cloud Run underneath). |
| **Cloud Run** | Workable only if forced to `--min-instances=1 --max-instances=1`, and its disk is still ephemeral — destroyed on every instance shutdown, so a routine recycle drops the session of whichever prospect is mid-demo. GCS FUSE volume mounts do not rescue SQLite (no POSIX locking). `max-instances=1` is also an invisible tripwire: raising it silently breaks the jobs `Map`. Roughly $15–25/mo with CPU always allocated. |
| **Compute Engine VM** | Yes. Persistent disk, one process, and `deploy/` already targets it. Roughly $13/mo for `e2-small`. |

**Firebase Hosting is still an option for the page only** — see "The split
alternative" below — but it costs code changes, so the default here is single
origin.

### Sizing

Running on the free-tier `e2-micro` (1 GB) with `CONCURRENT_CRAWLS=2`, not the
`e2-small` this was first specced for. Memory is the ceiling: `CONCURRENT_CRAWLS`
times `crawlConcurrency=6` is that many jsdom documents in flight, each parsing
a body of up to 2 MB. At 3 the box would OOM; 2 fits inside 1 GB plus the 2 GB
of swap `provision.sh` adds. **If crawls die partway on larger sites, drop it to
1** — queued visitors then wait rather than fail.

Free tier is `us-west1` / `us-central1` / `us-east1` only, requires a *standard*
persistent disk of at most 30 GB, and caps North America egress at 1 GB/month —
about 11,000 page loads at ~85 KB gzipped. Moving to `e2-small` (~$15/mo) lifts
the memory ceiling and allows `CONCURRENT_CRAWLS=3`.

## First run

What was actually run, in order. Zone and region come from the gcloud config
(`us-central1-a` / `us-central1`), so they are not repeated per command.

```bash
# 1. Firewall. The default VPC ships ssh/rdp/icmp/internal but NOT http/https --
#    the console's "Allow HTTP traffic" checkboxes create these; the CLI does not.
#    Without them Caddy's ACME challenge fails and it looks like a DNS problem.
gcloud compute firewall-rules create default-allow-http \
  --allow tcp:80 --target-tags http-server --network default
gcloud compute firewall-rules create default-allow-https \
  --allow tcp:443 --target-tags https-server --network default

# 2. Static IP. An ephemeral one changes on stop/start and orphans the DNS record.
gcloud compute addresses create sitechat-ip --region us-central1

# 3. The VM. pd-standard and 30 GB are what free tier requires.
gcloud compute instances create sitechat \
  --machine-type e2-micro \
  --image-family debian-12 --image-project debian-cloud \
  --boot-disk-size 30GB --boot-disk-type pd-standard \
  --tags http-server,https-server --address sitechat-ip

# 4. Provision. Note pscp does not expand `~`, so upload to an absolute path.
gcloud compute scp sitechat-deploy.tar.gz sitechat:/tmp/sitechat-deploy.tar.gz
gcloud compute ssh sitechat --command \
  "mkdir -p /tmp/sitechat && tar -xzf /tmp/sitechat-deploy.tar.gz -C /tmp/sitechat \
   && bash /tmp/sitechat/deploy/provision.sh"

# 5. DNS. An A record for sitechat.kleiosoftware.com at the static IP.
#    Caddy cannot issue a certificate until this resolves publicly.

# 6. Create /srv/sitechat/.env from env.production.example, fill in
#    GEMINI_API_KEY and VOYAGE_API_KEY, and generate fresh secrets:
#      openssl rand -hex 32   # IP_HASH_SALT
#      openssl rand -hex 32   # ADMIN_TOKEN
#    Then: sudo chown root:sitechat /srv/sitechat/.env && sudo chmod 640 ...

# 7. Ship it.
VM=sitechat ZONE=us-central1-a ./deploy/deploy.sh
```

Do **not** copy the dev `.env` up. `IP_HASH_SALT` and `ADMIN_TOKEN` in it are
placeholder values, and the salt is what anonymises rate-limit IP hashes.

## Subsequent deploys

```bash
VM=sitechat ZONE=us-central1-a ./deploy/deploy.sh
```

Builds locally, ships `server/dist`, `web/dist`, `widget/dist` and
`server/config`, installs production deps **on the VM**, restarts, and blocks on
`/healthz`.

`node_modules` is never uploaded: `better-sqlite3` is a native module, and a
binary built on a Windows workstation is the wrong platform for a Linux VM.
`rsync` is also absent from Git Bash on Windows, which is why this uses
`gcloud compute scp` rather than the rsync line the root README used to carry.

## Two traps that were already in these files

Both would have produced a service that starts cleanly and then fails.

**1. `IPAddressDeny` in the systemd unit broke the reverse proxy and DNS.**
The old unit had `IPAddressDeny=localhost link-local multicast`. systemd's IP
filter is not direction-aware, so denying loopback blocks Caddy dialling *in* to
`:8080` exactly as it blocks the crawler dialling *out* — every request 502s.
`link-local` is worse on GCE specifically: the resolver is either the metadata
server on `169.254.169.254` or a `systemd-resolved` stub on `127.0.0.53`, so one
of those two rules kills DNS and no crawl resolves at all.

The rules are also redundant. `server/src/crawl/ssrf.ts` blocks `127.0.0.0/8`,
`::1` and `169.254.0.0/16` for *crawl targets only*, re-runs on every redirect
hop, and pins the connection to the addresses it vetted so DNS cannot be rebound
underneath it — direction-aware in the way systemd cannot be, with 51 tests
covering it. The unit now carries a comment saying not to add them back.

**2. Caddy compressed the SSE streams.** The old `encode gzip` applied to every
route including `/events`, and compression buffers. `flush_interval -1` alone
does not help if the encoder is holding the bytes. The stream routes are now
excluded from `encode` via the `@buffered` matcher.

## Verifying a deploy

```bash
curl -s https://sitechat.kleiosoftware.com/healthz
curl -sI https://sitechat.kleiosoftware.com/widget.js | grep -i access-control

# The one that matters: events must arrive incrementally, not in one lump.
curl -N -s -X POST https://sitechat.kleiosoftware.com/api/sessions \
  -H 'content-type: application/json' -d '{"url":"https://example.com"}'
curl -N -s https://sitechat.kleiosoftware.com/api/sessions/SESSION_ID/events

curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://sitechat.kleiosoftware.com/admin/stats
```

If the crawl log arrives all at once at the end, `encode` is compressing the
stream — check the `@buffered` matcher.

```bash
sudo journalctl -u sitechat -f      # app logs
sudo tail -f /var/log/caddy/sitechat.log
```

## When it breaks

### Indexing fails with RATE_LIMITED partway through

The embedding provider, not this app. An unbilled Voyage key is capped at
**3 requests/min and 10,000 tokens/min**, and Voyage says so verbatim in the
error body visible via `journalctl -u sitechat`. Chunks target 800 characters
(~200 tokens), so `EMBEDDING_BATCH_SIZE=16` with
`EMBEDDING_MIN_INTERVAL_MS=21000` is ~2.9 RPM and ~9.6k TPM — just inside both.
Batches of 32 satisfy the request limit but exceed the token limit and fail.

The cost is speed: a 17-page site is ~245 chunks, so ~16 requests and about five
minutes rather than the under-a-minute the demo promises. The real fix is adding
a payment method at `dashboard.voyageai.com`, which is free — Voyage still grants
200M tokens for series-3 models with a card on file. Then set these back to
`100 / 4 / 0`.

### The service dies immediately with `code=killed, signal=TRAP`

`MemoryDenyWriteExecute=yes` in the systemd unit. V8 is a JIT: it maps pages
writable and then executable to emit machine code, which is exactly what that
setting forbids. It is not in the shipped unit and must not be added.

### Caddy fails with `open /var/log/caddy/*.log: permission denied`

Something ran `caddy` as root and created the log file `root:root 0600`; Caddy
runs as `caddy` and cannot then open its own log. `caddy validate` does this,
which is why `install.sh` chowns `/var/log/caddy` immediately afterwards. Fix by
hand with `sudo chown -R caddy:caddy /var/log/caddy` and restart.

### The site will not serve HTTPS

Usually DNS or firewall, not Caddy. Confirm the A record resolves publicly, and
that the VM carries the `http-server` / `https-server` tags. Note that a
successful HTTP-01 challenge followed by `HTTP 404 ... Certificate not found` is
a transient Let's Encrypt condition — Caddy retries in 60s and succeeds.

```bash
sudo journalctl -u caddy -n 60 --no-pager
```

### Crawls die partway on bigger sites

Memory. Confirm swap is active with `free -h`; if it is and crawls still fail,
drop `CONCURRENT_CRAWLS` to `1` and `sudo systemctl restart sitechat`.

### Routine operations

```bash
sudo journalctl -u sitechat -f
sudo tail -f /var/log/caddy/sitechat.log
sudo systemctl restart sitechat
```

## The split alternative (Firebase Hosting for the page)

Not wired up, and it is not a config change. `routes.ts:99` anticipates it, but
the client was never finished for it. It needs:

1. **An API base in the client.** `web/src/api.ts` calls relative paths in four
   places (`fetch('/api/sessions')`, `new EventSource(...)`, and so on). Each
   needs an `import.meta.env.VITE_API_BASE` prefix.
2. **CORS on the SSE route.** `GET /api/sessions/:id/events` sets no
   `Access-Control-Allow-Origin`, so a cross-origin `EventSource` fails.
3. **A preflight for `POST /api/sessions`.** It sends `content-type:
   application/json`, which triggers an `OPTIONS` preflight, and only
   `/api/sessions/:id/messages` has an `OPTIONS` handler today.

The widget already handles cross-origin correctly — it derives its API origin
from its own `script.src` and only touches the two routes that *are* CORS'd, so
none of this affects embedding.

Routing `/api` through a Firebase Hosting rewrite to avoid CORS does **not**
work: Hosting rewrites cap out at 60s and buffer through the CDN, which breaks
both the 45s crawl stream and chat streaming.

`firebase.json` is left in place — it still serves the main Kleio site.
