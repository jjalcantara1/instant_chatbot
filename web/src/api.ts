export interface PageEvent {
  url: string; title: string; status: string; charCount: number;
}
export interface ProgressEvent {
  pagesFetched: number; pagesQueued: number; chunks: number; embedded: number; stage: string;
}
export interface ReadyEvent {
  pages: number; chunks: number; elapsedMs: number; skipped: number;
  /** Pages found but not read - how much a "read more" has to work with. */
  frontier: number;
}
export interface ErrorEvent { code: string; message: string; }

export interface SessionDetail {
  sessionId: string;
  url: string;
  widgetOrigin: string;
  domain: string;
  status: string;
  pageCount: number;
  chunkCount: number;
  error: string | null;
  expiresAt: number;
  messagesUsed: number;
  messagesAllowed: number;
  pages: PageEvent[];
  /** Discovered but unread pages waiting in this session's frontier. */
  frontier: number;
  /** How many more pages this session is still allowed to take. */
  headroom: number;
  /** Pages this session has been crawled up to, across every pass. */
  pageBudget: number;
  maxPages: number;
  /** Default size of one "read more". */
  expandStep: number;
  /** Opening questions the server has verified it can actually answer. */
  starters: Starter[];
  /** True while verification is still running, so an empty list is not final. */
  startersPending: boolean;
}

/** A suggested opening question, already verified server-side as answerable. */
export interface Starter {
  text: string;
  url: string;
}

export interface Source {
  n: number; url: string; title: string; headingPath: string;
}

export class ApiError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function parseError(res: Response): Promise<never> {
  let code = 'INTERNAL';
  let message = 'Something went wrong talking to the server.';
  try {
    const body = await res.json() as { code?: string; message?: string };
    if (body.code) code = body.code;
    if (body.message) message = body.message;
  } catch { /* keep the defaults */ }
  throw new ApiError(code, message);
}

/**
 * Start an index. `pages` is how much of the site to read; omitted, the server
 * reads the landing page and nothing else.
 */
export async function createSession(url: string, pages?: number): Promise<string> {
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(pages === undefined ? { url } : { url, pages }),
  });
  if (!res.ok) await parseError(res);
  const body = await res.json() as { sessionId: string };
  return body.sessionId;
}

/**
 * Read more of a site that is already indexed. Resolves as soon as the run has
 * been accepted; progress arrives over the same event stream as the first pass,
 * so `subscribeToIndex` covers both.
 */
export async function expandSession(sessionId: string, pages: number): Promise<number> {
  const res = await fetch(`/api/sessions/${sessionId}/expand`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pages }),
  });
  if (!res.ok) await parseError(res);
  const body = await res.json() as { pages: number };
  return body.pages;
}

export async function getSession(sessionId: string): Promise<SessionDetail> {
  const res = await fetch(`/api/sessions/${sessionId}`);
  if (!res.ok) await parseError(res);
  return await res.json() as SessionDetail;
}

export interface IndexHandlers {
  onPage: (p: PageEvent) => void;
  onProgress: (p: ProgressEvent) => void;
  onReady: (r: ReadyEvent) => void;
  onError: (e: ErrorEvent) => void;
}

/** Live crawl feed. Returns a teardown function. */
export function subscribeToIndex(sessionId: string, handlers: IndexHandlers): () => void {
  const source = new EventSource(`/api/sessions/${sessionId}/events`);

  const on = <T,>(name: string, fn: (data: T) => void): void => {
    source.addEventListener(name, (ev) => {
      try { fn(JSON.parse((ev as MessageEvent<string>).data) as T); }
      catch { /* a malformed frame should not kill the stream */ }
    });
  };

  on<PageEvent>('page', handlers.onPage);
  on<ProgressEvent>('progress', handlers.onProgress);
  on<ReadyEvent>('ready', (r) => { handlers.onReady(r); source.close(); });
  on<ErrorEvent>('error', (e) => { handlers.onError(e); source.close(); });

  // A transport-level failure arrives as an untyped `error` with no data.
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) {
      handlers.onError({
        code: 'CONNECTION_LOST',
        message: 'The connection to the indexer dropped. Reload to see where it got to.',
      });
    }
  };

  return () => source.close();
}

export type AnswerStage = 'retrieving' | 'generating';

export interface MessageHandlers {
  onStatus?: (stage: AnswerStage) => void;
  onToken: (text: string) => void;
  onSources: (sources: Source[]) => void;
  onDone: (info: { messagesUsed: number; messagesAllowed: number }) => void;
  onError: (e: ErrorEvent) => void;
}

/**
 * The messages endpoint is POST plus SSE, which EventSource cannot do, so the
 * frame parsing is done by hand over the fetch body stream.
 */
export async function sendMessage(
  sessionId: string,
  message: string,
  handlers: MessageHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
    signal,
  });

  if (!res.ok) {
    try { await parseError(res); }
    catch (e) {
      const err = e as ApiError;
      handlers.onError({ code: err.code, message: err.message });
      return;
    }
  }
  if (!res.body) {
    handlers.onError({ code: 'INTERNAL', message: 'The server sent an empty response.' });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatch = (frame: string): void => {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue;               // heartbeat
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    let data: unknown;
    try { data = JSON.parse(dataLines.join('\n')); } catch { return; }

    if (event === 'status') handlers.onStatus?.((data as { stage: AnswerStage }).stage);
    else if (event === 'token') handlers.onToken((data as { text: string }).text);
    else if (event === 'sources') handlers.onSources((data as { sources: Source[] }).sources);
    else if (event === 'done') handlers.onDone(data as { messagesUsed: number; messagesAllowed: number });
    else if (event === 'error') handlers.onError(data as ErrorEvent);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split: number;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      dispatch(buffer.slice(0, split));
      buffer = buffer.slice(split + 2);
    }
  }
  if (buffer.trim()) dispatch(buffer);
}
