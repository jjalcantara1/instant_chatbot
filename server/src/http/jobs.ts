import { customAlphabet } from 'nanoid';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { runIndex, IndexError, type IndexEvent, type IndexErrorCode } from '../indexing/pipeline.js';
import { guardUrl } from '../crawl/ssrf.js';
import { fetchRobots } from '../crawl/robots.js';
import { normaliseUrl } from '../crawl/urlnorm.js';
import { invalidateSession } from '../retrieve/retrieve.js';

const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 22);

export type Subscriber = (event: IndexEvent) => void;

/**
 * One indexing run. Events are retained so a client that connects late — or
 * reconnects — replays the whole crawl instead of joining a stream already in
 * progress and seeing a blank log.
 */
class IndexJob {
  readonly events: IndexEvent[] = [];
  private readonly subscribers = new Set<Subscriber>();
  finished = false;
  queuePosition = 0;

  emit(event: IndexEvent): void {
    this.events.push(event);
    for (const s of this.subscribers) {
      try { s(event); } catch { /* a dead client must not break the run */ }
    }
  }

  subscribe(fn: Subscriber): () => void {
    for (const e of this.events) fn(e);
    if (this.finished) return () => {};
    this.subscribers.add(fn);
    return () => { this.subscribers.delete(fn); };
  }

  finish(): void {
    this.finished = true;
    this.subscribers.clear();
  }
}

const jobs = new Map<string, IndexJob>();

/** Sessions expire in 24h; jobs are dropped from memory well before that. */
const JOB_TTL_MS = 60 * 60 * 1000;
const jobCreatedAt = new Map<string, number>();

export function getJob(sessionId: string): IndexJob | undefined {
  return jobs.get(sessionId);
}

export function sweepJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, at] of jobCreatedAt) {
    if (at < cutoff) { jobs.delete(id); jobCreatedAt.delete(id); }
  }
}

// Concurrency cap, site-wide. Beyond it, runs queue and report their position.
let running = 0;
const waiting: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (running < config.concurrentCrawls) { running++; return; }
  await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
}

function releaseSlot(): void {
  running--;
  const next = waiting.shift();
  if (next) next();
}

export function queueDepth(): number { return waiting.length; }
export function runningCount(): number { return running; }

export class ValidationError extends Error {
  constructor(public readonly code: IndexErrorCode, message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export interface CreateSessionResult { sessionId: string; }

/**
 * Validate, create the session row, and start the run in the background.
 * Returns as soon as the session exists so the client can open its stream.
 */
export async function createSession(rawUrl: string): Promise<CreateSessionResult> {
  const trimmed = (rawUrl ?? '').trim();
  if (!trimmed) throw new ValidationError('INVALID_URL', 'Enter a website address to index.');

  // Distinguish "no scheme" from "a scheme we do not accept". Blindly
  // prepending https:// to `file:///etc/passwd` produces a nonsense host and
  // the visitor gets told their domain could not be resolved, which is not
  // what went wrong.
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (schemeMatch && !/^https?$/i.test(schemeMatch[1] as string)) {
    throw new ValidationError(
      'INVALID_URL',
      `Only http and https addresses can be indexed, not ${(schemeMatch[1] as string).toLowerCase()}:.`,
    );
  }

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  const guard = await guardUrl(withScheme);
  if (!guard.ok) {
    const code: IndexErrorCode =
      guard.reason === 'PRIVATE_IP' || guard.reason === 'IP_LITERAL' ||
      guard.reason === 'INTERNAL_TLD' || guard.reason === 'BLOCKED_DOMAIN'
        ? 'BLOCKED_HOST'
        : guard.reason === 'NO_ADDRESSES' || guard.reason === 'DNS_FAIL'
          ? 'UNREACHABLE'
          : 'INVALID_URL';

    // A bare word never resolves, but telling someone their domain is
    // unreachable when they typed "banana" describes the wrong problem.
    // Only ever replaces the generic DNS message, never a security one.
    if (code === 'UNREACHABLE') {
      let host = '';
      try { host = new URL(withScheme).hostname; } catch { /* keep the guard's message */ }
      if (host && !host.includes('.')) {
        throw new ValidationError(
          'INVALID_URL',
          `"${trimmed}" does not look like a website address. Try something like example.com.`,
        );
      }
    }

    throw new ValidationError(code, guard.detail);
  }

  const normalised = normaliseUrl(guard.url.toString());
  if (!normalised) throw new ValidationError('INVALID_URL', 'That URL could not be understood.');

  // Check robots before creating a session, so a disallowed site fails fast
  // with the right reason rather than producing an empty index.
  const robots = await fetchRobots(normalised);
  if (!robots.isAllowed(normalised)) {
    throw new ValidationError(
      'ROBOTS_DISALLOWED',
      'This site’s robots.txt asks crawlers not to read it, so it cannot be indexed here.',
    );
  }

  const db = getDb();
  const sessionId = nanoid();
  const now = Date.now();

  db.prepare(
    `INSERT INTO sessions (id, origin_url, domain, status, created_at, expires_at)
     VALUES (?, ?, ?, 'queued', ?, ?)`,
  ).run(sessionId, normalised, guard.url.hostname, now, now + config.sessionTtlMs);

  const job = new IndexJob();
  jobs.set(sessionId, job);
  jobCreatedAt.set(sessionId, now);

  void runJob(sessionId, normalised, job);

  return { sessionId };
}

async function runJob(sessionId: string, url: string, job: IndexJob): Promise<void> {
  const db = getDb();

  if (running >= config.concurrentCrawls) {
    job.emit({ type: 'stage', stage: 'queued' });
  }
  await acquireSlot();

  try {
    db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run('crawling', sessionId);
    await runIndex({ db, sessionId, url, emit: (e) => job.emit(e) });
    invalidateSession(sessionId);
  } catch (err) {
    const { code, message } = toUserFacing(err);
    // The visitor gets the friendly line; the operator needs the real cause,
    // otherwise a failing index is undiagnosable from the logs alone.
    console.error(`[index ${sessionId}] failed as ${code}:`, err);
    db.prepare('UPDATE sessions SET status = ?, error = ? WHERE id = ?').run('failed', code, sessionId);
    job.emit({ type: 'error', code, message });
  } finally {
    releaseSlot();
    job.finish();
  }
}

/** Every failure path gets a specific, actionable message. No generic fallback text. */
export function toUserFacing(err: unknown): { code: IndexErrorCode; message: string } {
  if (err instanceof IndexError) return { code: err.code, message: err.message };
  if (err instanceof ValidationError) return { code: err.code, message: err.message };

  const msg = err instanceof Error ? err.message : String(err);

  if (/OPENAI_API_KEY|VOYAGE_API_KEY|ANTHROPIC_API_KEY/.test(msg)) {
    return {
      code: 'INTERNAL',
      message: 'The demo is not fully configured right now, so indexing is unavailable. This is our problem, not yours — please try again later.',
    };
  }
  if (/Embedding provider returned 429|rate limit/i.test(msg)) {
    return {
      code: 'RATE_LIMITED',
      message: 'The demo is busy right now and hit a provider limit. Give it a minute and try again.',
    };
  }
  if (/INVALID_URL/.test(msg)) {
    return { code: 'INVALID_URL', message: 'That address could not be read as a URL.' };
  }
  return {
    code: 'INTERNAL',
    message: 'Indexing stopped unexpectedly partway through. Trying again often works; if it does not, the site may be blocking automated readers.',
  };
}
