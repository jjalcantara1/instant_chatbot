import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { toBlob, HashEmbedder, type Embedder, type EmbedResult } from '../src/indexing/embed.js';
import { buildCandidates, generateStarters, titleSubject } from '../src/retrieve/starters.js';
import { invalidateSession, retrieve } from '../src/retrieve/retrieve.js';
import { config } from '../src/config.js';

/**
 * The contract: every suggestion the app offers must be one the app can answer.
 * Offering a question and then refusing it is the demo's worst failure mode.
 */

const SID = 'starter-session-00001';
let db: DB;

/**
 * A stub whose geometry is controllable, so the gate can be steered.
 * Each text is embedded as a unit vector pointing at whichever topic axis its
 * keyword names; unknown text lands on its own orthogonal axis and therefore
 * has cosine 0 with everything.
 */
const AXES = ['pricing', 'hosting', 'thesis'] as const;

function axisVector(text: string): Float32Array {
  const v = new Float32Array(AXES.length + 1);
  const hit = AXES.findIndex((a) => text.toLowerCase().includes(a));
  if (hit === -1) v[AXES.length] = 1;
  else v[hit] = 1;
  return v;
}

const topicEmbedder: Embedder = {
  name: 'topic-stub',
  dims: AXES.length + 1,
  embed: (texts: string[]): Promise<EmbedResult> =>
    Promise.resolve({ vectors: texts.map(axisVector), tokens: texts.length }),
};

function addPage(url: string, title: string): number {
  return Number(db.prepare(
    "INSERT INTO pages (session_id, url, title, status, char_count) VALUES (?, ?, ?, 'ok', 500)",
  ).run(SID, url, title).lastInsertRowid);
}

function addChunk(pageId: number, headingPath: string, text: string): void {
  db.prepare(
    'INSERT INTO chunks (session_id, page_id, heading_path, text, tokens, embedding) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(SID, pageId, headingPath, text, 10, toBlob(axisVector(`${headingPath} ${text}`)));
}

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare(
    `INSERT INTO sessions (id, origin_url, domain, status, created_at, expires_at)
     VALUES (?, 'https://acme.test', 'acme.test', 'ready', ?, ?)`,
  ).run(SID, Date.now(), Date.now() + 86_400_000);
  invalidateSession(SID);
});

describe('titleSubject', () => {
  it('keeps the subject when the part before the colon cannot stand alone', () => {
    // The shipped bug: this used to yield "FAQ", which embeds to nothing and
    // got the suggestion deterministically refused.
    expect(titleSubject('FAQ: Custom Websites & AI Models in Pampanga | Kleio'))
      .toBe('FAQ: Custom Websites & AI Models in Pampanga');
  });

  it('still drops a descriptive tail when the lead stands on its own', () => {
    expect(titleSubject('Portfolio Website Design: our approach | Kleio'))
      .toBe('Portfolio Website Design');
  });

  it('drops the brand tail', () => {
    expect(titleSubject('Our Work — Kleio')).toBe('Our Work');
  });
});

describe('buildCandidates', () => {
  it('prefers question-shaped headings, then headings, then titles', () => {
    const p = addPage('https://acme.test/faq', 'FAQ: everything about pricing');
    addChunk(p, 'Pricing > How much does hosting cost?', 'Hosting costs a fixed monthly fee.');
    addChunk(p, 'Pricing > Payment terms and invoicing', 'We invoice monthly.');

    const texts = buildCandidates(db, SID).map((c) => c.text);
    expect(texts[0]).toBe('How much does hosting cost?');
    expect(texts).toContain('Tell me about Payment terms and invoicing');
    expect(texts.some((t) => t.startsWith('Tell me about FAQ:'))).toBe(true);
  });

  it('skips navigation furniture and one-word headings', () => {
    const p = addPage('https://acme.test/x', 'X');
    addChunk(p, 'Navigation menu links', 'Home About Contact');
    addChunk(p, 'Pricing', 'short');
    addChunk(p, 'Related articles you may like', 'more');

    const texts = buildCandidates(db, SID).map((c) => c.text);
    expect(texts.some((t) => /navigation/i.test(t))).toBe(false);
    expect(texts.some((t) => /related/i.test(t))).toBe(false);
    expect(texts).not.toContain('Tell me about Pricing');
  });
});

describe('generateStarters', () => {
  it('only returns questions that clear the retrieval gate', async () => {
    const p = addPage('https://acme.test/faq', 'Pricing questions');
    // Two chunks on the pricing axis: a pricing question can be answered.
    addChunk(p, 'Pricing > What does pricing look like?', 'pricing details one');
    addChunk(p, 'Pricing > How is pricing structured?', 'pricing details two');
    // One lone chunk on the thesis axis: a thesis question clears the floor
    // but finds only ONE chunk, so the >= 2 rule refuses it.
    addChunk(p, 'Thesis > Can you do a thesis project?', 'thesis details');

    const starters = await generateStarters(db, SID, topicEmbedder);
    expect(starters.length).toBeGreaterThan(0);

    // The decisive assertion: ask each suggestion for real and require an answer.
    for (const s of starters) {
      const result = await retrieve(db, SID, s.text, topicEmbedder);
      expect(result.insufficient, `refused its own suggestion: ${s.text}`).toBe(false);
    }

    // The single-chunk topic must not have been offered.
    expect(starters.some((s) => /thesis/i.test(s.text))).toBe(false);
  });

  it('returns nothing rather than something unanswerable', async () => {
    const p = addPage('https://acme.test/empty', 'Nothing in particular');
    // A heading on an axis with only one chunk, so nothing can pass the gate.
    addChunk(p, 'Hosting > Where is the site hosted?', 'hosting one');

    const starters = await generateStarters(db, SID, topicEmbedder);
    expect(starters).toEqual([]);
  });

  it('covers every page before offering a second question about one', async () => {
    for (const [slug, axis] of [['pricing', 'pricing'], ['hosting', 'hosting']] as const) {
      const p = addPage(`https://acme.test/${slug}`, `${slug} page`);
      addChunk(p, `${axis} > What about ${axis} terms here?`, `${axis} one`);
      addChunk(p, `${axis} > How does ${axis} work exactly?`, `${axis} two`);
    }

    const starters = await generateStarters(db, SID, topicEmbedder);
    // Two pages, three slots: the first two must be one per page, and the
    // third is allowed to double up rather than be dropped.
    expect(starters.length).toBe(3);
    expect(new Set(starters.slice(0, 2).map((s) => s.url)).size).toBe(2);
  });

  it('still fills all three slots on a landing-page-only index', async () => {
    // The default crawl reads one page. Spreading across pages must not
    // starve the common case down to a single suggestion.
    const p = addPage('https://acme.test/', 'Home');
    for (let i = 0; i < 5; i++) {
      addChunk(p, `Plans > What pricing is included at tier ${i}?`, `pricing body ${i}`);
    }
    const starters = await generateStarters(db, SID, topicEmbedder);
    expect(starters.length).toBe(3);
    expect(new Set(starters.map((s) => s.url))).toEqual(new Set(['https://acme.test/']));
  });

  it('rejects hero copy that happens to be marked up as a heading', async () => {
    const p = addPage('https://acme.test/', 'Home');
    addChunk(p, 'You imagine it. We build it for you.', 'pricing marketing body');
    addChunk(p, 'You imagine it.We build it for you.', 'pricing marketing body two');
    addChunk(p, 'Plans > What pricing is included in each plan?', 'pricing body');
    addChunk(p, 'Plans > How is pricing billed monthly?', 'pricing body two');

    const starters = await generateStarters(db, SID, topicEmbedder);
    expect(starters.some((s) => /imagine it/i.test(s.text))).toBe(false);
    expect(starters.length).toBeGreaterThan(0);
  });

  it('is empty for a session with no chunks', async () => {
    expect(await generateStarters(db, SID, new HashEmbedder())).toEqual([]);
  });

  it('never returns more than the UI shows', async () => {
    const p = addPage('https://acme.test/many', 'Many');
    for (let i = 0; i < 12; i++) {
      addChunk(p, `Pricing > Question number ${i} about pricing?`, `pricing body ${i}`);
    }
    const starters = await generateStarters(db, SID, topicEmbedder);
    expect(starters.length).toBeLessThanOrEqual(3);
  });
});

describe('the gate itself', () => {
  it('requires at least two surviving chunks, which is why verification exists', () => {
    // Documents the exact failure the probe found in production data: a
    // question can score a high cosine and still be refused for lack of a
    // second supporting chunk.
    expect(config.minChunksForAnswer).toBe(2);
  });
});
