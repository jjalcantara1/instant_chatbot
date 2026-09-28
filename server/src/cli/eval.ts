/**
 * The honesty and answer-quality gate.
 *   npm run eval -- [--fixture eval/fixtures/kleiosoftware.json] [--pages N]
 *                   [--reuse SESSION_ID] [--db PATH] [--pace MS]
 *
 * Fluent hallucination on a visitor's own website is the failure that kills
 * this demo's purpose, so the set that matters most is the unanswerable one:
 * every absent question must be refused. That is judged structurally rather
 * than by reading the prose. A refusal is a turn that cites no page, because a
 * cited page is the model claiming the site says something.
 *
 * Answerable questions must be answered with a citation, and where the fixture
 * gives an `expect` pattern the reply has to contain it. A cited answer that
 * talks around the fact is not a pass.
 *
 * Follow-ups (`prev`) are asked the way a visitor asks them: the previous
 * question is answered first and that exchange is sent as history.
 *
 * Every question's embedding is fetched in ONE request up front. On a
 * rate-limited key round trips are the scarce resource, and paying one per
 * question turns a two-minute run into a twenty-minute one. A provider error
 * is reported as an error, never scored as a refusal: counting a 429 on an
 * absent question as "refused" would pass the gate for the wrong reason.
 *
 * Requires real embeddings and a real chat model. The similarity floor is
 * calibrated against real vector geometry; the offline hash embedder cannot
 * stand in for it, and the run refuses to pretend otherwise.
 */
import { readFileSync } from 'node:fs';
import { customAlphabet } from 'nanoid';
import { openDb } from '../db.js';
import { runIndex, settleStarters } from '../indexing/pipeline.js';
import { closeFetcher } from '../crawl/fetcher.js';
import { followUpQuery, retrieve } from '../retrieve/retrieve.js';
import { streamAnswer } from '../chat/chat.js';
import type { ChatTurn } from '../chat/providers.js';
import { getEmbedder, resolveEmbedding, type Embedder, type EmbedKind, type EmbedResult } from '../indexing/embed.js';
import { clampPages, config, resolveChat } from '../config.js';

const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 22);

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

interface FixtureQuestion {
  q: string;
  answerable: boolean;
  /** Case-insensitive pattern the answer must contain to count as correct. */
  expect?: string;
  /** The question asked just before this one, for follow-ups. */
  prev?: string;
}

interface Fixture {
  site: string;
  /** Pages to index. The product default is 1; a diagnostic run wants more. */
  pages?: number;
  questions: FixtureQuestion[];
}

const fixturePath = flag('fixture') ?? 'eval/fixtures/kleiosoftware.json';
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;
const dbPath = flag('db') ?? './data/eval.db';
const pages = clampPages(flag('pages') ?? fixture.pages ?? config.maxPages);
const paceMs = Number(flag('pace') ?? 0);

const embeddingProvider = resolveEmbedding().provider;
if (embeddingProvider === 'hash') {
  console.error('This eval needs real embeddings. The hash embedder cannot calibrate the similarity floor.');
  process.exit(2);
}
const embeddingKey: Record<string, string> = {
  openai: config.openaiApiKey, voyage: config.voyageApiKey, gemini: config.geminiApiKey,
};
if (embeddingProvider !== 'local' && !embeddingKey[embeddingProvider]) {
  console.error(`The ${embeddingProvider} embedding key is not set; the eval cannot run.`);
  process.exit(2);
}
const chat = resolveChat();
if (!(chat.provider === 'gemini' ? config.geminiApiKey : config.anthropicApiKey)) {
  console.error(`The ${chat.provider} chat key is not set; the eval cannot run.`);
  process.exit(2);
}

/**
 * Serves query vectors from a cache filled by one up-front request, and embeds
 * anything it has not seen on demand. Retrieval asks for the same texts the
 * prefetch did, so a normal run costs a single query-embedding round trip.
 */
class PrefetchingEmbedder implements Embedder {
  readonly name: string;
  readonly dims: number;
  private readonly cache = new Map<string, Float32Array>();

  constructor(private readonly inner: Embedder) {
    this.name = inner.name;
    this.dims = inner.dims;
  }

  async embed(texts: string[], kind: EmbedKind = 'document'): Promise<EmbedResult> {
    const key = (t: string): string => `${kind}\u0000${t}`;
    const missing = [...new Set(texts.filter((t) => !this.cache.has(key(t))))];
    let tokens = 0;
    if (missing.length > 0) {
      const res = await this.inner.embed(missing, kind);
      missing.forEach((t, i) => this.cache.set(key(t), res.vectors[i] as Float32Array));
      tokens = res.tokens;
    }
    return { vectors: texts.map((t) => this.cache.get(key(t)) as Float32Array), tokens };
  }
}

const db = openDb(dbPath);
const embedder = new PrefetchingEmbedder(getEmbedder());

console.log(`fixture   ${fixturePath}`);
console.log(`chat      ${chat.provider}/${chat.model}`);
console.log(`embedder  ${embeddingProvider}/${embedder.name}   floor ${config.minCosine}, ${config.minChunksForAnswer} chunk(s)\n`);

let sessionId = flag('reuse');
let domain = '';

if (sessionId) {
  const row = db.prepare('SELECT domain, page_count, chunk_count FROM sessions WHERE id = ?').get(sessionId) as
    | { domain: string; page_count: number; chunk_count: number } | undefined;
  if (!row) { console.error(`No session ${sessionId} in ${dbPath}`); process.exit(2); }
  domain = row.domain;
  console.log(`reusing session ${sessionId} (${domain}, ${row.page_count} pages, ${row.chunk_count} chunks)\n`);
} else {
  sessionId = nanoid();
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, origin_url, domain, status, created_at, expires_at)
     VALUES (?, ?, ?, 'crawling', ?, ?)`,
  ).run(sessionId, fixture.site, new URL(fixture.site).hostname, now, now + config.sessionTtlMs);

  process.stdout.write(`indexing ${fixture.site} (up to ${pages} page${pages === 1 ? '' : 's'}) ... `);
  const result = await runIndex({ db, sessionId, url: fixture.site, maxPages: pages, embedder, emit: () => {} });
  domain = result.domain;
  console.log(`${result.totalPages} pages, ${result.totalChunks} chunks, ${result.elapsedMs}ms`);
  console.log(`session ${sessionId}  (reuse with --reuse ${sessionId})\n`);
}

// Everything retrieval will ask to embed, in one request.
const queryTexts = new Set<string>();
for (const item of fixture.questions) {
  queryTexts.add(item.q);
  if (item.prev) {
    queryTexts.add(item.prev);
    queryTexts.add(followUpQuery(item.prev, item.q));
  }
}
await embedder.embed([...queryTexts], 'query');

interface Row {
  item: FixtureQuestion;
  outcome: 'PASS' | 'FAIL' | 'ERROR';
  refused: boolean;
  sources: number;
  topCosine: number;
  insufficient: boolean;
  answer: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const RATE_LIMIT = /429|rate limit|quota|RESOURCE_EXHAUSTED/i;
let lastAsk = 0;

/** One answer through the real chat path. Retries once on a provider rate limit. */
async function ask(question: string, history: ChatTurn[]): Promise<{ answer: string; sources: number; error?: string }> {
  for (let attempt = 0; ; attempt++) {
    const wait = lastAsk + paceMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastAsk = Date.now();

    let answer = '';
    let sources = 0;
    let error: string | undefined;
    for await (const e of streamAnswer({ db, sessionId: sessionId as string, domain, question, history, embedder })) {
      if (e.type === 'token') answer += e.text;
      else if (e.type === 'sources') sources = e.sources.length;
      else if (e.type === 'error') error = e.message;
    }
    if (error && attempt === 0 && RATE_LIMIT.test(error)) {
      await sleep(30_000);
      continue;
    }
    return { answer: answer.trim(), sources, ...(error ? { error } : {}) };
  }
}

const rows: Row[] = [];

for (const item of fixture.questions) {
  let history: ChatTurn[] = [];
  let setupError: string | undefined;
  if (item.prev) {
    const first = await ask(item.prev, []);
    setupError = first.error;
    history = [{ role: 'user', content: item.prev }, { role: 'assistant', content: first.answer }];
  }

  const probe = await retrieve(db, sessionId, item.q, embedder, item.prev);
  const topCosine = probe.chunks.length > 0 ? Math.max(...probe.chunks.map((c) => c.cosine)) : 0;
  const r = setupError ? { answer: '', sources: 0, error: `while answering the previous question: ${setupError}` } : await ask(item.q, history);

  const refused = r.sources === 0;
  const matches = item.expect ? new RegExp(item.expect, 'i').test(r.answer) : true;
  const outcome: Row['outcome'] = r.error ? 'ERROR' : item.answerable ? (!refused && matches ? 'PASS' : 'FAIL') : (refused ? 'PASS' : 'FAIL');

  rows.push({
    item, outcome, refused, sources: r.sources, topCosine, insufficient: probe.insufficient,
    answer: r.error ? `[error] ${r.error}` : r.answer,
  });
  process.stdout.write(outcome === 'PASS' ? '.' : outcome === 'FAIL' ? 'F' : 'E');
}

console.log('\n');

const answerable = rows.filter((r) => r.item.answerable);
const absent = rows.filter((r) => !r.item.answerable);

const show = (label: string, set: Row[]): void => {
  console.log(`\n${label}`);
  console.log('-'.repeat(96));
  for (const r of set) {
    const flags = `cos=${r.topCosine.toFixed(3)} src=${r.sources}${r.insufficient ? ' [floor]' : ''}`;
    const q = r.item.prev ? `(after "${r.item.prev}") ${r.item.q}` : r.item.q;
    console.log(`${r.outcome.padEnd(5)} ${flags}  ${q}`);
    console.log(`      ${r.answer.replace(/\n/g, ' ').slice(0, 160)}`);
  }
};

show('ANSWERABLE — must produce a cited answer containing the expected fact', answerable);
show('ABSENT — must refuse', absent);

const count = (set: Row[], o: Row['outcome']): number => set.filter((r) => r.outcome === o).length;
const errors = count(rows, 'ERROR');

console.log('\n' + '='.repeat(96));
console.log(`answerable  ${count(answerable, 'PASS')}/${answerable.length} answered correctly with sources`);
console.log(`absent      ${count(absent, 'PASS')}/${absent.length} refused`);
if (errors > 0) console.log(`errors      ${errors} (provider errors, not scored either way)`);

const cosAnswerable = answerable.map((r) => r.topCosine).sort((a, b) => a - b);
const cosAbsent = absent.map((r) => r.topCosine).sort((a, b) => a - b);
console.log(`\nfloor calibration (currently ${config.minCosine}, ${config.minChunksForAnswer} chunk(s)):`);
console.log(`  answerable top-cosine  min ${cosAnswerable[0]?.toFixed(3)}  max ${cosAnswerable[cosAnswerable.length - 1]?.toFixed(3)}`);
console.log(`  absent     top-cosine  min ${cosAbsent[0]?.toFixed(3)}  max ${cosAbsent[cosAbsent.length - 1]?.toFixed(3)}`);
console.log('='.repeat(96));

await settleStarters();
await closeFetcher();
db.close();

// The absent set is the gate. Do not ship past this while it fails.
if (count(absent, 'FAIL') > 0) {
  console.error(`\nFAILED: ${count(absent, 'FAIL')} unanswerable question(s) were answered rather than refused.`);
  process.exit(1);
}
if (count(answerable, 'FAIL') > 0) {
  console.error(`\nFAILED: ${count(answerable, 'FAIL')} answerable question(s) were refused or missed the expected fact.`);
  process.exit(1);
}
if (errors > 0) {
  console.error(`\nINCOMPLETE: ${errors} question(s) hit provider errors. Re-run, or pass --pace to space out calls.`);
  process.exit(1);
}
console.log('\nOK');
