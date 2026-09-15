import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb, sweepExpired, type DB } from '../src/db.js';
import { toBlob } from '../src/indexing/embed.js';
import type { CrawledPage, CrawlSummary } from '../src/crawl/crawler.js';

/**
 * Failure paths that need a deterministic crawl. Every visitor-facing message
 * is asserted to be specific: it must say what happened, and none of them may
 * fall back to generic "something went wrong" text.
 */

let scripted: CrawlSummary;
/** What the scripted crawl claims it discovered but did not read. */
let scriptedFrontier: Array<{ url: string; score: number }> = [];

vi.mock('../src/crawl/crawler.js', () => ({
  crawl: vi.fn(async (_url: string, handlers: {
    onPage?: (p: CrawledPage) => void | Promise<void>;
    onStage?: (s: string) => void;
  }) => {
    handlers.onStage?.('crawling');
    for (const p of scripted.pages) await handlers.onPage?.(p);
    return { ...scripted, frontier: scriptedFrontier };
  }),
}));

const { runIndex, IndexError } = await import('../src/indexing/pipeline.js');
const { HashEmbedder } = await import('../src/indexing/embed.js');

function page(over: Partial<CrawledPage>): CrawledPage {
  return {
    url: 'https://acme.test/x', title: 'X', status: 'ok', charCount: 900,
    text: 'Some readable text about the services this company provides to customers.',
    sections: [{ headingPath: 'Services', text: 'Some readable text about the services this company provides to customers, at length and in detail.' }],
    ...over,
  };
}

function summary(pages: CrawledPage[]): CrawlSummary {
  return {
    pages, domain: 'acme.test', rootUrl: 'https://acme.test', elapsedMs: 500,
    hitPageCap: false, hitDeadline: false, robotsLoaded: true,
    sitemapCount: 0, sitemapUsed: false, frontier: [],
  };
}

let db: DB;
const SID = 'err-session-0000000000';

beforeEach(() => {
  scriptedFrontier = [];
  db = openDb(':memory:');
  db.prepare(
    `INSERT INTO sessions (id, origin_url, domain, status, created_at, expires_at)
     VALUES (?, 'https://acme.test', 'acme.test', 'crawling', ?, ?)`,
  ).run(SID, Date.now(), Date.now() + 86_400_000);
});

const run = (maxPages = 25) => runIndex({
  db, sessionId: SID, url: 'https://acme.test', maxPages,
  emit: () => {}, embedder: new HashEmbedder(),
});

describe('index failure codes', () => {
  it('SPA_DETECTED when most pages have no readable text', async () => {
    scripted = summary([
      page({ url: 'https://acme.test/a', status: 'empty', charCount: 20, text: '', sections: [] }),
      page({ url: 'https://acme.test/b', status: 'empty', charCount: 12, text: '', sections: [] }),
      page({ url: 'https://acme.test/c', status: 'empty', charCount: 30, text: '', sections: [] }),
      page({ url: 'https://acme.test/d', status: 'empty', charCount: 18, text: '', sections: [] }),
      page({ url: 'https://acme.test/e' }),
    ]);
    await expect(run()).rejects.toThrow(IndexError);
    await run().catch((e: InstanceType<typeof IndexError>) => {
      expect(e.code).toBe('SPA_DETECTED');
      expect(e.message).toMatch(/renders its text in the browser/i);
      expect(e.message).not.toMatch(/something went wrong/i);
    });
  });

  it('SPA_DETECTED when the only page read carried no text', async () => {
    // The default crawl reads one page. If that page is empty the diagnosis is
    // the same as for a whole empty site, and saying "too small" would blame
    // the visitor's site for a rendering mismatch.
    scripted = summary([
      page({ url: 'https://acme.test', status: 'empty', charCount: 14, text: '', sections: [] }),
    ]);
    await run(1).catch((e: InstanceType<typeof IndexError>) => {
      expect(e.code).toBe('SPA_DETECTED');
      expect(e.message).toMatch(/renders its text in the browser/i);
    });
  });

  it('TOO_SMALL when no page could be read at all', async () => {
    scripted = summary([
      page({ url: 'https://acme.test', status: 'error', charCount: 0, text: '', sections: [] }),
    ]);
    await run(1).catch((e: InstanceType<typeof IndexError>) => {
      expect(e.code).toBe('TOO_SMALL');
      expect(e.message).toMatch(/no page at this address could be read/i);
      expect(e.message).not.toMatch(/something went wrong/i);
    });
  });

  it('a single readable landing page is a complete index', async () => {
    // The whole point of the one-page default: this must succeed, where the
    // old three-page minimum would have rejected it.
    scripted = summary([page({ url: 'https://acme.test' })]);
    const r = await run(1);
    expect(r.pages).toBe(1);
    expect(r.totalPages).toBe(1);
    expect(r.chunks).toBeGreaterThan(0);
  });

  it('succeeds on a site that is merely small but usable', async () => {
    scripted = summary([
      page({ url: 'https://acme.test/a' }),
      page({ url: 'https://acme.test/b' }),
      page({ url: 'https://acme.test/c' }),
    ]);
    const r = await run();
    expect(r.pages).toBe(3);
    expect(r.chunks).toBeGreaterThan(0);
  });

  it('one empty page among readable ones is not an SPA', async () => {
    scripted = summary([
      page({ url: 'https://acme.test/a' }),
      page({ url: 'https://acme.test/b', status: 'empty', charCount: 10, text: '', sections: [] }),
    ]);
    const r = await run();
    expect(r.pages).toBe(1);
    expect(r.skipped).toBe(1);
  });
});

describe('frontier', () => {
  it('stores what the crawl discovered but did not read', async () => {
    scripted = summary([page({ url: 'https://acme.test' })]);
    scriptedFrontier = [
      { url: 'https://acme.test/about', score: 90 },
      { url: 'https://acme.test/pricing', score: 90 },
    ];

    const r = await run(1);

    expect(r.frontier).toBe(2);
    const rows = db.prepare('SELECT url FROM frontier WHERE session_id = ? ORDER BY url')
      .all(SID) as Array<{ url: string }>;
    expect(rows.map((x) => x.url)).toEqual(['https://acme.test/about', 'https://acme.test/pricing']);
  });

  it('drops frontier entries once the page behind them has been read', async () => {
    scripted = summary([page({ url: 'https://acme.test' })]);
    scriptedFrontier = [{ url: 'https://acme.test/about', score: 90 }];
    await run(1);

    // A second pass reads /about. It must not stay listed as still available.
    scripted = summary([page({ url: 'https://acme.test/about' })]);
    scriptedFrontier = [{ url: 'https://acme.test/contact', score: 90 }];
    const r = await runIndex({
      db, sessionId: SID, url: 'https://acme.test', maxPages: 5, mode: 'expand',
      emit: () => {}, embedder: new HashEmbedder(),
    });

    expect(r.pages).toBe(1);
    // Counted from the tables, so it spans both passes.
    expect(r.totalPages).toBe(2);
    const rows = db.prepare('SELECT url FROM frontier WHERE session_id = ?')
      .all(SID) as Array<{ url: string }>;
    expect(rows.map((x) => x.url)).toEqual(['https://acme.test/contact']);
  });

  it('an expansion that finds nothing leaves the session intact', async () => {
    scripted = summary([page({ url: 'https://acme.test' })]);
    await run(1);

    scripted = summary([
      page({ url: 'https://acme.test/x', status: 'error', charCount: 0, text: '', sections: [] }),
    ]);
    const r = await runIndex({
      db, sessionId: SID, url: 'https://acme.test', maxPages: 5, mode: 'expand',
      emit: () => {}, embedder: new HashEmbedder(),
    });

    expect(r.pages).toBe(0);
    expect(r.totalPages).toBe(1);
    const row = db.prepare('SELECT status, page_count FROM sessions WHERE id = ?')
      .get(SID) as { status: string; page_count: number };
    expect(row.status).toBe('ready');
    expect(row.page_count).toBe(1);
  });
});

describe('expiry sweep', () => {
  it('deletes expired sessions and cascades to pages, chunks and messages', () => {
    const fresh = openDb(':memory:');
    const mk = (id: string, expiresAt: number): void => {
      fresh.prepare(
        `INSERT INTO sessions (id, origin_url, domain, status, created_at, expires_at)
         VALUES (?, 'https://x.test', 'x.test', 'ready', ?, ?)`,
      ).run(id, Date.now() - 1000, expiresAt);
      const pid = Number(fresh.prepare(
        `INSERT INTO pages (session_id, url, title, status, char_count)
         VALUES (?, 'https://x.test/p', 'P', 'ok', 500)`,
      ).run(id).lastInsertRowid);
      fresh.prepare(
        `INSERT INTO chunks (session_id, page_id, heading_path, text, tokens, embedding)
         VALUES (?, ?, 'H', 'text', 5, ?)`,
      ).run(id, pid, toBlob(new Float32Array([1, 0])));
      fresh.prepare(
        `INSERT INTO messages (session_id, role, content, created_at) VALUES (?, 'user', 'hi', ?)`,
      ).run(id, Date.now());
    };

    mk('expired-session-00001', Date.now() - 60_000);
    mk('live-session-0000001', Date.now() + 60_000);

    const count = (t: string): number =>
      (fresh.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

    expect(count('sessions')).toBe(2);
    expect(count('chunks')).toBe(2);

    const removed = sweepExpired(fresh);

    expect(removed).toBe(1);
    expect(count('sessions')).toBe(1);
    expect(count('pages')).toBe(1);
    expect(count('chunks')).toBe(1);
    expect(count('messages')).toBe(1);

    const left = fresh.prepare('SELECT id FROM sessions').get() as { id: string };
    expect(left.id).toBe('live-session-0000001');
    fresh.close();
  });
});
