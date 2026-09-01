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

vi.mock('../src/crawl/crawler.js', () => ({
  crawl: vi.fn(async (_url: string, handlers: {
    onPage?: (p: CrawledPage) => void | Promise<void>;
    onStage?: (s: string) => void;
  }) => {
    handlers.onStage?.('crawling');
    for (const p of scripted.pages) await handlers.onPage?.(p);
    return scripted;
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
  return { pages, domain: 'acme.test', elapsedMs: 500, hitPageCap: false, hitDeadline: false, robotsLoaded: true, sitemapCount: 0 };
}

let db: DB;
const SID = 'err-session-0000000000';

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare(
    `INSERT INTO sessions (id, origin_url, domain, status, created_at, expires_at)
     VALUES (?, 'https://acme.test', 'acme.test', 'crawling', ?, ?)`,
  ).run(SID, Date.now(), Date.now() + 86_400_000);
});

const run = () => runIndex({
  db, sessionId: SID, url: 'https://acme.test',
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

  it('TOO_SMALL when fewer than three pages are usable', async () => {
    scripted = summary([
      page({ url: 'https://acme.test/a' }),
      page({ url: 'https://acme.test/b' }),
      page({ url: 'https://acme.test/c', status: 'error', charCount: 0, text: '', sections: [] }),
    ]);
    await run().catch((e: InstanceType<typeof IndexError>) => {
      expect(e.code).toBe('TOO_SMALL');
      expect(e.message).toMatch(/2 readable pages/);
      expect(e.message).toMatch(/at least 3/);
    });
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

  it('an empty-heavy site is not flagged as an SPA when few pages were read', async () => {
    // Two pages, one empty. Not enough signal to claim the site is JS-rendered;
    // it should fail as TOO_SMALL instead, which is the accurate reason.
    scripted = summary([
      page({ url: 'https://acme.test/a' }),
      page({ url: 'https://acme.test/b', status: 'empty', charCount: 10, text: '', sections: [] }),
    ]);
    await run().catch((e: InstanceType<typeof IndexError>) => {
      expect(e.code).toBe('TOO_SMALL');
    });
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
