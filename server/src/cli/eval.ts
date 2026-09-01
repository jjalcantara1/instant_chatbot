/**
 * Phase 3 checkpoint.
 *   npm run eval -- [--fixture eval/fixtures/kleiosoftware.json] [--reuse SESSION_ID] [--db PATH]
 *
 * Fluent hallucination on a visitor's own website is the failure that kills
 * this demo's purpose, so the gate that matters is the unanswerable set: every
 * one of them must refuse. That is asserted structurally rather than by reading
 * the prose — a refusal is a turn that cites no page, because a cited page is
 * the model claiming the site says something.
 *
 * Requires real embeddings and a real chat model. The similarity floor is
 * calibrated against real vector geometry; the offline hash embedder cannot
 * stand in for it, and the run refuses to pretend otherwise.
 */
import { readFileSync } from 'node:fs';
import { customAlphabet } from 'nanoid';
import { openDb } from '../db.js';
import { runIndex } from '../indexing/pipeline.js';
import { closeFetcher } from '../crawl/fetcher.js';
import { retrieve } from '../retrieve/retrieve.js';
import { streamAnswer } from '../chat/chat.js';
import { getEmbedder } from '../indexing/embed.js';
import { config } from '../config.js';

const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 22);

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

interface Fixture {
  site: string;
  questions: Array<{ q: string; answerable: boolean }>;
}

const fixturePath = flag('fixture') ?? 'eval/fixtures/kleiosoftware.json';
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;
const dbPath = flag('db') ?? './data/eval.db';

if ((process.env['EMBEDDING_PROVIDER'] ?? config.embeddingProvider) === 'hash') {
  console.error('This eval needs real embeddings. The hash embedder cannot calibrate the similarity floor.');
  process.exit(2);
}
if (!config.anthropicApiKey) {
  console.error('ANTHROPIC_API_KEY is not set; the eval cannot run.');
  process.exit(2);
}
if (!config.openaiApiKey && config.embeddingProvider === 'openai') {
  console.error('OPENAI_API_KEY is not set; the eval cannot run.');
  process.exit(2);
}

const db = openDb(dbPath);
const embedder = getEmbedder();

let sessionId = flag('reuse');
let domain = '';

if (sessionId) {
  const row = db.prepare('SELECT domain, chunk_count FROM sessions WHERE id = ?').get(sessionId) as
    | { domain: string; chunk_count: number } | undefined;
  if (!row) { console.error(`No session ${sessionId} in ${dbPath}`); process.exit(2); }
  domain = row.domain;
  console.log(`reusing session ${sessionId} (${domain}, ${row.chunk_count} chunks)\n`);
} else {
  sessionId = nanoid();
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, origin_url, domain, status, created_at, expires_at)
     VALUES (?, ?, ?, 'crawling', ?, ?)`,
  ).run(sessionId, fixture.site, new URL(fixture.site).hostname, now, now + config.sessionTtlMs);

  process.stdout.write(`indexing ${fixture.site} ... `);
  const result = await runIndex({ db, sessionId, url: fixture.site, emit: () => {} });
  domain = result.domain;
  console.log(`${result.pages} pages, ${result.chunks} chunks, ${result.elapsedMs}ms`);
  console.log(`session ${sessionId}  (reuse with --reuse ${sessionId})\n`);
}

interface Row {
  q: string;
  answerable: boolean;
  refused: boolean;
  pass: boolean;
  sources: number;
  topCosine: number;
  insufficient: boolean;
  answer: string;
}

const rows: Row[] = [];

for (const item of fixture.questions) {
  const probe = await retrieve(db, sessionId, item.q, embedder);
  const topCosine = probe.chunks.length > 0 ? Math.max(...probe.chunks.map((c) => c.cosine)) : 0;

  let answer = '';
  let sources = 0;
  for await (const e of streamAnswer({
    db, sessionId, domain, question: item.q, history: [], embedder,
  })) {
    if (e.type === 'token') answer += e.text;
    else if (e.type === 'sources') sources = e.sources.length;
    else if (e.type === 'error') answer += `\n[error] ${e.message}`;
  }

  // A refusal is a turn that cites nothing. Citing a page is the model
  // asserting the site covers this, which is exactly what must not happen
  // for an absent question.
  const refused = probe.insufficient || sources === 0;
  const pass = item.answerable ? !refused : refused;

  rows.push({
    q: item.q, answerable: item.answerable, refused, pass, sources,
    topCosine, insufficient: probe.insufficient, answer: answer.trim(),
  });

  process.stdout.write(pass ? '.' : 'F');
}

console.log('\n');

const answerable = rows.filter((r) => r.answerable);
const absent = rows.filter((r) => !r.answerable);

const show = (label: string, set: Row[]): void => {
  console.log(`\n${label}`);
  console.log('-'.repeat(96));
  for (const r of set) {
    const mark = r.pass ? 'PASS' : 'FAIL';
    console.log(`${mark}  cos=${r.topCosine.toFixed(3)} src=${r.sources}${r.insufficient ? ' [floor]' : ''}  ${r.q}`);
    console.log(`      ${r.answer.replace(/\n/g, ' ').slice(0, 150)}`);
  }
};

show('ANSWERABLE — must produce a cited answer', answerable);
show('ABSENT — must refuse', absent);

const absentPass = absent.filter((r) => r.pass).length;
const answerablePass = answerable.filter((r) => r.pass).length;

console.log('\n' + '='.repeat(96));
console.log(`answerable  ${answerablePass}/${answerable.length} answered with sources`);
console.log(`absent      ${absentPass}/${absent.length} refused`);

const cosAnswerable = answerable.map((r) => r.topCosine).sort((a, b) => a - b);
const cosAbsent = absent.map((r) => r.topCosine).sort((a, b) => a - b);
console.log(`\nfloor calibration (currently ${config.minCosine}):`);
console.log(`  answerable top-cosine  min ${cosAnswerable[0]?.toFixed(3)}  max ${cosAnswerable[cosAnswerable.length - 1]?.toFixed(3)}`);
console.log(`  absent     top-cosine  min ${cosAbsent[0]?.toFixed(3)}  max ${cosAbsent[cosAbsent.length - 1]?.toFixed(3)}`);
if (cosAnswerable[0] !== undefined && cosAbsent[cosAbsent.length - 1] !== undefined) {
  const gap = cosAnswerable[0] - (cosAbsent[cosAbsent.length - 1] as number);
  console.log(`  separation ${gap.toFixed(3)}${gap <= 0 ? '  <-- the two classes overlap; the floor alone cannot separate them' : ''}`);
}
console.log('='.repeat(96));

await closeFetcher();
db.close();

// The absent set is the gate. Do not proceed past this phase while it fails.
if (absentPass < absent.length) {
  console.error(`\nFAILED: ${absent.length - absentPass} unanswerable question(s) were answered rather than refused.`);
  process.exit(1);
}
if (answerablePass < answerable.length) {
  console.error(`\nFAILED: ${answerable.length - answerablePass} answerable question(s) were refused.`);
  process.exit(1);
}
console.log('\nOK');
