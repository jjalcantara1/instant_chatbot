import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  origin_url   TEXT NOT NULL,
  domain       TEXT NOT NULL,
  status       TEXT NOT NULL,
  page_count   INTEGER DEFAULT 0,
  chunk_count  INTEGER DEFAULT 0,
  error        TEXT,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

-- URLs discovered by a crawl but not read within its page budget, best first.
-- This is what makes "read a few more pages" cost only the new pages: an
-- expansion resumes from here instead of re-walking the site from the root.
CREATE TABLE IF NOT EXISTS frontier (
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  score       INTEGER NOT NULL,
  PRIMARY KEY (session_id, url)
);

CREATE TABLE IF NOT EXISTS pages (
  id          INTEGER PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  title       TEXT,
  status      TEXT NOT NULL,
  char_count  INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chunks (
  id           INTEGER PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  page_id      INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  heading_path TEXT,
  text         TEXT NOT NULL,
  tokens       INTEGER NOT NULL,
  embedding    BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  ip_hash      TEXT NOT NULL,
  action       TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL,
  PRIMARY KEY (ip_hash, action, window_start)
);

-- Token accounting so cost is observable without a dashboard build.
CREATE TABLE IF NOT EXISTS usage_log (
  id           INTEGER PRIMARY KEY,
  session_id   TEXT NOT NULL,
  kind         TEXT NOT NULL,          -- embed|chat
  model        TEXT NOT NULL,
  input_tokens  INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_frontier_session ON frontier(session_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_pages_session ON pages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_log(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_log(created_at);
`;

/**
 * Columns added after the first deployment. `CREATE TABLE IF NOT EXISTS` will
 * not alter a table that already exists, so an existing database would keep the
 * old `sessions` shape and every insert naming a new column would fail.
 */
const SESSION_COLUMNS: Array<[string, string]> = [
  // The seed after redirects. An expansion resumes from this instead of paying
  // to follow the same redirect chain again.
  ['root_url', 'TEXT'],
  // Page budget this session has been crawled up to, cumulative across passes.
  ['page_budget', 'INTEGER NOT NULL DEFAULT 1'],
  // 1 once sitemap discovery has run, so it is paid for at most once.
  ['discovered', 'INTEGER NOT NULL DEFAULT 0'],
];

function migrate(db: Database.Database): void {
  const existing = new Set(
    (db.pragma('table_info(sessions)') as Array<{ name: string }>).map((c) => c.name),
  );
  for (const [name, decl] of SESSION_COLUMNS) {
    if (!existing.has(name)) db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${decl}`);
  }
}

export type DB = Database.Database;

let _db: DB | null = null;

export function openDb(path: string = config.databasePath): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function getDb(): DB {
  if (!_db) _db = openDb();
  return _db;
}

export function closeDb(): void {
  if (_db) { _db.close(); _db = null; }
}

/** Hourly sweep. Cascades delete pages/chunks/messages. */
export function sweepExpired(db: DB = getDb()): number {
  const now = Date.now();
  const info = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM rate_limits WHERE window_start < ?').run(now - 2 * 60 * 60 * 1000);
  db.prepare('DELETE FROM usage_log WHERE created_at < ?').run(now - 7 * 24 * 60 * 60 * 1000);
  db.pragma('optimize');
  return info.changes;
}
