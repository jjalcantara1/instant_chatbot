import { config } from '../config.js';
import { crawl, type CrawledPage } from '../crawl/crawler.js';
import { findBoilerplateLines, stripBoilerplate } from './boilerplate.js';
import { chunkPage, type Chunk } from './chunk.js';
import { embedBatched, getEmbedder, toBlob, type Embedder } from './embed.js';
import type { DB } from '../db.js';

export type IndexEvent =
  | { type: 'stage'; stage: string }
  | { type: 'page'; url: string; title: string; status: string; charCount: number }
  | { type: 'progress'; pagesFetched: number; pagesQueued: number; chunks: number; embedded: number; stage: string }
  | { type: 'ready'; pages: number; chunks: number; elapsedMs: number; skipped: number }
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
  pages: number;
  chunks: number;
  elapsedMs: number;
  skipped: number;
  domain: string;
  embedTokens: number;
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
  maxPages?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function runIndex(opts: RunIndexOptions): Promise<IndexResult> {
  const { db, sessionId, url, emit } = opts;
  const embedder = opts.embedder ?? getEmbedder();
  const started = Date.now();

  const insertPage = db.prepare(
    'INSERT INTO pages (session_id, url, title, status, char_count) VALUES (?, ?, ?, ?, ?)',
  );
  const insertChunk = db.prepare(
    'INSERT INTO chunks (session_id, page_id, heading_path, text, tokens, embedding) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const updateSession = db.prepare(
    'UPDATE sessions SET status = ?, page_count = ?, chunk_count = ? WHERE id = ?',
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
      maxPages: opts.maxPages ?? config.maxPages,
      timeoutMs: opts.timeoutMs ?? config.crawlTimeoutMs,
      signal: opts.signal,
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

  // A site that renders its text in the browser gives us a page count with no
  // content. Serving a chatbot over that is worse than saying what happened.
  const readable = usable.length + emptyCount;
  const emptyRatio = readable > 0 ? emptyCount / readable : 0;
  if (readable >= 3 && emptyRatio > 0.7) {
    throw new IndexError(
      'SPA_DETECTED',
      'This site renders its text in the browser, so there is nothing for a crawler to read. A JavaScript-rendered site needs a different approach than this demo uses.',
    );
  }

  if (usable.length < 3) {
    throw new IndexError(
      'TOO_SMALL',
      `Only ${usable.length} readable page${usable.length === 1 ? '' : 's'} could be indexed, which is not enough to chat with. This demo needs at least 3.`,
    );
  }

  if (chunksStored === 0) {
    throw new IndexError('TOO_SMALL', 'No readable text was found on this site.');
  }

  updateSession.run('ready', usable.length, chunksStored, sessionId);

  db.prepare(
    'INSERT INTO usage_log (session_id, kind, model, input_tokens, output_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(sessionId, 'embed', embedder.name, embedTokens, 0, Date.now());

  const elapsedMs = Date.now() - started;
  emit({ type: 'ready', pages: usable.length, chunks: chunksStored, elapsedMs, skipped });

  return {
    pages: usable.length,
    chunks: chunksStored,
    elapsedMs,
    skipped,
    domain: summary.domain,
    embedTokens,
  };
}
