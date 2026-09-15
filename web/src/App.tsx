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

/**
 * How much of the site to read, in pages.
 *
 * The landing page alone is the default because it is the fast one: a single
 * fetch and a single embedding batch, which is the difference between an answer
 * in seconds and a visitor who leaves. Everything past it is opt-in — here, or
 * afterwards from the chat screen, which costs only the new pages.
 */
const SCOPES: Array<{ pages: number; label: string }> = [
  { pages: 1, label: 'landing page' },
  { pages: 5, label: '5 pages' },
  { pages: 15, label: '15 pages' },
  { pages: 25, label: '25 pages' },
];

const DEFAULT_SCOPE = 1;

/** The input and error screens share this; the crawl and chat screens do not. */
function TopBar(): React.ReactElement {
  return (
    <div className="flex justify-between items-baseline px-[18px] py-4 md:px-12 md:py-[22px] border-b rule">
      <span className="text-[13px] md:text-[14px] font-semibold tracking-[-0.01em]">Site Chat</span>
      <span className="text-[11px] md:text-[12px] text-[var(--muted)]">
        <span className="md:hidden">up to 25 pages</span>
        <span className="hidden md:inline">up to 25 pages · expires in 24 hours · no account</span>
      </span>
    </div>
  );
}

export function App(): React.ReactElement {
  const [view, setView] = useState<View>({ kind: 'input' });
  const [url, setUrl] = useState('');
  const [scope, setScope] = useState(DEFAULT_SCOPE);
  const [submitting, setSubmitting] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);

  const [pages, setPages] = useState<PageEvent[]>([]);
  const [chunks, setChunks] = useState(0);
  const [embedded, setEmbedded] = useState(0);
  const [queued, setQueued] = useState(0);
  const [stage, setStage] = useState('resolving');
  const [domain, setDomain] = useState('');
  // The page budget this run was started with, so the log can say what it is
  // working towards instead of counting up against nothing.
  const [target, setTarget] = useState(DEFAULT_SCOPE);
  // Drives the 240ms slide-out so the log appears to dock into the sidebar.
  const [leaving, setLeaving] = useState(false);
  // When the indexer last actually did something. Embedding batches can be
  // tens of seconds apart on a throttled tier, and a stalled run has to look
  // different from a slow one.
  const [lastEventAt, setLastEventAt] = useState(Date.now());
  const startedAt = useRef(Date.now());
  const teardown = useRef<(() => void) | null>(null);

  useEffect(() => () => teardown.current?.(), []);

  const start = useCallback(async (raw: string, pages: number): Promise<void> => {
    const target = raw.trim();
    if (!target || submitting) return;

    setSubmitting(true);
    setInputError(null);

    try {
      const sessionId = await createSession(target, pages);

      setPages([]); setChunks(0); setEmbedded(0); setQueued(0); setStage('resolving');
      setLeaving(false);
      setLastEventAt(Date.now());
      setDomain(target.replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
      setTarget(pages);
      startedAt.current = Date.now();
      setView({ kind: 'indexing' });
      history.replaceState(null, '', `?s=${sessionId}`);

      teardown.current = subscribeToIndex(sessionId, {
        onPage: (p) => {
          setPages((prev) => [...prev, p]);
          setLastEventAt(Date.now());
        },
        onProgress: (p) => {
          // Only a change in the real counters counts as activity; a repeated
          // progress frame carrying the same numbers is not evidence of work.
          setChunks((prev) => {
            if (p.chunks !== prev) setLastEventAt(Date.now());
            return p.chunks;
          });
          setEmbedded((prev) => {
            if (p.embedded !== prev) setLastEventAt(Date.now());
            return p.embedded;
          });
          setQueued(p.pagesQueued);
          if (p.stage) setStage(p.stage);
        },
        onReady: () => {
          void (async () => {
            try {
              const session = await getSession(sessionId);
              // Fetch first, then animate, so the log never slides away onto a
              // blank screen if the session lookup fails.
              const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
              setLeaving(true);
              window.setTimeout(() => {
                setLeaving(false);
                setView({ kind: 'chat', session });
              }, reduced ? 120 : 240);
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
        // 'expanding' is a working index that is being added to, so a reload
        // mid-expansion should land back in the chat, not on the input screen.
        if (session.status === 'ready' || session.status === 'expanding') {
          setPages(session.pages);
          setView({ kind: 'chat', session });
        }
      } catch { /* a stale link just falls back to the input state */ }
    })();
  }, []);

  // Stable identity: Chat polls for suggestions in an effect that depends on
  // this, and a fresh closure each render would tear the timer down before it
  // ever fired.
  const replaceSession = useCallback((next: SessionDetail): void => {
    setView({ kind: 'chat', session: next });
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
      // Desktop is a fixed shell so only the transcript scrolls. On a phone the
      // panes stack, so the page scrolls normally instead.
      <div className="min-h-full md:h-full flex flex-col md:overflow-hidden screen-entering">
        <Chat
          session={view.session}
          onReset={reset}
          // An expansion changes the page list, the counts and the frontier, so
          // the refreshed session replaces the one this screen was opened with.
          onSession={replaceSession}
        />
      </div>
    );
  }

  if (view.kind === 'indexing') {
    return (
      <main className={`min-h-full md:h-full flex flex-col md:overflow-hidden ${leaving ? 'crawl-leaving' : ''}`}>
        <CrawlLog
          domain={domain}
          target={target}
          pages={pages}
          chunks={chunks}
          embedded={embedded}
          queued={queued}
          stage={stage}
          startedAt={startedAt.current}
          lastEventAt={lastEventAt}
          running={!leaving}
        />
      </main>
    );
  }

  if (view.kind === 'failed') {
    return (
      <main className="min-h-full flex flex-col">
        <TopBar />
        <div className="flex-1 flex flex-col justify-center px-[18px] md:px-12 py-10 md:py-0">
          <div className="font-mono text-[12px] text-[var(--flag)]">{view.code.toLowerCase()}</div>
          <p
            className="mt-[14px] text-[24px] md:text-[30px] font-semibold tracking-[-0.028em] leading-[1.2] max-w-[660px]"
            style={{ textWrap: 'pretty' } as React.CSSProperties}
          >
            {view.message}
          </p>
          <p className="mt-4 text-[15px] leading-[1.55] text-[var(--muted)] max-w-[460px]">
            Nothing was stored. Point it at a different address, or at a page you control.
          </p>
          <div className="mt-[34px] flex flex-wrap items-baseline gap-x-7 gap-y-4">
            <button onClick={reset} className="bare-action pb-2 text-[16px] font-medium">
              try another site
            </button>
            <a
              href="https://www.robotstxt.org/robotstxt.html"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[13px] text-[var(--muted)] underline underline-offset-[3px] py-2 md:py-0"
            >
              read what it does and does not fetch
            </a>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-full flex flex-col">
      <TopBar />
      <div className="flex-1 flex flex-col justify-center px-[18px] md:px-12 py-10 md:py-0">
        <h1
          className="m-0 font-semibold text-[40px] md:text-[62px] leading-[1.05] md:leading-[1.04] tracking-[-0.032em] md:tracking-[-0.035em] max-w-[840px]"
          style={{ textWrap: 'pretty' } as React.CSSProperties}
        >
          Point this at your website.
        </h1>
        <p className="mt-[14px] md:mt-[22px] text-[15px] md:text-[18px] leading-[1.5] text-[var(--muted)] max-w-[480px]">
          It reads the pages, then you can ask it things. Watch it work.
        </p>

        <form
          className="mt-[34px] md:mt-[54px] md:flex md:items-end md:gap-7 md:max-w-[860px]"
          onSubmit={(e) => { e.preventDefault(); void start(url, scope); }}
        >
          <div className="md:flex-1">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="your-site.com"
              aria-label="Website address"
              autoComplete="url"
              spellCheck={false}
              className="bare-field font-mono text-[19px] md:text-[30px] pb-[10px] md:pb-3"
            />
          </div>
          {/* A text link is too small a target on a phone, so this is the one
              bordered action in the app. */}
          <button
            type="submit"
            disabled={submitting || !url.trim()}
            className="mt-[22px] w-full border border-[var(--accent)] py-[14px] text-[16px] font-medium text-[var(--accent)] disabled:opacity-40
                       md:mt-0 md:w-auto md:border-x-0 md:border-t-0 md:border-b-2 md:py-0 md:pb-3 md:text-[20px] md:font-normal md:whitespace-nowrap"
          >
            {submitting ? 'starting…' : 'read it →'}
          </button>
        </form>

        <div className="mt-[22px] md:mt-6 flex flex-wrap items-baseline gap-x-[14px] md:gap-x-5 gap-y-[14px] text-[12.5px] md:text-[13px] text-[var(--muted)]">
          <span>read</span>
          {SCOPES.map((s) => (
            <button
              key={s.pages}
              type="button"
              aria-pressed={scope === s.pages}
              disabled={submitting}
              onClick={() => setScope(s.pages)}
              className="choice text-[13px]"
            >
              {s.label}
            </button>
          ))}
          <span className="basis-full text-[12px] md:basis-auto md:ml-1">
            {scope === 1
              ? 'fastest — you can read more once it is open'
              : 'slower to start; the landing page alone takes seconds'}
          </span>
        </div>

        {inputError && (
          <p className="mt-3 text-[13px] text-[var(--flag)] max-w-[640px]">{inputError}</p>
        )}

        <div className="mt-[22px] md:mt-6 flex flex-wrap items-baseline gap-x-[14px] md:gap-x-5 gap-y-[14px] text-[12.5px] md:text-[13px] text-[var(--muted)]">
          <span>or try</span>
          {EXAMPLES.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => { setUrl(e); void start(e, scope); }}
              className="link-path font-mono text-[13px] py-1 md:py-0"
            >
              {e}
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}
