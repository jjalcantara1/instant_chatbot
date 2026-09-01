/**
 * Phase 2 CLI: crawl a site and write a complete session into SQLite.
 *   npm run index-site -- https://example.com [--max 25] [--db ./data/dev.db]
 *
 * EMBEDDING_PROVIDER=hash runs the deterministic offline embedder, which
 * exercises the pipeline without an API key. Chunking and storage are
 * unaffected by that choice; retrieval quality very much is.
 */
import { customAlphabet } from 'nanoid';
import { openDb } from '../db.js';
import { runIndex, IndexError } from '../indexing/pipeline.js';
import { closeFetcher } from '../crawl/fetcher.js';
import { config } from '../config.js';

const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 22);

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const target = process.argv[2];
if (!target || target.startsWith('--')) {
  console.error('usage: npm run index-site -- <url> [--max N] [--db PATH]');
  process.exit(1);
}

const dbPath = flag('db') ?? config.databasePath;
const maxPages = Number(flag('max') ?? config.maxPages);
const db = openDb(dbPath);

const sessionId = nanoid();
const now = Date.now();
db.prepare(
  `INSERT INTO sessions (id, origin_url, domain, status, created_at, expires_at)
   VALUES (?, ?, ?, 'crawling', ?, ?)`,
).run(sessionId, target, new URL(target).hostname, now, now + config.sessionTtlMs);

console.log(`session ${sessionId}  ->  ${dbPath}\n`);

const t0 = Date.now();
try {
  const result = await runIndex({
    db,
    sessionId,
    url: target,
    maxPages,
    emit: (e) => {
      if (e.type === 'stage') console.log(`\n[stage] ${e.stage}`);
      else if (e.type === 'page') {
        const mark = e.status === 'ok' ? '+' : e.status === 'empty' ? '~' : 'x';
        console.log(`  ${mark} ${String(Date.now() - t0).padStart(6)}ms ${String(e.charCount).padStart(6)}c  ${e.url}`);
      } else if (e.type === 'progress' && e.chunks > 0) {
        console.log(`     .. ${e.pagesFetched} pages, ${e.chunks} chunks embedded`);
      } else if (e.type === 'ready') {
        console.log(`\n[ready] ${e.pages} pages, ${e.chunks} chunks, ${e.elapsedMs}ms, ${e.skipped} skipped`);
      }
    },
  });
  console.log(`\ndomain       ${result.domain}`);
  console.log(`embed tokens ${result.embedTokens.toLocaleString()}`);
  console.log(`session id   ${sessionId}`);
  console.log(`\ninspect with:  npm run dump -- ${sessionId} --db ${dbPath}`);
} catch (e) {
  if (e instanceof IndexError) {
    db.prepare('UPDATE sessions SET status = ?, error = ? WHERE id = ?').run('failed', e.code, sessionId);
    console.error(`\n[${e.code}] ${e.message}`);
    process.exitCode = 1;
  } else {
    throw e;
  }
} finally {
  await closeFetcher();
  db.close();
}
