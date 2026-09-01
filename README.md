# Instant Site Chat

Paste your website. Watch it get read. Ask it things.

A public demo for Kleio. A visitor pastes a URL, watches the crawl happen live,
and is chatting with their own content in under a minute. The conversion
mechanism is that they evaluate the work on content they already know cold —
so retrieval honesty matters more than answer fluency.

```
server/   Node 20+ · Express · TypeScript · SQLite (better-sqlite3)
web/      React · Vite · Tailwind — the demo page
widget/   Vanilla TS, shadow DOM, single-file IIFE — the embeddable bundle
deploy/   systemd unit, Caddyfile, backup script
```

## Quick start

```bash
npm install
cp .env.example .env      # then fill in the two API keys
npm run dev               # API on :8080
npm run dev:web           # demo page on :5173, proxied to the API
```

Native modules (`better-sqlite3`, `esbuild`) need their install scripts to run.
npm 11 blocks these by default; if `npm install` warns about `allow-scripts`:

```bash
npm install-scripts approve better-sqlite3
npm install-scripts approve esbuild
npm install
```

## Required configuration

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Chat. Without it, indexing works but answering fails. |
| `OPENAI_API_KEY` | Embeddings. Without it, indexing fails. |
| `IP_HASH_SALT` | Salts the rate-limit IP hashes. **Change from the default.** |
| `ADMIN_TOKEN` | Bearer token for `/admin/stats`. Unset disables the route. |
| `PUBLIC_WIDGET_ORIGIN` | Public origin of *this API*. The embed snippet is built from it, so it must be where `widget.js` is actually served — not where the demo page is hosted. |

`CHAT_MODEL` defaults to `claude-haiku-4-5-20251001`, the pinned snapshot for
Claude Haiku 4.5. The dateless alias `claude-haiku-4-5` resolves to the same
model. Speed is the product here, so no thinking is requested; Haiku 4.5 does
not support the `effort` parameter.

## Development commands

```bash
npm run crawl -- https://example.com          # crawl only, prints to stdout
npm --workspace server run index-site -- URL  # crawl + chunk + embed into SQLite
npm --workspace server run dump -- SESSION_ID # print a session's chunks to read
npm run eval                                  # the retrieval-honesty gate
npm test                                      # 68 tests
```

`EMBEDDING_PROVIDER=hash` swaps in a deterministic offline embedder so the
pipeline runs without an API key. It is for exercising plumbing only — its
vector geometry is poor enough that the similarity floor does not separate
on-topic from off-topic queries, which is why `npm run eval` refuses to run
with it.

## How the "not on this site" guarantee works

The single failure that would kill this demo is a fluent, confident, wrong
answer about the visitor's own website. That is prevented structurally rather
than by asking the model nicely:

1. Hybrid retrieval (cosine + BM25) fused with reciprocal rank fusion.
2. Every surviving chunk must clear a raw cosine floor of `0.25`, however much
   BM25 liked it.
3. If fewer than 2 chunks clear it, `streamAnswer` returns a refusal **without
   calling the model at all** — deterministic, free, and impossible to talk
   past.

`test/retrieval-gate.test.ts` asserts this offline. `npm run eval` calibrates
the floor against real embeddings using 15 questions, 10 answerable and 5
deliberately absent, and fails the build if any absent question gets answered.

## Architecture notes

- **SSRF guard** (`server/src/crawl/ssrf.ts`) runs before every request and
  again on each redirect hop. The fetcher pins connections to the exact
  addresses the guard vetted, closing the DNS-rebinding window between
  validation and connect. 51 tests cover it.
- **Pipelined indexing.** Chunks are pushed to an embed queue as pages land, so
  embedding overlaps the crawl. Boilerplate detection needs a sample of pages
  first, so the pipeline warms up on the first 6 and streams everything after.
- **Vectors live in SQLite** as `Float32Array` blobs; cosine is a dot product
  in-process. At a few hundred to a few thousand vectors this is microseconds,
  and the operational simplicity beats running a vector database.
- **Public suffix list** with private domains enabled, so a crawl seeded at
  `foo.github.io` does not treat every other site on that suffix as in scope.

## Deploying

Backend on the VPS behind Caddy:

```bash
npm run build
rsync -a --delete server/dist server/package.json server/config /srv/sitechat/server/
rsync -a widget/dist /srv/sitechat/widget/
sudo cp deploy/sitechat.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now sitechat
```

`deploy/Caddyfile` disables proxy buffering on the SSE routes — without that
the crawl log arrives all at once at the end, which defeats the entire point.

Frontend to Firebase Hosting alongside the existing Kleio site:

```bash
npm run build && firebase deploy --only hosting
```

Add `deploy/backup.sh` to cron nightly. The 24-hour TTL means a lost day costs
nothing much.

## Limits

25 pages per crawl · 45s hard cap · 3 indexes per IP per hour · 60 messages per
IP per hour · 20 messages per session · 3 concurrent crawls · 200 indexes per
day · sessions swept hourly, TTL 24h.

Roughly $0.0012 of embeddings per index; chat is cents. The risk is volume, not
unit price, which is what the caps are for. `/admin/stats` reports the day's
token usage and an estimated cost.
