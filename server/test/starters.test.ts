import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { toBlob, HashEmbedder, type Embedder, type EmbedResult } from '../src/indexing/embed.js';
import { buildCandidates, generateStarters, STARTER_MARGIN } from '../src/retrieve/starters.js';
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

const topicEmbedder = (): Embedder => ({
  name: 'topic-stub',
  dims: AXES.length + 1,
  embed: (texts: string[]): Promise<EmbedResult> =>
    Promise.resolve({ vectors: texts.map(axisVector), tokens: texts.length }),
});

function addPage(url: string, title: string): number {
  return Number(db.prepare(
    "INSERT INTO pages (session_id, url, title, status, char_count) VALUES (?, ?, ?, 'ok', 500)",
  ).run(SID, url, title).lastInsertRowid);
}

function addChunk(pageId: number, headingPath: string, text: string, headings?: string[], vector?: Float32Array): void {
  db.prepare(
    'INSERT INTO chunks (session_id, page_id, heading_path, text, tokens, embedding, headings) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    SID, pageId, headingPath, text, 10,
    toBlob(vector ?? axisVector(`${headingPath} ${text}`)),
    headings ? JSON.stringify(headings) : null,
  );
}

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare(
    `INSERT INTO sessions (id, origin_url, domain, status, created_at, expires_at)
     VALUES (?, 'https://acme.test', 'acme.test', 'ready', ?, ?)`,
  ).run(SID, Date.now(), Date.now() + 86_400_000);
  invalidateSession(SID);
});

describe('buildCandidates', () => {
  it('prefers question-shaped headings, then headings, and never offers page titles', () => {
    const p = addPage('https://acme.test/faq', 'FAQ: everything about pricing');
    addChunk(p, 'Pricing > How much does hosting cost?', 'Hosting costs a fixed monthly fee.');
    addChunk(p, 'Pricing > Payment terms and invoicing', 'We invoice monthly.');

    const texts = buildCandidates(db, SID).map((c) => c.text);
    expect(texts[0]).toBe('How much does hosting cost?');
    expect(texts).toContain('Tell me about Payment terms and invoicing');
    // Titles are SEO copy, and the one title-based suggestion measured on a
    // real site was refused by the model when clicked.
    expect(texts.some((t) => /FAQ/.test(t))).toBe(false);
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

  it('reads the headings of cards packed into one chunk', () => {
    // A services grid is packed into one chunk whose heading path is only the
    // grid's; the cards' own headings are what make good questions.
    const p = addPage('https://acme.test/', 'Home');
    addChunk(p, 'Studio > What we do', 'Portfolio Websites\nA site that wins clients.\nCustom AI Models\nTrained on your data.', [
      'Studio > What we do > Portfolio Websites',
      'Studio > What we do > Custom AI Models',
    ]);

    const texts = buildCandidates(db, SID).map((c) => c.text);
    expect(texts).toContain('Tell me about Portfolio Websites');
    expect(texts).toContain('Tell me about Custom AI Models');
  });

  it('turns contact calls to action into nothing', () => {
    const p = addPage('https://acme.test/', 'Home');
    addChunk(p, 'Contact > Start the conversation', 'Write to us and we reply within a day.');
    addChunk(p, 'Contact > Get in touch today', 'Our inbox is always open.');
    const texts = buildCandidates(db, SID).map((c) => c.text);
    expect(texts.some((t) => /conversation|get in touch today/i.test(t))).toBe(false);
  });
});

describe('generateStarters', () => {
  it('only returns questions the app answers when they are asked', async () => {
    const p = addPage('https://acme.test/faq', 'Pricing questions');
    addChunk(p, 'Pricing > What does pricing look like?', 'pricing details one');
    addChunk(p, 'Pricing > How is pricing structured?', 'pricing details two');
    addChunk(p, 'Thesis > Can you do a thesis project?', 'thesis details');
    // A heading whose question embeds to nothing the page holds.
    addChunk(p, 'Hosting > Where is the site hosted?', 'hosting one');

    const embedder = topicEmbedder();
    const starters = await generateStarters(db, SID, embedder);
    expect(starters.length).toBeGreaterThan(0);

    // The decisive assertion: ask each suggestion for real and require an answer.
    for (const s of starters) {
      const result = await retrieve(db, SID, s.text, embedder);
      expect(result.insufficient, `refused its own suggestion: ${s.text}`).toBe(false);
    }
    expect(starters.some((s) => /hosted/i.test(s.text))).toBe(false);
  });

  it('holds suggestions to a higher bar than answers', async () => {
    // The floor decides what the model may see. A suggestion should be
    // something the page plainly covers, so a question whose best chunk only
    // just clears the floor is answerable but not offered.
    const p = addPage('https://acme.test/', 'Home');
    const angle = Math.acos(config.minCosine + STARTER_MARGIN / 2);
    const weak = new Float32Array([Math.cos(angle), Math.sin(angle), 0, 0]);
    addChunk(p, 'Plans > What pricing is included?', 'body text', undefined, weak);

    const embedder = topicEmbedder();
    const asked = await retrieve(db, SID, 'What pricing is included?', embedder);
    expect(asked.insufficient).toBe(false);
    expect(await generateStarters(db, SID, embedder)).toEqual([]);
  });

  it('returns nothing rather than something unanswerable', async () => {
    const p = addPage('https://acme.test/empty', 'Nothing in particular');
    // The heading's question lands on no topic the page holds.
    addChunk(p, 'Hosting > Where is the site hosted?', 'hosting one');

    const starters = await generateStarters(db, SID, topicEmbedder());
    expect(starters).toEqual([]);
  });

  it('covers every page before offering a second question about one', async () => {
    for (const [slug, axis] of [['pricing', 'pricing'], ['hosting', 'hosting']] as const) {
      const p = addPage(`https://acme.test/${slug}`, `${slug} page`);
      addChunk(p, `${axis} > What about ${axis} terms here?`, `${axis} one`);
      addChunk(p, `${axis} > How does ${axis} work exactly?`, `${axis} two`);
    }

    const starters = await generateStarters(db, SID, topicEmbedder());
    // Two pages, three slots: the first two must be one per page, and the
    // third is allowed to double up rather than be dropped.
    expect(starters.length).toBe(3);
    expect(new Set(starters.slice(0, 2).map((s) => s.url)).size).toBe(2);
  });

  it('spreads a single page’s suggestions across its sections', async () => {
    // Three cards of one packed services grid tell a visitor less than one
    // question each about services, hosting and theses.
    const p = addPage('https://acme.test/', 'Home');
    addChunk(p, 'Services', 'pricing plans and pricing billing', [
      'Services > What pricing plans exist?',
      'Services > How is pricing billed?',
    ]);
    addChunk(p, 'Hosting > Where does hosting happen?', 'hosting details');
    addChunk(p, 'Thesis > Can you help with a thesis project?', 'thesis details');

    const texts = (await generateStarters(db, SID, topicEmbedder())).map((s) => s.text);
    expect(texts).toEqual([
      'What pricing plans exist?',
      'Where does hosting happen?',
      'Can you help with a thesis project?',
    ]);
  });

  it('still fills all three slots on a landing-page-only index', async () => {
    // The default crawl reads one page. Spreading across pages must not
    // starve the common case down to a single suggestion.
    const p = addPage('https://acme.test/', 'Home');
    for (let i = 0; i < 5; i++) {
      addChunk(p, `Plans > What pricing is included at tier ${i}?`, `pricing body ${i}`);
    }
    const starters = await generateStarters(db, SID, topicEmbedder());
    expect(starters.length).toBe(3);
    expect(new Set(starters.map((s) => s.url))).toEqual(new Set(['https://acme.test/']));
  });

  it('rejects hero copy that happens to be marked up as a heading', async () => {
    const p = addPage('https://acme.test/', 'Home');
    addChunk(p, 'You imagine it. We build it for you.', 'pricing marketing body');
    addChunk(p, 'You imagine it.We build it for you.', 'pricing marketing body two');
    addChunk(p, 'Plans > What pricing is included in each plan?', 'pricing body');
    addChunk(p, 'Plans > How is pricing billed monthly?', 'pricing body two');

    const starters = await generateStarters(db, SID, topicEmbedder());
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
    const starters = await generateStarters(db, SID, topicEmbedder());
    expect(starters.length).toBeLessThanOrEqual(3);
  });
});
