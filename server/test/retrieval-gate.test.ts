import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { toBlob, type Embedder, type EmbedResult } from '../src/indexing/embed.js';
import { retrieve, invalidateSession, indexedWithAnotherModel } from '../src/retrieve/retrieve.js';
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
  /** Every request made, so tests can count round trips. */
  readonly requests: string[][] = [];
  constructor(private readonly map: Record<string, number[]>) {}
  async embed(texts: string[]): Promise<EmbedResult> {
    this.requests.push(texts);
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

function seedSessionAndPage(): number {
  db.prepare(
    `INSERT INTO sessions (id, origin_url, domain, status, created_at, expires_at)
     VALUES (?, 'https://acme.test', 'acme.test', 'ready', ?, ?)`,
  ).run(SID, Date.now(), Date.now() + 86_400_000);
  return Number(
    db.prepare(
      `INSERT INTO pages (session_id, url, title, status, char_count)
       VALUES (?, 'https://acme.test/billing', 'Billing', 'ok', 900)`,
    ).run(SID).lastInsertRowid,
  );
}

function addChunk(pageId: number, text: string, vector: number[]): void {
  db.prepare(
    `INSERT INTO chunks (session_id, page_id, heading_path, text, tokens, embedding)
     VALUES (?, ?, 'Billing', ?, 20, ?)`,
  ).run(SID, pageId, text, toBlob(unit(vector)));
}

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

  it('answers from a single chunk that clears the floor', async () => {
    // One close chunk, two orthogonal ones. A fact a page states once - an
    // email address, a call length - lives in exactly one chunk, and the old
    // two-chunk rule refused it every time.
    seed([[1, 0, 0, 0, 0, 0, 0, 0], [0, 1, 0, 0, 0, 0, 0, 0], [0, 0, 1, 0, 0, 0, 0, 0]]);
    const embedder = new ScriptedEmbedder({ kitchen: [1, 0, 0, 0, 0, 0, 0, 0] });
    const r = await retrieve(db, SID, 'kitchen', embedder);
    expect(r.insufficient).toBe(false);
    expect(r.chunks).toHaveLength(1);
    expect(r.chunks[0]?.text).toContain('kitchen extraction');
  });

  it('applies the floor before cutting to the top results, not after', async () => {
    // Six chunks share the query's words but not its meaning; one means the
    // same thing in different words. Fused, the six lexical matches outrank
    // it. Cutting to the top six first and flooring second threw all six away
    // and refused a question the seventh chunk answers.
    const pageId = seedSessionAndPage();
    const lexical = [0, 0, 0, 0, 0, 0, 1, 0];
    for (let i = 0; i < 6; i++) {
      addChunk(pageId, `Invoices are payable by invoice date, invoice number ${i}.`, lexical);
    }
    addChunk(pageId, 'Bills are settled at the end of every quarter.', [1, 0, 0, 0, 0, 0, 0, 0]);

    const embedder = new ScriptedEmbedder({ invoice: [1, 0, 0, 0, 0, 0, 0, 0] });
    const r = await retrieve(db, SID, 'when is an invoice due', embedder);
    expect(r.insufficient).toBe(false);
    expect(r.chunks.map((c) => c.text)).toEqual(['Bills are settled at the end of every quarter.']);
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

    // That the model is never consulted is proved below without depending on
    // the ambient environment: a real call cannot yield zero output tokens, and
    // a call made with an absent or rejected key would surface an error event.

    const events = [];
    for await (const e of streamAnswer({
      db, sessionId: SID, domain: 'acme.test',
      question: 'do you sell helicopter parts?',
      history: [], embedder,
    })) events.push(e);

    const text = events.filter((e) => e.type === 'token').map((e) => (e as { text: string }).text).join('');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(text).toContain("site doesn't cover that");

    const sources = events.find((e) => e.type === 'sources') as { sources: unknown[] } | undefined;
    expect(sources?.sources).toEqual([]);

    const done = events.find((e) => e.type === 'done') as { outputTokens: number } | undefined;
    expect(done?.outputTokens).toBe(0); // nothing was generated, so nothing was billed
  });

  it('suggests the session’s verified questions in the refusal, never page titles', async () => {
    seed([[1, 0, 0, 0, 0, 0, 0, 0], [0.9, 0.2, 0, 0, 0, 0, 0, 0], [0.8, 0.3, 0, 0, 0, 0, 0, 0]]);
    db.prepare('UPDATE sessions SET starters = ? WHERE id = ?').run(
      JSON.stringify([{ text: 'Tell me about kitchen extraction', url: 'https://acme.test/services' }]),
      SID,
    );
    const embedder = new ScriptedEmbedder({ helicopter: [0, 0, 0, 0, 1, 0, 0, 0] });
    let text = '';
    for await (const e of streamAnswer({
      db, sessionId: SID, domain: 'acme.test',
      question: 'helicopter parts', history: [], embedder,
    })) if (e.type === 'token') text += e.text;
    expect(text).toBe("The site doesn't cover that. You could ask “Tell me about kitchen extraction” instead.");
    expect(text).not.toContain('Services'); // the page title
  });
});

describe('follow-up questions', () => {
  it('searches a follow-up together with the question before it', async () => {
    seed([[1, 0, 0, 0, 0, 0, 0, 0], [0.9, 0.2, 0, 0, 0, 0, 0, 0], [0.8, 0.3, 0, 0, 0, 0, 0, 0]]);
    // "Who installs it?" names nothing on its own; the previous question does.
    const embedder = new ScriptedEmbedder({ kitchen: [1, 0, 0, 0, 0, 0, 0, 0] });

    const alone = await retrieve(db, SID, 'who installs it?', embedder);
    expect(alone.insufficient).toBe(true);

    const followUp = await retrieve(db, SID, 'who installs it?', embedder, 'tell me about kitchen extraction');
    expect(followUp.insufficient).toBe(false);
    expect(followUp.chunks[0]?.text).toContain('kitchen extraction');
  });

  it('still answers a change of subject from the question alone', async () => {
    seed([[1, 0, 0, 0, 0, 0, 0, 0], [0, 1, 0, 0, 0, 0, 0, 0], [0, 0, 1, 0, 0, 0, 0, 0]]);
    const embedder = new ScriptedEmbedder({
      kitchen: [1, 0, 0, 0, 0, 0, 0, 0],
      maintenance: [0, 0, 1, 0, 0, 0, 0, 0],
    });
    // Keyword lookup takes the first match, so the combined text resolves to
    // "kitchen" and only the standalone pass can find maintenance.
    const r = await retrieve(db, SID, 'what about maintenance?', embedder, 'tell me about kitchen extraction');
    expect(r.chunks.map((c) => c.text)).toContain('Maintenance contracts are billed quarterly and include callouts.');
  });

  it('ranks a chunk right for both searches above chunks only on the topic', async () => {
    // After "what does the steel classifier do?", "can I try it myself?" pulls
    // every section of the steel page. The chunk that answers - on the topic
    // AND about trying it - must beat sections that are only on the topic.
    const pageId = seedSessionAndPage();
    for (let i = 0; i < 7; i++) addChunk(pageId, `Section alpha number ${'x'.repeat(i + 1)}`, [1, 0, 0, 0, 0, 0, 0, 0]);
    addChunk(pageId, 'Deployed and public today.', [1, 1, 0, 0, 0, 0, 0, 0]);
    addChunk(pageId, 'Demos anyone may open.', [0, 1, 0, 0, 0, 0, 0, 0]);

    const embedder = new ScriptedEmbedder({ steel: [1, 0, 0, 0, 0, 0, 0, 0], try: [0, 1, 0, 0, 0, 0, 0, 0] });
    const r = await retrieve(db, SID, 'can I try it myself?', embedder, 'what does the steel classifier do?');
    expect(r.chunks[0]?.text).toBe('Deployed and public today.');
  });

  it('embeds both searches in one request', async () => {
    seed([[1, 0, 0, 0, 0, 0, 0, 0], [0.9, 0.2, 0, 0, 0, 0, 0, 0], [0.8, 0.3, 0, 0, 0, 0, 0, 0]]);
    const embedder = new ScriptedEmbedder({ kitchen: [1, 0, 0, 0, 0, 0, 0, 0] });
    await retrieve(db, SID, 'who installs it?', embedder, 'tell me about kitchen extraction');
    expect(embedder.requests).toHaveLength(1);
    expect(embedder.requests[0]).toEqual(['who installs it?', 'tell me about kitchen extraction who installs it?']);
  });
});

describe('sessions indexed by another model', () => {
  const embedderOf = (name: string, dims: number): Embedder => ({
    name, dims, embed: async () => ({ vectors: [], tokens: 0 }),
  });

  it('are recognised by the model a session recorded', () => {
    seed([[1, 0, 0, 0, 0, 0, 0, 0]]);
    db.prepare("UPDATE sessions SET embedding_model = 'voyage-3-lite' WHERE id = ?").run(SID);
    expect(indexedWithAnotherModel(db, SID, embedderOf('voyage-3-lite', 8))).toBe(false);
    expect(indexedWithAnotherModel(db, SID, embedderOf('Xenova/bge-small-en-v1.5', 8))).toBe(true);
  });

  it('are recognised by vector width when the session predates recording it', () => {
    seed([[1, 0, 0, 0, 0, 0, 0, 0]]); // 8-wide vectors, no model recorded
    expect(indexedWithAnotherModel(db, SID, embedderOf('anything', 8))).toBe(false);
    expect(indexedWithAnotherModel(db, SID, embedderOf('anything', 384))).toBe(true);
  });

  it('never flag a session with nothing in it', () => {
    seedSessionAndPage();
    expect(indexedWithAnotherModel(db, SID, embedderOf('anything', 384))).toBe(false);
  });
});

describe('query vectors', () => {
  it('embeds a repeated question once', async () => {
    // A suggested question is embedded while it is verified; clicking it
    // must not cost a second round trip.
    seed([[1, 0, 0, 0, 0, 0, 0, 0], [0.9, 0.2, 0, 0, 0, 0, 0, 0], [0.8, 0.3, 0, 0, 0, 0, 0, 0]]);
    const embedder = new ScriptedEmbedder({ kitchen: [1, 0, 0, 0, 0, 0, 0, 0] });
    await retrieve(db, SID, 'kitchen extraction', embedder);
    await retrieve(db, SID, 'kitchen extraction', embedder);
    expect(embedder.requests).toHaveLength(1);
  });
});
