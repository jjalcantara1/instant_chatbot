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

CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_pages_session ON pages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_log(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_log(created_at);
`;

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
