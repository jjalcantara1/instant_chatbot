import { Router, type Request, type Response } from 'express';
import { config, resolveChat } from '../config.js';
import { getEmbedder, resolveEmbedding } from '../indexing/embed.js';
import { indexedWithAnotherModel } from '../retrieve/retrieve.js';
import { getDb } from '../db.js';
import { openSse } from './sse.js';
import {
  createSession, expandSession, getJob, ValidationError, toUserFacing, queueDepth, runningCount,
} from './jobs.js';
import { peekRateLimit, consumeRateLimit, checkDailyCap, clientIp } from './ratelimit.js';
import { streamAnswer } from '../chat/chat.js';
import type { IndexEvent } from '../indexing/pipeline.js';

export const router: Router = Router();

interface SessionRow {
  id: string; origin_url: string; domain: string; status: string;
  page_count: number; chunk_count: number; error: string | null;
  created_at: number; expires_at: number;
  page_budget: number; discovered: number;
  starters: string | null;
}

/**
 * Suggested questions, every one already verified to clear the retrieval gate.
 * NULL in the column means verification has not finished, which the client
 * shows differently from an empty list - see `startersPending` below.
 */
function parseStarters(raw: string | null): Array<{ text: string; url: string }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is { text: string; url: string } =>
        typeof (s as { text?: unknown }).text === 'string',
    );
  } catch { return []; }
}

/** Pages discovered but not yet read - the size of the "read more" offer. */
function frontierSize(id: string): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM frontier WHERE session_id = ?')
    .get(id) as { n: number }).n;
}

/**
 * How many more pages this session could take. A session is allowed to grow to
 * MAX_PAGES in total no matter how many passes it takes to get there.
 */
function headroom(session: SessionRow): number {
  return Math.max(0, config.maxPages - session.page_count);
}

function loadSession(id: string): SessionRow | undefined {
  return getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
}

/**
 * Indexed by a different embedding model than the current one - a session
 * that outlived a change of EMBEDDING_PROVIDER. An embedder that cannot even
 * be built (a missing key) is left for the answer path to report.
 */
function isStale(id: string): boolean {
  try {
    return indexedWithAnotherModel(getDb(), id, getEmbedder());
  } catch {
    return false;
  }
}

/** Widget embeds run on arbitrary origins; the session id is the only credential. */
function allowAnyOrigin(res: Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Vary', 'Origin');
}

router.get('/healthz', (_req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), running: runningCount(), queued: queueDepth() });
});

router.post('/api/sessions', async (req: Request, res: Response) => {
  const ip = clientIp(req);

  const daily = checkDailyCap();
  if (!daily.allowed) {
    res.status(429).json({
      code: 'RATE_LIMITED',
      message: `This demo has hit today's limit of ${daily.cap} indexes. It resets at midnight. If you want to see it on your own site before then, get in touch.`,
    });
    return;
  }

  const limit = peekRateLimit(ip, 'index', config.indexPerIpPerHour);
  if (!limit.allowed) {
    const mins = Math.ceil(limit.retryAfterSeconds / 60);
    res.setHeader('Retry-After', String(limit.retryAfterSeconds));
    res.status(429).json({
      code: 'RATE_LIMITED',
      message: `You have indexed ${limit.limit} sites this hour, which is the cap. You can run another in ${mins} minute${mins === 1 ? '' : 's'}.`,
    });
    return;
  }

  const body = req.body as { url?: unknown; pages?: unknown } | undefined;
  const url = typeof body?.url === 'string' ? body.url : '';

  try {
    // `pages` is optional and clamped server-side; absent means the landing
    // page only, which is what the overwhelming majority of runs should be.
    const { sessionId, pages } = await createSession(url, body?.pages);
    // Only a real indexing run costs anything, so only that spends a slot.
    consumeRateLimit(ip, 'index');
    res.status(201).json({ sessionId, pages });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ code: err.code, message: err.message });
      return;
    }
    const { code, message } = toUserFacing(err);
    res.status(500).json({ code, message });
  }
});

router.get('/api/sessions/:id', (req: Request, res: Response) => {
  allowAnyOrigin(res);
  const id = req.params['id'] as string;
  const session = loadSession(id);

  if (!session) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'That session does not exist. It may have expired — sessions last 24 hours.' });
    return;
  }
  if (session.expires_at < Date.now()) {
    res.status(410).json({ code: 'EXPIRED', message: 'This session has expired. Demo sessions last 24 hours.' });
    return;
  }

  const pages = getDb().prepare(
    'SELECT url, title, status, char_count AS charCount FROM pages WHERE session_id = ? ORDER BY id',
  ).all(id) as Array<{ url: string; title: string | null; status: string; charCount: number }>;

  const messageCount = (getDb().prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'user'",
  ).get(id) as { n: number }).n;

  res.json({
    sessionId: session.id,
    url: session.origin_url,
    // What a "read more" would have to work with, and how far it may go.
    frontier: frontierSize(id),
    headroom: headroom(session),
    pageBudget: session.page_budget,
    maxPages: config.maxPages,
    expandStep: config.expandStep,
    starters: parseStarters(session.starters),
    // Verification is one embedding request and can be held behind a pacing
    // gate on a rate-limited key, so the index goes ready without it. The
    // client polls while this is true rather than concluding there are none.
    startersPending: session.starters === null && session.status !== 'failed',
    // Where widget.js is actually served from. The frontend is deployed to
    // Firebase Hosting while the API lives on the VPS, so the page's own
    // origin is the wrong base for the embed snippet.
    widgetOrigin: config.publicWidgetOrigin,
    domain: session.domain,
    status: session.status,
    pageCount: session.page_count,
    chunkCount: session.chunk_count,
    error: session.error,
    expiresAt: session.expires_at,
    messagesUsed: messageCount,
    messagesAllowed: config.maxMessagesPerSession,
    pages,
  });
});

router.get('/api/sessions/:id/events', (req: Request, res: Response) => {
  const id = req.params['id'] as string;
  const session = loadSession(id);

  if (!session) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'That session does not exist.' });
    return;
  }

  const channel = openSse(res);

  // A stage change carries no counts of its own. Sending zeros would make the
  // visitor watch the page and chunk counters collapse to 0 on the way into
  // "building index", so carry the last real numbers across the transition.
  let lastCounts = { pagesFetched: 0, pagesQueued: 0, chunks: 0, embedded: 0 };

  const forward = (e: IndexEvent): void => {
    if (e.type === 'page') {
      channel.send('page', { url: e.url, title: e.title, status: e.status, charCount: e.charCount });
    } else if (e.type === 'progress') {
      lastCounts = {
        pagesFetched: e.pagesFetched, pagesQueued: e.pagesQueued,
        chunks: e.chunks, embedded: e.embedded,
      };
      channel.send('progress', { ...lastCounts, stage: e.stage });
    } else if (e.type === 'stage') {
      channel.send('progress', { ...lastCounts, stage: e.stage });
    } else if (e.type === 'ready') {
      channel.send('ready', {
        pages: e.pages, chunks: e.chunks, elapsedMs: e.elapsedMs,
        skipped: e.skipped, frontier: e.frontier,
      });
      channel.close();
    } else if (e.type === 'error') {
      channel.send('error', { code: e.code, message: e.message });
      channel.close();
    }
  };

  const job = getJob(id);

  if (!job) {
    // The run finished before this connection (or the process restarted).
    // Reconstruct a terminal event from the stored session so the client
    // still resolves instead of hanging on an open stream.
    if (session.status === 'ready') {
      const pages = getDb().prepare(
        "SELECT url, title, status, char_count AS charCount FROM pages WHERE session_id = ? AND status = 'ok' ORDER BY id",
      ).all(id) as Array<{ url: string; title: string; status: string; charCount: number }>;
      for (const p of pages) channel.send('page', p);
      channel.send('ready', {
        pages: session.page_count, chunks: session.chunk_count,
        elapsedMs: 0, skipped: 0, frontier: frontierSize(id),
      });
    } else {
      channel.send('error', {
        code: session.error ?? 'INTERNAL',
        message: 'This indexing run is no longer available. Start a new one to try again.',
      });
    }
    channel.close();
    return;
  }

  const unsubscribe = job.subscribe(forward);
  res.on('close', unsubscribe);
});

/**
 * Read more of a site that is already indexed. Separately rate limited from
 * indexing: with a one-page default this is the normal way to get a bigger
 * index, so charging it against the three-per-hour index budget would make the
 * default setting feel like a trap.
 */
router.post('/api/sessions/:id/expand', async (req: Request, res: Response) => {
  const id = req.params['id'] as string;
  const session = loadSession(id);

  // Missing and expired are not 409s. Checked here rather than inside
  // expandSession so they carry the same codes and statuses as every other
  // session-scoped route.
  if (!session) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'That session does not exist. It may have expired — sessions last 24 hours.' });
    return;
  }
  if (session.expires_at < Date.now()) {
    res.status(410).json({ code: 'EXPIRED', message: 'This session has expired. Demo sessions last 24 hours.' });
    return;
  }

  const ip = clientIp(req);

  const limit = peekRateLimit(ip, 'expand', config.expandsPerIpPerHour);
  if (!limit.allowed) {
    const mins = Math.ceil(limit.retryAfterSeconds / 60);
    res.setHeader('Retry-After', String(limit.retryAfterSeconds));
    res.status(429).json({
      code: 'RATE_LIMITED',
      message: `You have read ${limit.limit} extra batches of pages this hour, which is the cap. You can read more in ${mins} minute${mins === 1 ? '' : 's'}.`,
    });
    return;
  }

  const body = req.body as { pages?: unknown } | undefined;

  try {
    const result = await expandSession(id, body?.pages);
    consumeRateLimit(ip, 'expand');
    res.status(202).json(result);
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(409).json({ code: err.code, message: err.message });
      return;
    }
    const { code, message } = toUserFacing(err);
    res.status(500).json({ code, message });
  }
});

/**
 * Reduce stored turns to well-formed user -> assistant pairs, dropping any
 * question that never got an answer.
 */
export function pairedHistory(
  rows: Array<{ role: 'user' | 'assistant'; content: string }>,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (let i = 0; i < rows.length; i++) {
    const turn = rows[i];
    if (turn?.role !== 'user') continue;
    const reply = rows[i + 1];
    if (reply?.role === 'assistant') {
      out.push(turn, reply);
      i++;
    }
  }
  return out;
}

/**
 * A provider rate limit is not an internal error, and telling someone to "ask
 * again" when the next attempt is also rate limited just wastes their patience.
 * Name what happened and what to do about it.
 */
function chatError(detail: string, partial: boolean): { code: string; message: string } {
  if (/429|rate limit|quota|RESOURCE_EXHAUSTED/i.test(detail)) {
    return {
      code: 'RATE_LIMITED',
      message: partial
        ? 'The answer stopped partway through because the demo hit a provider rate limit. Give it a minute, then ask again.'
        : 'The demo hit a provider rate limit before it could answer. Give it a minute, then ask again.',
    };
  }
  if (/API_KEY|authentication|unauthor|401|403/i.test(detail)) {
    return {
      code: 'INTERNAL',
      message: 'The demo is not fully configured right now, so answering is unavailable. This is our problem, not yours.',
    };
  }
  return {
    code: 'INTERNAL',
    message: partial
      ? 'The answer stopped partway through. Ask again and it will usually go through.'
      : 'That answer could not be started. Ask again and it will usually go through.',
  };
}

router.post('/api/sessions/:id/messages', async (req: Request, res: Response) => {
  allowAnyOrigin(res);
  const id = req.params['id'] as string;
  const session = loadSession(id);

  if (!session) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'That session does not exist. It may have expired.' });
    return;
  }
  if (session.expires_at < Date.now()) {
    res.status(410).json({ code: 'EXPIRED', message: 'This session has expired. Demo sessions last 24 hours.' });
    return;
  }
  // 'expanding' means more pages are being added to an index that already
  // works. Refusing questions during that would make "read more" feel like a
  // downgrade, so only a first pass blocks the chat.
  if (session.status !== 'ready' && session.status !== 'expanding') {
    res.status(409).json({ code: 'NOT_READY', message: 'This site is still being indexed.' });
    return;
  }
  if (isStale(id)) {
    res.status(409).json({
      code: 'STALE_INDEX',
      message: 'This chat was indexed with a search model the demo no longer uses, so its answers would not be reliable. Index the site again to keep chatting.',
    });
    return;
  }

  const ip = clientIp(req);
  const limit = peekRateLimit(ip, 'message', config.messagesPerIpPerHour);
  if (!limit.allowed) {
    const mins = Math.ceil(limit.retryAfterSeconds / 60);
    res.setHeader('Retry-After', String(limit.retryAfterSeconds));
    res.status(429).json({
      code: 'RATE_LIMITED',
      message: `You have sent ${limit.limit} messages this hour, which is the cap. You can send more in ${mins} minute${mins === 1 ? '' : 's'}.`,
    });
    return;
  }

  const db = getDb();
  const used = (db.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'user'",
  ).get(id) as { n: number }).n;

  if (used >= config.maxMessagesPerSession) {
    res.status(429).json({
      code: 'SESSION_MESSAGE_CAP',
      message: `That is all ${config.maxMessagesPerSession} messages for this demo session. If this is useful on your own site, a permanent version is a conversation.`,
    });
    return;
  }

  const body = req.body as { message?: unknown } | undefined;
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!message) {
    res.status(400).json({ code: 'INVALID_MESSAGE', message: 'Type a question first.' });
    return;
  }
  if (message.length > 1000) {
    res.status(400).json({ code: 'INVALID_MESSAGE', message: 'That question is too long — keep it under 1000 characters.' });
    return;
  }

  // Validation passed and the question is going to be answered, so spend it now.
  consumeRateLimit(ip, 'message');

  const recent = db.prepare(
    'SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 8',
  ).all(id) as Array<{ role: 'user' | 'assistant'; content: string }>;
  recent.reverse();

  // An answer that failed leaves its question stored with no reply. Replaying
  // that orphan puts two questions in front of the model, and it answers the
  // stale one. Keep only completed exchanges.
  const history = pairedHistory(recent).slice(-6);

  db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)')
    .run(id, 'user', message, Date.now());

  const channel = openSse(res);
  let answer = '';

  try {
    for await (const event of streamAnswer({
      db, sessionId: id, domain: session.domain, question: message, history,
    })) {
      if (channel.closed) break;
      if (event.type === 'status') {
        channel.send('status', { stage: event.stage });
      } else if (event.type === 'token') {
        answer += event.text;
        channel.send('token', { text: event.text });
      } else if (event.type === 'sources') {
        channel.send('sources', { sources: event.sources });
      } else if (event.type === 'done') {
        db.prepare('INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)')
          .run(id, 'assistant', answer, Date.now());
        db.prepare(
          'INSERT INTO usage_log (session_id, kind, model, input_tokens, output_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(id, 'chat', config.chatModel, event.inputTokens, event.outputTokens, Date.now());
        channel.send('done', { messagesUsed: used + 1, messagesAllowed: config.maxMessagesPerSession });
      } else if (event.type === 'error') {
        // The visitor gets a plain message; the operator gets the real cause.
        console.error(`[chat] session=${id} ${event.message}`);
        channel.send('error', chatError(event.message, answer.length > 0));
      }
    }
  } catch (err) {
    console.error(`[chat] session=${id}`, err);
    channel.send('error', chatError(err instanceof Error ? err.message : String(err), answer.length > 0));
  } finally {
    channel.close();
  }
});

router.options('/api/sessions/:id/messages', (_req, res) => {
  allowAnyOrigin(res);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.status(204).end();
});

router.get('/admin/stats', (req: Request, res: Response) => {
  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!config.adminToken || token !== config.adminToken) {
    res.status(401).json({ code: 'UNAUTHORIZED', message: 'Bearer token required.' });
    return;
  }

  const db = getDb();
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);

  const usage = db.prepare(`
    SELECT kind, model, SUM(input_tokens) AS input, SUM(output_tokens) AS output, COUNT(*) AS calls
    FROM usage_log WHERE created_at >= ? GROUP BY kind, model
  `).all(dayStart.getTime()) as Array<{ kind: string; model: string; input: number; output: number; calls: number }>;

  // Published rates. Embedding cost is per input token only.
  // USD per token. Keyed by the real model id rather than by whatever is
  // configured: keying on config.chatModel priced every provider's model at
  // Claude Haiku's rate. Unknown models are surfaced below instead of being
  // silently costed at zero.
  const M = 1_000_000;
  const RATES: Record<string, { in: number; out: number }> = {
    'text-embedding-3-small': { in: 0.02 / M, out: 0 },
    'voyage-3-lite': { in: 0.02 / M, out: 0 },
    'hash-dev': { in: 0, out: 0 },
    // Runs on this box: it costs CPU and memory, not money.
    'Xenova/bge-small-en-v1.5': { in: 0, out: 0 },
    'claude-haiku-4-5': { in: 1 / M, out: 5 / M },
    'claude-haiku-4-5-20251001': { in: 1 / M, out: 5 / M },
    'gemini-3.5-flash-lite': { in: 0.30 / M, out: 2.50 / M },
    'gemini-3.5-flash': { in: 1.50 / M, out: 9.00 / M },
    'gemini-2.5-flash-lite': { in: 0.10 / M, out: 0.40 / M },
    'gemini-2.5-flash': { in: 0.30 / M, out: 2.50 / M },
  };
  const unpriced: string[] = [];

  let estimatedCostUsd = 0;
  for (const u of usage) {
    const rate = RATES[u.model];
    if (rate) estimatedCostUsd += (u.input ?? 0) * rate.in + (u.output ?? 0) * rate.out;
    else if (!unpriced.includes(u.model)) unpriced.push(u.model);
  }

  res.json({
    today: {
      sessions: (db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE created_at >= ?').get(dayStart.getTime()) as { n: number }).n,
      cap: config.dailyIndexCap,
      messages: (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'user' AND created_at >= ?").get(dayStart.getTime()) as { n: number }).n,
      usage,
      estimatedCostUsd: Number(estimatedCostUsd.toFixed(4)),
      // Named explicitly so a model with no rate cannot quietly read as free.
      unpricedModels: unpriced,
    },
    live: { running: runningCount(), queued: queueDepth() },
    totals: {
      sessions: (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n,
      chunks: (db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n,
    },
    config: {
      chatModel: `${resolveChat().provider}/${resolveChat().model}`,
      embeddingModel: resolveEmbedding().model,
      defaultPages: config.defaultPages,
      maxPages: config.maxPages,
      expandStep: config.expandStep,
      concurrentCrawls: config.concurrentCrawls,
    },
  });
});
