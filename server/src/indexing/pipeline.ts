import { config, crawlBudgetMs } from '../config.js';
import { crawl, type CrawledPage, type FrontierEntry } from '../crawl/crawler.js';
import { findBoilerplateLines, stripBoilerplate } from './boilerplate.js';
import { chunkPage, type Chunk } from './chunk.js';
import { embedBatched, getEmbedder, toBlob, type Embedder } from './embed.js';
import type { DB } from '../db.js';

export type IndexEvent =
  | { type: 'stage'; stage: string }
  | { type: 'page'; url: string; title: string; status: string; charCount: number }
  | { type: 'progress'; pagesFetched: number; pagesQueued: number; chunks: number; embedded: number; stage: string }
  | {
      type: 'ready';
      pages: number;
      chunks: number;
      elapsedMs: number;
      skipped: number;
      /** Pages discovered and left unread — what "read more" would work through. */
      frontier: number;
    }
  | { type: 'error'; code: IndexErrorCode; message: string };

export type IndexErrorCode =
  | 'INVALID_URL' | 'BLOCKED_HOST' | 'ROBOTS_DISALLOWED' | 'UNREACHABLE'
  | 'NOT_HTML' | 'SPA_DETECTED' | 'TOO_SMALL' | 'RATE_LIMITED' | 'INTERNAL';

export class IndexError extends Error {
  constructor(public readonly code: IndexErrorCode, message: string) {
    super(message);
    this.name = 'IndexError';
  }
}

export interface IndexResult {
  /** Usable pages read by THIS pass. */
  pages: number;
  /** Chunks embedded by THIS pass. */
  chunks: number;
  /** Usable pages in the session, across every pass. */
  totalPages: number;
  /** Chunks in the session, across every pass. */
  totalChunks: number;
  elapsedMs: number;
  skipped: number;
  domain: string;
  embedTokens: number;
  /** Size of the saved frontier — how many more pages are known but unread. */
  frontier: number;
}

/**
 * Pages are buffered until this many have arrived, so boilerplate can be
 * detected before the first chunk is written.
 *
 * The spec asks for two things that pull against each other: compute
 * boilerplate across the whole crawl, and start embedding before the crawl
 * finishes. Waiting for every page would serialise the pipeline and cost the
 * ~3s that pipelining exists to save. Nav and cookie lines repeat on
 * essentially every page, so a small sample identifies them just as well;
 * this warms up on the first few pages, freezes the boilerplate set, then
 * streams everything after that straight through.
 */
const BOILERPLATE_SAMPLE = 6;

/** Embedding round trips issued in parallel. */
const EMBED_CONCURRENCY = config.embeddingConcurrency;

interface PendingChunk extends Chunk { pageId: number; }

export interface RunIndexOptions {
  db: DB;
  sessionId: string;
  url: string;
  emit: (event: IndexEvent) => void;
  embedder?: Embedder;
  /** Pages this pass may read. Defaults to the landing page and nothing else. */
  maxPages?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * 'initial' builds a session and refuses to finish one there is nothing to
   * chat with. 'expand' adds to a session that already works, so an empty pass
   * is a disappointment rather than a failure and must not tear it down.
   */
  mode?: 'initial' | 'expand';
  /** Frontier carried over from an earlier pass. */
  seeds?: string[];
  /** URLs already read, so this pass spends its budget on new pages only. */
  visited?: string[];
  useSitemap?: boolean;
  resolveSeed?: boolean;
}

export async function runIndex(opts: RunIndexOptions): Promise<IndexResult> {
  const { db, sessionId, url, emit } = opts;
  const embedder = opts.embedder ?? getEmbedder();
  const mode = opts.mode ?? 'initial';
  const maxPages = opts.maxPages ?? config.defaultPages;
  const started = Date.now();

  const insertPage = db.prepare(
    'INSERT INTO pages (session_id, url, title, status, char_count) VALUES (?, ?, ?, ?, ?)',
  );
  const insertChunk = db.prepare(
    'INSERT INTO chunks (session_id, page_id, heading_path, text, tokens, embedding) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const updateSession = db.prepare(
    `UPDATE sessions
        SET status = ?, page_count = ?, chunk_count = ?,
            root_url = ?, page_budget = ?, discovered = ?
      WHERE id = ?`,
  );

  const buffered: CrawledPage[] = [];
  const pageIds = new Map<CrawledPage, number>();
  let boilerplate: Set<string> | null = null;

  const pendingEmbed: PendingChunk[] = [];
  let chunksStored = 0;
  let embedTokens = 0;
  let crawlDone = false;
  let embedError: Error | null = null;
  let pagesFetched = 0;
  let pagesQueued = 0;

  const savePage = (page: CrawledPage): number => {
    const info = insertPage.run(sessionId, page.url, page.title || null, page.status, page.charCount);
    return Number(info.lastInsertRowid);
  };

  /** Chunk one page and hand its chunks to the embed queue. */
  const processPage = (page: CrawledPage, pageId: number): void => {
    if (page.status !== 'ok') return;
    const cleanedSections = page.sections
      .map((s) => ({ ...s, text: boilerplate ? stripBoilerplate(s.text, boilerplate) : s.text }))
      .filter((s) => s.text.trim().length > 0);
    for (const c of chunkPage(page.title, cleanedSections)) {
      pendingEmbed.push({ ...c, pageId });
    }
  };

  const flushBuffer = (): void => {
    boilerplate = findBoilerplateLines(buffered.filter((p) => p.status === 'ok').map((p) => p.text));
    for (const page of buffered) processPage(page, pageIds.get(page) as number);
    buffered.length = 0;
  };

  // Background embedder: drains the queue while the crawl is still running.
  const embedLoop = (async (): Promise<void> => {
    for (;;) {
      if (embedError) return;
      const ready = pendingEmbed.length;
      const shouldFlush = ready >= config.embeddingBatchSize || (crawlDone && ready > 0);
      if (!shouldFlush) {
        if (crawlDone && ready === 0) return;
        await new Promise((r) => setTimeout(r, 40));
        continue;
      }

      // Drain several batches at once so embedBatched can run them in
      // parallel; taking exactly one batch would serialise every round trip.
      const batch = pendingEmbed.splice(0, config.embeddingBatchSize * EMBED_CONCURRENCY);
      const res = await embedBatched(
        embedder,
        batch.map((c) => c.embedText),
        config.embeddingBatchSize,
        EMBED_CONCURRENCY,
      );
      embedTokens += res.tokens;

      const writeAll = db.transaction((rows: PendingChunk[], vecs: Float32Array[]) => {
        rows.forEach((row, i) => {
          insertChunk.run(sessionId, row.pageId, row.headingPath || null, row.text, row.tokens, toBlob(vecs[i] as Float32Array));
        });
      });
      writeAll(batch, res.vectors);
      chunksStored += batch.length;

      emit({
        type: 'progress',
        pagesFetched: pagesFetched,
        pagesQueued: pagesQueued,
        chunks: chunksStored + pendingEmbed.length,
        embedded: chunksStored,
        stage: crawlDone ? 'indexing' : 'crawling',
      });
    }
  })().catch((e: unknown) => { embedError = e as Error; });

  const summary = await crawl(
    url,
    {
      onStage: (stage) => emit({ type: 'stage', stage }),
      onPage: (page) => {
        const pageId = savePage(page);
        pageIds.set(page, pageId);
        pagesFetched++;

        emit({
          type: 'page',
          url: page.url,
          title: page.title,
          status: page.status,
          charCount: page.charCount,
        });

        if (boilerplate === null) {
          buffered.push(page);
          if (buffered.length >= BOILERPLATE_SAMPLE) flushBuffer();
        } else {
          processPage(page, pageId);
        }
      },
      onProgress: (p) => {
        pagesQueued = p.pagesQueued;
        emit({
          type: 'progress',
          pagesFetched: p.pagesFetched,
          pagesQueued: p.pagesQueued,
          // Chunks that exist, including those still queued for embedding.
          // Counting only stored ones leaves this at zero for the first few
          // seconds, which reads as broken during the part people watch.
          chunks: chunksStored + pendingEmbed.length,
          embedded: chunksStored,
          stage: 'crawling',
        });
      },
    },
    {
      maxPages,
      timeoutMs: opts.timeoutMs ?? crawlBudgetMs(maxPages),
      signal: opts.signal,
      ...(opts.seeds ? { seeds: opts.seeds } : {}),
      ...(opts.visited ? { visited: opts.visited } : {}),
      ...(opts.useSitemap === undefined ? {} : { useSitemap: opts.useSitemap }),
      ...(opts.resolveSeed === undefined ? {} : { resolveSeed: opts.resolveSeed }),
    },
  );

  // The crawl may have ended before the sample size was reached.
  if (boilerplate === null) flushBuffer();

  emit({ type: 'stage', stage: 'indexing' });
  crawlDone = true;
  await embedLoop;
  if (embedError) throw embedError;

  const usable = summary.pages.filter((p) => p.status === 'ok');
  const emptyCount = summary.pages.filter((p) => p.status === 'empty').length;
  const skipped = summary.pages.length - usable.length;
  const readable = usable.length + emptyCount;

  // An expansion runs on top of a session that already answers questions.
  // Finding nothing new is worth reporting, but it is not grounds for throwing
  // away a working index, so the gates below apply to the first pass only.
  if (mode === 'initial') {
    assertUsable(usable.length, emptyCount, readable, chunksStored);
  }

  const alreadyDiscovered = wasDiscovered(db, sessionId);
  saveFrontier(db, sessionId, summary.frontier);

  const totals = sessionTotals(db, sessionId);
  const budget = currentBudget(db, sessionId);

  updateSession.run(
    'ready',
    totals.pages,
    totals.chunks,
    summary.rootUrl,
    Math.max(budget, maxPages, totals.pages),
    // Sticky: once discovery has been paid for, a later pass must not pay again.
    summary.sitemapUsed || alreadyDiscovered ? 1 : 0,
    sessionId,
  );

  if (embedTokens > 0) {
    db.prepare(
      'INSERT INTO usage_log (session_id, kind, model, input_tokens, output_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(sessionId, 'embed', embedder.name, embedTokens, 0, Date.now());
  }

  const frontierSize = countFrontier(db, sessionId);
  const elapsedMs = Date.now() - started;
  emit({
    type: 'ready',
    pages: totals.pages,
    chunks: totals.chunks,
    elapsedMs,
    skipped,
    frontier: frontierSize,
  });

  return {
    pages: usable.length,
    chunks: chunksStored,
    totalPages: totals.pages,
    totalChunks: totals.chunks,
    elapsedMs,
    skipped,
    domain: summary.domain,
    embedTokens,
    frontier: frontierSize,
  };
}

/**
 * Whether there is enough here to chat with at all.
 *
 * The bar is readable content, not a page count. A single well-written landing
 * page is a perfectly good thing to answer questions from - that is now the
 * default crawl - so the old "at least 3 pages" rule would reject the common
 * case. What still has to be refused is a site with no readable text, because
 * a chatbot over an empty index is worse than an honest failure.
 */
function assertUsable(
  usableCount: number,
  emptyCount: number,
  readable: number,
  chunksStored: number,
): void {
  // Pages loaded but none of them carried text: it is being rendered in the
  // browser. True whether that is one landing page or twenty.
  if (usableCount === 0 && emptyCount > 0) {
    throw new IndexError(
      'SPA_DETECTED',
      'This site renders its text in the browser, so there is nothing for a crawler to read. A JavaScript-rendered site needs a different approach than this demo uses.',
    );
  }

  // Enough pages loaded for the ratio to mean something, and most came back empty.
  if (readable >= 3 && emptyCount / readable > 0.7) {
    throw new IndexError(
      'SPA_DETECTED',
      'Most of this site renders its text in the browser, so there is very little for a crawler to read. A JavaScript-rendered site needs a different approach than this demo uses.',
    );
  }

  if (usableCount === 0) {
    throw new IndexError(
      'TOO_SMALL',
      'No page at this address could be read. It may be blocking automated readers, or it may not serve HTML.',
    );
  }

  if (chunksStored === 0) {
    throw new IndexError(
      'TOO_SMALL',
      'The page loaded but carried no readable text, so there is nothing to answer questions from.',
    );
  }
}

/**
 * Replace this session's frontier with what the pass handed back, then drop
 * anything that has since been read. Without the second step a page would stay
 * listed as available forever and "read 5 more" would re-offer pages that are
 * already in the index.
 */
function saveFrontier(db: DB, sessionId: string, entries: FrontierEntry[]): void {
  const insert = db.prepare(
    `INSERT INTO frontier (session_id, url, score) VALUES (?, ?, ?)
     ON CONFLICT(session_id, url) DO UPDATE SET score = excluded.score`,
  );
  const forget = db.prepare(
    `DELETE FROM frontier
      WHERE session_id = ?
        AND url IN (SELECT url FROM pages WHERE session_id = ?)`,
  );
  const write = db.transaction((rows: FrontierEntry[]) => {
    for (const row of rows) insert.run(sessionId, row.url, Math.round(row.score));
    forget.run(sessionId, sessionId);
  });
  write(entries);
}

function countFrontier(db: DB, sessionId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM frontier WHERE session_id = ?')
    .get(sessionId) as { n: number }).n;
}

function wasDiscovered(db: DB, sessionId: string): boolean {
  const row = db.prepare('SELECT discovered AS d FROM sessions WHERE id = ?')
    .get(sessionId) as { d: number } | undefined;
  return (row?.d ?? 0) === 1;
}

function currentBudget(db: DB, sessionId: string): number {
  const row = db.prepare('SELECT page_budget AS b FROM sessions WHERE id = ?')
    .get(sessionId) as { b: number } | undefined;
  return row?.b ?? 0;
}

/**
 * Counted from the tables rather than accumulated in memory, so a session that
 * has been expanded three times still reports exactly what it holds.
 */
function sessionTotals(db: DB, sessionId: string): { pages: number; chunks: number } {
  const pages = (db.prepare(
    "SELECT COUNT(*) AS n FROM pages WHERE session_id = ? AND status = 'ok'",
  ).get(sessionId) as { n: number }).n;
  const chunks = (db.prepare(
    'SELECT COUNT(*) AS n FROM chunks WHERE session_id = ?',
  ).get(sessionId) as { n: number }).n;
  return { pages, chunks };
}
