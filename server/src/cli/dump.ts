/**
 * Phase 2 checkpoint tool: print a session's chunks for a human to read.
 * Bad chunks poison everything downstream and no assertion will tell you.
 *   npm run dump -- <sessionId> [--db PATH] [--page URL_SUBSTRING] [--full]
 */
import { openDb } from '../db.js';
import { config } from '../config.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const sessionId = process.argv[2];
if (!sessionId || sessionId.startsWith('--')) {
  console.error('usage: npm run dump -- <sessionId> [--db PATH] [--page SUBSTR] [--full]');
  process.exit(1);
}

const db = openDb(flag('db') ?? config.databasePath);

const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
  | { id: string; origin_url: string; domain: string; status: string; page_count: number; chunk_count: number }
  | undefined;

if (!session) {
  const all = db.prepare('SELECT id, domain, status, chunk_count FROM sessions ORDER BY created_at DESC LIMIT 10').all();
  console.error(`No session ${sessionId}. Recent sessions:`);
  console.error(all);
  process.exit(1);
}

console.log('='.repeat(78));
console.log(`${session.domain}   ${session.status}   ${session.page_count} pages / ${session.chunk_count} chunks`);
console.log(`origin: ${session.origin_url}`);
console.log('='.repeat(78));

const filter = flag('page');
const rows = db.prepare(`
  SELECT c.id, c.heading_path AS headingPath, c.text, c.tokens, p.url, p.title
  FROM chunks c JOIN pages p ON p.id = c.page_id
  WHERE c.session_id = @sid ${filter ? 'AND p.url LIKE @like' : ''}
  ORDER BY p.url, c.id
`).all(filter ? { sid: sessionId, like: `%${filter}%` } : { sid: sessionId }) as Array<{
  id: number; headingPath: string | null; text: string; tokens: number; url: string; title: string | null;
}>;

let lastUrl = '';
const lengths: number[] = [];

for (const r of rows) {
  if (r.url !== lastUrl) {
    console.log(`\n\n### ${r.title ?? '(untitled)'}`);
    console.log(`### ${r.url}`);
    lastUrl = r.url;
  }
  lengths.push(r.text.length);
  const body = has('full') || r.text.length <= 320 ? r.text : r.text.slice(0, 320) + ' …';
  console.log(`\n  [${r.id}] ${r.headingPath || '(no heading)'}  ·  ${r.text.length}c / ~${r.tokens}t`);
  console.log('  ' + body.replace(/\n/g, '\n  '));
}

lengths.sort((a, b) => a - b);
const pct = (p: number): number => lengths[Math.floor(lengths.length * p)] ?? 0;

console.log('\n\n' + '='.repeat(78));
console.log(`chunks       ${rows.length}`);
if (lengths.length > 0) {
  console.log(`chars        min ${lengths[0]}  p50 ${pct(0.5)}  p90 ${pct(0.9)}  max ${lengths[lengths.length - 1]}`);
  const under = lengths.filter((l) => l < 80).length;
  const over = lengths.filter((l) => l > 1000).length;
  console.log(`outliers     ${under} under 80 chars, ${over} over 1000 chars`);
}
const noHeading = rows.filter((r) => !r.headingPath).length;
console.log(`no heading   ${noHeading} / ${rows.length}`);
console.log('='.repeat(78));

db.close();
