import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError, createSession, getSession, subscribeToIndex,
  type PageEvent, type SessionDetail,
} from './api';
import { CrawlLog } from './CrawlLog';
import { Chat } from './Chat';

type View =
  | { kind: 'input' }
  | { kind: 'indexing' }
  | { kind: 'chat'; session: SessionDetail }
  | { kind: 'failed'; code: string; message: string };

const EXAMPLES = ['kleiosoftware.com', '11ty.dev', 'danluu.com'];

export function App(): React.ReactElement {
  const [view, setView] = useState<View>({ kind: 'input' });
  const [url, setUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);

  const [pages, setPages] = useState<PageEvent[]>([]);
  const [chunks, setChunks] = useState(0);
  const [queued, setQueued] = useState(0);
  const [stage, setStage] = useState('resolving');
  const [domain, setDomain] = useState('');
  const startedAt = useRef(Date.now());
  const teardown = useRef<(() => void) | null>(null);

  useEffect(() => () => teardown.current?.(), []);

  const start = useCallback(async (raw: string): Promise<void> => {
    const target = raw.trim();
    if (!target || submitting) return;

    setSubmitting(true);
    setInputError(null);

    try {
      const sessionId = await createSession(target);

      setPages([]); setChunks(0); setQueued(0); setStage('resolving');
      setDomain(target.replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
      startedAt.current = Date.now();
      setView({ kind: 'indexing' });
      history.replaceState(null, '', `?s=${sessionId}`);

      teardown.current = subscribeToIndex(sessionId, {
        onPage: (p) => setPages((prev) => [...prev, p]),
        onProgress: (p) => {
          setChunks(p.chunks);
          setQueued(p.pagesQueued);
          if (p.stage) setStage(p.stage);
        },
        onReady: () => {
          void (async () => {
            try {
              const session = await getSession(sessionId);
              setView({ kind: 'chat', session });
            } catch (e) {
              const err = e as ApiError;
              setView({ kind: 'failed', code: err.code, message: err.message });
            }
          })();
        },
        onError: (e) => setView({ kind: 'failed', code: e.code, message: e.message }),
      });
    } catch (e) {
      const err = e as ApiError;
      setInputError(err.message);
      setView({ kind: 'input' });
    } finally {
      setSubmitting(false);
    }
  }, [submitting]);

  // Resume a session from ?s=... so a reload during indexing is not fatal.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('s');
    if (!id) return;
    void (async () => {
      try {
        const session = await getSession(id);
        if (session.status === 'ready') {
          setPages(session.pages);
          setView({ kind: 'chat', session });
        }
      } catch { /* a stale link just falls back to the input state */ }
    })();
  }, []);

  const reset = (): void => {
    teardown.current?.();
    history.replaceState(null, '', window.location.pathname);
    setView({ kind: 'input' });
    setUrl('');
    setInputError(null);
  };

  if (view.kind === 'chat') {
    return (
      <div className="min-h-full">
        <Chat session={view.session} />
        <footer className="max-w-5xl mx-auto px-4 pb-8">
          <button onClick={reset} className="font-mono text-[12px] text-[var(--signal)] hover:underline">
            ← index a different site
          </button>
        </footer>
      </div>
    );
  }

  if (view.kind === 'indexing') {
    return (
      <main className="min-h-full flex items-start justify-center px-4 pt-16 pb-10">
        <CrawlLog
          domain={domain}
          pages={pages}
          chunks={chunks}
          queued={queued}
          stage={stage}
          startedAt={startedAt.current}
          running
        />
      </main>
    );
  }

  if (view.kind === 'failed') {
    return (
      <main className="min-h-full flex items-center justify-center px-4">
        <div className="max-w-lg w-full">
          <div className="font-mono text-[12px] text-[var(--flag)]">{view.code.toLowerCase()}</div>
          <p className="mt-2 text-[17px] leading-snug">{view.message}</p>
          <button
            onClick={reset}
            className="mt-5 border rule px-4 py-2 font-mono text-[13px] hover:bg-[var(--card)]"
          >
            try another site
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-full flex items-center justify-center px-4">
      <div className="w-full max-w-xl">
        <h1 className="text-[30px] leading-[1.15] font-medium">
          Point this at your website.
        </h1>
        <p className="mt-2 text-[var(--muted)]">
          It reads the pages, then you can ask it things. Watch it work.
        </p>

        <form
          className="mt-6 flex gap-2"
          onSubmit={(e) => { e.preventDefault(); void start(url); }}
        >
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="your-site.com"
            aria-label="Website address"
            autoComplete="url"
            spellCheck={false}
            className="flex-1 bg-[var(--card)] border rule px-3 py-2.5 font-mono text-[14px]"
          />
          <button
            type="submit"
            disabled={submitting || !url.trim()}
            className="border rule px-4 py-2.5 font-mono text-[13px] hover:bg-[var(--card)] disabled:opacity-40 whitespace-nowrap"
          >
            {submitting ? 'starting…' : 'read it →'}
          </button>
        </form>

        {inputError && (
          <p className="mt-2 text-[13px] text-[var(--flag)]">{inputError}</p>
        )}

        <div className="mt-4 font-mono text-[12px] text-[var(--muted)]">
          or try{' '}
          {EXAMPLES.map((e, i) => (
            <span key={e}>
              {i > 0 && '  '}
              <button
                onClick={() => { setUrl(e); void start(e); }}
                className="text-[var(--signal)] hover:underline"
              >
                {e}
              </button>
            </span>
          ))}
        </div>

        <p className="mt-8 font-mono text-[12px] text-[var(--muted)]">
          25 pages max · expires in 24 hours · no account
        </p>
      </div>
    </main>
  );
}
