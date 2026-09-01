import { config } from '../config.js';
import { safeFetch, type FetchResult } from './fetcher.js';
import { fetchRobots } from './robots.js';
import { collectSitemapUrls } from './sitemap.js';
import { normaliseUrl, hasSkippableExtension, sameSite, registrableDomain } from './urlnorm.js';
import { scoreUrl, PriorityQueue } from './priority.js';
import { extract, type Section } from '../indexing/extract.js';

export type PageStatus = 'ok' | 'empty' | 'error' | 'skipped';

export interface CrawledPage {
  url: string;
  title: string;
  status: PageStatus;
  charCount: number;
  text: string;
  sections: Section[];
  error?: string;
}

export interface CrawlSummary {
  pages: CrawledPage[];
  domain: string;
  elapsedMs: number;
  hitPageCap: boolean;
  hitDeadline: boolean;
  robotsLoaded: boolean;
  sitemapCount: number;
}

export interface CrawlHandlers {
  /** Awaited, so the caller can push chunks onto the embed queue as pages land. */
  onPage?: (page: CrawledPage) => void | Promise<void>;
  onProgress?: (p: { pagesFetched: number; pagesQueued: number; stage: string }) => void;
  onStage?: (stage: string) => void;
}

export interface CrawlOptions {
  maxPages?: number;
  timeoutMs?: number;
  concurrency?: number;
  signal?: AbortSignal;
}

export async function crawl(
  startUrl: string,
  handlers: CrawlHandlers = {},
  options: CrawlOptions = {},
): Promise<CrawlSummary> {
  const maxPages = options.maxPages ?? config.maxPages;
  const timeoutMs = options.timeoutMs ?? config.crawlTimeoutMs;
  const concurrency = options.concurrency ?? config.crawlConcurrency;

  const started = Date.now();
  const deadlineAt = started + timeoutMs;

  const normalisedRoot = normaliseUrl(startUrl);
  if (!normalisedRoot) throw new Error('INVALID_URL');

  // Resolve the seed before anything else. Pasting an aliased or legacy domain
  // (old-domain.com, or a *.web.app that redirects to the custom domain) should
  // follow to the canonical site rather than being refused as off-domain. Only
  // the seed gets this treatment; every later redirect off-site is still cut.
  handlers.onStage?.('resolving');
  const prefetched = new Map<string, Extract<FetchResult, { ok: true }>>();
  let resolvedRoot = normalisedRoot;
  const seedRes = await safeFetch(normalisedRoot, { timeoutMs: config.perRequestTimeoutMs });
  if (seedRes.ok) {
    resolvedRoot = normaliseUrl(seedRes.finalUrl) ?? normalisedRoot;
    prefetched.set(resolvedRoot, seedRes);
  }

  // Bound explicitly: `worker` below is a hoisted declaration, so TypeScript
  // will not carry the null-narrowing above into it.
  const root: string = resolvedRoot;
  const domain = registrableDomain(root) ?? new URL(root).hostname;

  handlers.onStage?.('robots');
  const robots = await fetchRobots(root);

  handlers.onStage?.('sitemap');
  let sitemapUrls: string[] = [];
  try {
    sitemapUrls = await collectSitemapUrls(root, robots.sitemaps);
  } catch { /* a broken sitemap is not fatal */ }

  const queue = new PriorityQueue<string>();
  const seen = new Set<string>();
  const pages: CrawledPage[] = [];

  const enqueue = (url: string): void => {
    const norm = normaliseUrl(url);
    if (!norm) return;
    if (seen.has(norm)) return;
    if (!sameSite(norm, root)) return;
    if (hasSkippableExtension(norm)) return;
    if (!robots.isAllowed(norm)) return;
    seen.add(norm);
    queue.push(norm, scoreUrl(norm, root));
  };

  enqueue(root);
  for (const u of sitemapUrls) enqueue(u);

  handlers.onStage?.('crawling');

  let hitPageCap = false;
  let hitDeadline = false;
  let active = 0;

  const takenSlots = (): number => pages.length + active;

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  async function worker(): Promise<void> {
    for (;;) {
      if (options.signal?.aborted) return;
      if (Date.now() >= deadlineAt) { hitDeadline = true; return; }
      if (takenSlots() >= maxPages) { if (pages.length >= maxPages) hitPageCap = true; return; }

      const url = queue.pop();
      if (url === undefined) {
        // The queue seeds with a single URL, so every worker but one would
        // otherwise exit before the first page had a chance to add links.
        // Only stop once nothing is in flight that could still enqueue work.
        if (active === 0) return;
        await sleep(25);
        continue;
      }

      active++;
      try {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) { hitDeadline = true; return; }

        // The seed was already fetched during resolution; do not pay for it twice.
        const cached = prefetched.get(url);
        if (cached) prefetched.delete(url);
        const res: FetchResult = cached ?? await safeFetch(url, {
          timeoutMs: Math.min(config.perRequestTimeoutMs, remaining),
        });

        let page: CrawledPage;

        if (!res.ok) {
          page = {
            url,
            title: '',
            status: res.reason === 'NOT_HTML' ? 'skipped' : 'error',
            charCount: 0,
            text: '',
            sections: [],
            error: res.detail,
          };
        } else if (!sameSite(res.finalUrl, root)) {
          // A redirect can walk us off the site. The SSRF guard still ran on
          // every hop, so this is safe to have fetched, but the content is not
          // the visitor's and must not become a citable source.
          page = {
            url: res.finalUrl,
            title: '',
            status: 'skipped',
            charCount: 0,
            text: '',
            sections: [],
            error: 'Redirected off the site.',
          };
        } else {
          const ex = extract(res.html, res.finalUrl);
          // Discover more of the site even from pages we end up discarding.
          for (const link of ex.links) enqueue(link);

          page = {
            url: res.finalUrl,
            title: ex.title,
            status: ex.text.length < 150 ? 'empty' : 'ok',
            charCount: ex.text.length,
            text: ex.text,
            sections: ex.sections,
          };
        }

        pages.push(page);
        await handlers.onPage?.(page);
        handlers.onProgress?.({
          pagesFetched: pages.length,
          pagesQueued: queue.size,
          stage: 'crawling',
        });
      } finally {
        active--;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  if (pages.length >= maxPages) hitPageCap = true;
  if (Date.now() >= deadlineAt) hitDeadline = true;

  return {
    pages,
    domain,
    elapsedMs: Date.now() - started,
    hitPageCap,
    hitDeadline,
    robotsLoaded: robots.loaded,
    sitemapCount: sitemapUrls.length,
  };
}
