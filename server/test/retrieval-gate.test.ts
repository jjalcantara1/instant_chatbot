import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { toBlob, type Embedder, type EmbedResult } from '../src/indexing/embed.js';
import { retrieve, invalidateSession } from '../src/retrieve/retrieve.js';
import { streamAnswer } from '../src/chat/chat.js';
import { config } from '../src/config.js';

/**
 * Criterion 4 — "asking about something not on the site produces a clean
 * refusal rather than an invented answer" — is enforced in retrieval, not in
 * the prompt. That makes it deterministic and testable without a model.
 */

const DIMS = 8;

function unit(v: number[]): Float32Array {
  const len = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return new Float32Array(v.map((x) => (len > 0 ? x / len : 0)));
}

/** An embedder that returns whatever vector the test asks for, by keyword. */
class ScriptedEmbedder implements Embedder {
  readonly name = 'scripted';
  readonly dims = DIMS;
  constructor(private readonly map: Record<string, number[]>) {}
  async embed(texts: string[]): Promise<EmbedResult> {
    return {
      vectors: texts.map((t) => {
        for (const [key, vec] of Object.entries(this.map)) {
          if (t.toLowerCase().includes(key)) return unit(vec);
        }
        return unit(new Array<number>(DIMS).fill(0).map((_, i) => (i === DIMS - 1 ? 1 : 0)));
      }),
      tokens: 1,
    };
  }
}

let db: DB;
const SID = 'test-session-000000000';

function seed(chunkVectors: number[][]): void {
  db.prepare(
    `INSERT INTO sessions (id, origin_url, domain, status, created_at, expires_at)
     VALUES (?, 'https://acme.test', 'acme.test', 'ready', ?, ?)`,
  ).run(SID, Date.now(), Date.now() + 86_400_000);

  const pageId = Number(
    db.prepare(
      `INSERT INTO pages (session_id, url, title, status, char_count)
       VALUES (?, 'https://acme.test/services', 'Services', 'ok', 900)`,
    ).run(SID).lastInsertRowid,
  );

  const texts = [
    'We install commercial kitchen extraction systems across the region.',
    'Our fitout team handles retail interiors from design through handover.',
    'Maintenance contracts are billed quarterly and include callouts.',
  ];

  chunkVectors.forEach((v, i) => {
    db.prepare(
      `INSERT INTO chunks (session_id, page_id, heading_path, text, tokens, embedding)
       VALUES (?, ?, 'Services', ?, 20, ?)`,
    ).run(SID, pageId, texts[i] ?? `filler chunk ${i}`, toBlob(unit(v)));
  });
}

beforeEach(() => {
  db = openDb(':memory:');
  invalidateSession(SID);
});

describe('retrieval similarity floor', () => {
  it('returns chunks when the query is genuinely close to the corpus', async () => {
    seed([[1, 0, 0, 0, 0, 0, 0, 0], [0.9, 0.2, 0, 0, 0, 0, 0, 0], [0.8, 0.3, 0, 0, 0, 0, 0, 0]]);
    const embedder = new ScriptedEmbedder({ kitchen: [1, 0.1, 0, 0, 0, 0, 0, 0] });
    const r = await retrieve(db, SID, 'kitchen extraction', embedder);
    expect(r.insufficient).toBe(false);
    expect(r.chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of r.chunks) expect(c.cosine).toBeGreaterThanOrEqual(config.minCosine);
  });

  it('reports insufficient when nothing clears the cosine floor', async () => {
    seed([[1, 0, 0, 0, 0, 0, 0, 0], [0.9, 0.2, 0, 0, 0, 0, 0, 0], [0.8, 0.3, 0, 0, 0, 0, 0, 0]]);
    // Orthogonal to every stored vector: cosine 0 across the board.
    const embedder = new ScriptedEmbedder({ tax: [0, 0, 1, 0, 0, 0, 0, 0] });
    const r = await retrieve(db, SID, 'what is your tax policy', embedder);
    expect(r.insufficient).toBe(true);
    expect(r.chunks).toHaveLength(0);
  });

  it('reports insufficient when only one chunk clears the floor', async () => {
    // One close chunk, two orthogonal ones.
    seed([[1, 0, 0, 0, 0, 0, 0, 0], [0, 1, 0, 0, 0, 0, 0, 0], [0, 0, 1, 0, 0, 0, 0, 0]]);
    const embedder = new ScriptedEmbedder({ kitchen: [1, 0, 0, 0, 0, 0, 0, 0] });
    const r = await retrieve(db, SID, 'kitchen', embedder);
    expect(r.insufficient).toBe(true);
    expect(r.chunks.length).toBeLessThan(config.minChunksForAnswer);
  });

  it('drops a chunk BM25 liked but the vectors did not', async () => {
    // The third chunk shares the query word "quarterly" but is orthogonal, so
    // lexical rank alone would surface it. The floor must remove it.
    seed([[1, 0, 0, 0, 0, 0, 0, 0], [0.95, 0.1, 0, 0, 0, 0, 0, 0], [0, 0, 0, 1, 0, 0, 0, 0]]);
    const embedder = new ScriptedEmbedder({ quarterly: [1, 0.05, 0, 0, 0, 0, 0, 0] });
    const r = await retrieve(db, SID, 'quarterly billing', embedder);
    const kept = r.chunks.map((c) => c.text);
    expect(kept.some((t) => t.includes('Maintenance contracts'))).toBe(false);
  });
});

describe('chat refusal', () => {
  it('refuses without ever calling the model when retrieval is insufficient', async () => {
    seed([[1, 0, 0, 0, 0, 0, 0, 0], [0.9, 0.2, 0, 0, 0, 0, 0, 0], [0.8, 0.3, 0, 0, 0, 0, 0, 0]]);
    const embedder = new ScriptedEmbedder({ helicopter: [0, 0, 0, 0, 1, 0, 0, 0] });

    // No ANTHROPIC_API_KEY is configured in the test environment. If this path
    // touched the model at all it would throw rather than answer, so a clean
    // refusal here proves the model is never consulted.
    expect(config.anthropicApiKey).toBe('');

    const events = [];
    for await (const e of streamAnswer({
      db, sessionId: SID, domain: 'acme.test',
      question: 'do you sell helicopter parts?',
      history: [], embedder,
    })) events.push(e);

    const text = events.filter((e) => e.type === 'token').map((e) => (e as { text: string }).text).join('');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(text).toContain('could not find anything about that on acme.test');

    const sources = events.find((e) => e.type === 'sources') as { sources: unknown[] } | undefined;
    expect(sources?.sources).toEqual([]);

    const done = events.find((e) => e.type === 'done') as { outputTokens: number } | undefined;
    expect(done?.outputTokens).toBe(0); // nothing was generated, so nothing was billed
  });

  it('suggests real pages from the site in the refusal', async () => {
    seed([[1, 0, 0, 0, 0, 0, 0, 0], [0.9, 0.2, 0, 0, 0, 0, 0, 0], [0.8, 0.3, 0, 0, 0, 0, 0, 0]]);
    const embedder = new ScriptedEmbedder({ helicopter: [0, 0, 0, 0, 1, 0, 0, 0] });
    let text = '';
    for await (const e of streamAnswer({
      db, sessionId: SID, domain: 'acme.test',
      question: 'helicopter parts', history: [], embedder,
    })) if (e.type === 'token') text += e.text;
    expect(text).toContain('Services'); // the real indexed page title
  });
});
