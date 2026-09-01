/**
 * Phase 1 CLI. No HTTP server, no database.
 *   npm run crawl -- https://example.com [--max 25] [--timeout 45000]
 */
import { crawl } from '../crawl/crawler.js';
import { closeFetcher } from '../crawl/fetcher.js';
import { scoreUrl } from '../crawl/priority.js';
import { config } from '../config.js';

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : fallback;
}

const target = process.argv[2];
if (!target || target.startsWith('--')) {
  console.error('usage: npm run crawl -- <url> [--max N] [--timeout MS]');
  process.exit(1);
}

const maxPages = arg('max', config.maxPages);
const timeoutMs = arg('timeout', config.crawlTimeoutMs);

const t0 = Date.now();
let n = 0;

const summary = await crawl(
  target,
  {
    onStage: (stage) => console.log(`\n[stage] ${stage}`),
    onPage: (p) => {
      n++;
      const ms = String(Date.now() - t0).padStart(6);
      const mark = p.status === 'ok' ? '+' : p.status === 'empty' ? '~' : 'x';
      const chars = String(p.charCount).padStart(6);
      const score = String(scoreUrl(p.url, target)).padStart(4);
      console.log(
        `${String(n).padStart(3)}. ${mark} ${ms}ms ${chars}c score=${score} ${p.url}` +
        (p.title ? `\n         "${p.title.slice(0, 78)}"` : '') +
        (p.error ? `\n         ! ${p.error}` : ''),
      );
    },
  },
  { maxPages, timeoutMs },
);

const ok = summary.pages.filter((p) => p.status === 'ok');
const empty = summary.pages.filter((p) => p.status === 'empty');
const errored = summary.pages.filter((p) => p.status === 'error' || p.status === 'skipped');
const totalChars = ok.reduce((s, p) => s + p.charCount, 0);

console.log('\n' + '='.repeat(72));
console.log(`domain          ${summary.domain}`);
console.log(`elapsed         ${summary.elapsedMs}ms`);
console.log(`robots.txt      ${summary.robotsLoaded ? 'loaded' : 'absent (failed open)'}`);
console.log(`sitemap urls    ${summary.sitemapCount}`);
console.log(`pages fetched   ${summary.pages.length}  (ok ${ok.length} / empty ${empty.length} / error ${errored.length})`);
console.log(`content         ${totalChars.toLocaleString()} chars, median ${median(ok.map((p) => p.charCount))}`);
console.log(`stopped because ${summary.hitPageCap ? 'page cap' : summary.hitDeadline ? 'deadline' : 'queue drained'}`);
const emptyRatio = summary.pages.length ? empty.length / summary.pages.length : 0;
console.log(`empty ratio     ${(emptyRatio * 100).toFixed(0)}%${emptyRatio > 0.7 ? '  <-- would fail as SPA_DETECTED' : ''}`);
console.log('='.repeat(72));

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

await closeFetcher();
