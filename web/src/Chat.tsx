import { useEffect, useMemo, useRef, useState } from 'react';
import {
  expandSession, getSession, sendMessage, subscribeToIndex,
  type AnswerStage, type ApiError, type PageEvent, type SessionDetail, type Source,
} from './api';

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  sources?: Source[];
  error?: string;
}

function shortPath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === '/' ? '/' : u.pathname.replace(/\/$/, '');
  } catch { return url; }
}

/**
 * Page titles are written for search engines. Strip the brand tail and the
 * descriptive half so a suggestion reads like something a person would ask.
 */
function cleanTitle(title: string): string {
  const head = title.split(/\s+[|–—·]\s+/)[0]?.trim() ?? title.trim();
  const kept = head.length >= 3 ? head : title.trim();
  const lead = (kept.split(/:\s+/)[0] ?? kept).trim();
  return lead.length >= 3 ? lead : kept;
}

/** Renders [1] citation markers as footnote references rather than raw text. */
function AnswerText({ text }: { text: string }): React.ReactElement {
  const parts = text.split(/(\[\d{1,2}\])/g);
  return (
    <>
      {parts.map((part, i) => {
        const m = /^\[(\d{1,2})\]$/.exec(part);
        if (!m) return <span key={i}>{part}</span>;
        return (
          <sup key={i} className="font-mono text-[11px] text-[var(--accent)] relative top-[-0.8em]">
            {m[1]}
          </sup>
        );
      })}
    </>
  );
}

/** Sources are footnotes under a rule, not chips beside the answer. */
function Footnotes({ sources }: { sources: Source[] }): React.ReactElement {
  return (
    <div className="mt-5 md:mt-7 border-t rule pt-3 max-w-[640px] flex flex-col gap-3">
      {sources.map((s) => (
        <div key={s.url} className="flex items-baseline gap-3 md:gap-[14px]">
          <span className="font-mono text-[11px] text-[var(--accent)] pt-0.5">{s.n}</span>
          <div className="min-w-0">
            <a
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className="link-path font-mono text-[12px] md:text-[12.5px] block truncate"
            >
              {shortPath(s.url)} ↗
            </a>
            {s.title && (
              <div className="mt-1 text-[12px] text-[var(--muted)] truncate md:whitespace-normal">
                {s.title}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function Thinking({ stage }: { stage: AnswerStage | null }): React.ReactElement {
  const label = stage === 'generating' ? 'writing an answer' : 'searching the indexed pages';
  return (
    <p className="text-[14px] text-[var(--muted)] flex items-center gap-1.5" role="status" aria-live="polite">
      <span>{label}<span className="dots" aria-hidden="true" /></span>
      <span className="caret h-[14px]" aria-hidden="true" />
    </p>
  );
}

function EmbedSnippet({ sessionId, widgetOrigin }: { sessionId: string; widgetOrigin: string }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  // The API origin, not the page's own: this snippet gets pasted into a
  // different site entirely, and the frontend is deployed separately.
  const origin = widgetOrigin || (typeof window !== 'undefined' ? window.location.origin : '');
  const snippet = `<script src="${origin}/widget.js" data-session="${sessionId}" async></script>`;

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <>
      <div className="border-t rule pt-4 text-[12px] text-[var(--muted)]">put this on your site</div>
      <div className="mt-2 border rule bg-[var(--card)] px-2.5 py-2 font-mono text-[10px] leading-[1.6] break-all">
        {snippet}
      </div>
      <button onClick={() => void copy()} className="mt-2.5 link-accent text-[12px]">
        {copied ? 'copied' : 'copy'}
      </button>
    </>
  );
}

interface ReadMoreState {
  /** Pages read so far by the pass currently running, or null when idle. */
  progress: number | null;
  note: string | null;
}

/**
 * The other half of the one-page default: reading more, after the fact, for
 * the cost of the new pages only.
 *
 * The first crawl left behind every URL it discovered and had no budget for,
 * so this does not re-walk the site — it resumes from that list. The existing
 * index stays live throughout, which is why the transcript is not interrupted
 * and the input is never disabled while it runs.
 */
function ReadMore({ session, state, onRead, compact }: {
  session: SessionDetail;
  state: ReadMoreState;
  onRead: () => void;
  compact?: boolean;
}): React.ReactElement | null {
  const running = state.progress !== null;
  const step = Math.min(session.expandStep, session.headroom);

  // Nothing found and no room to look: there is no honest offer to make.
  if (!running && state.note === null && (session.headroom <= 0 || session.frontier === 0)) {
    return null;
  }

  const found = session.frontier === 1 ? '1 more page found' : `${session.frontier} more pages found`;

  return (
    <div className={compact ? 'text-[12px]' : 'mt-4 pt-4 border-t rule text-[12px]'}>
      {running ? (
        <span className="text-[var(--muted)]" role="status" aria-live="polite">
          reading{state.progress ? ` · ${state.progress} read` : ''}
          <span className="dots" aria-hidden="true" />
        </span>
      ) : (
        <>
          {session.frontier > 0 && (
            <span className="text-[var(--muted)]">{found}</span>
          )}
          {step > 0 && session.frontier > 0 && (
            <button onClick={onRead} className={`link-accent ${compact ? 'ml-3' : 'block mt-1.5'}`}>
              read {step} more →
            </button>
          )}
          {state.note && (
            <p className="mt-1.5 text-[var(--muted)]">{state.note}</p>
          )}
        </>
      )}
    </div>
  );
}

function PathList({ pages, cited }: { pages: PageEvent[]; cited: Set<string> }): React.ReactElement {
  return (
    <div className="mt-3 flex flex-col gap-[7px] font-mono text-[12px]">
      {pages.map((p) => (
        <a
          key={p.url}
          href={p.url}
          target="_blank"
          rel="noopener noreferrer"
          title={p.title || p.url}
          className={`truncate ${
            cited.has(p.url)
              ? 'text-[var(--accent)] underline underline-offset-[3px]'
              : 'text-[var(--ink)] no-underline hover:text-[var(--accent)]'
          }`}
        >
          {shortPath(p.url)}
        </a>
      ))}
    </div>
  );
}

export function Chat({ session, onReset, onSession }: {
  session: SessionDetail;
  onReset: () => void;
  onSession: (next: SessionDetail) => void;
}): React.ReactElement {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<AnswerStage | null>(null);
  const [used, setUsed] = useState(session.messagesUsed);
  const [capped, setCapped] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [more, setMore] = useState<ReadMoreState>({ progress: null, note: null });
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const expandFeed = useRef<(() => void) | null>(null);

  useEffect(() => () => expandFeed.current?.(), []);

  const okPages = useMemo(() => session.pages.filter((p) => p.status === 'ok'), [session.pages]);

  // The pages the newest answer cited, highlighted in the sidebar.
  const cited = useMemo(() => {
    const last = [...turns].reverse().find((t) => t.role === 'assistant' && t.sources?.length);
    return new Set((last?.sources ?? []).map((s) => s.url));
  }, [turns]);

  // Derived from real indexed pages rather than invented copy.
  const starters = useMemo(
    () => okPages.filter((p) => p.title).slice(0, 3).map((p) => `Tell me about ${cleanTitle(p.title)}`),
    [okPages],
  );

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [turns]);

  /**
   * Expansion reports over the same event stream as the first crawl, because
   * the server runs it as a job under the same session id. When it lands, the
   * whole session is refetched rather than patched: page list, counts and the
   * remaining frontier all move together, and one of them going stale would
   * show up as a "read more" that offers pages already in the index.
   */
  const readMore = async (): Promise<void> => {
    if (more.progress !== null) return;
    setMore({ progress: 0, note: null });

    const finish = (note: string | null): void => {
      expandFeed.current?.();
      expandFeed.current = null;
      setMore({ progress: null, note });
    };

    try {
      await expandSession(session.sessionId, session.expandStep);
    } catch (e) {
      finish((e as ApiError).message);
      return;
    }

    expandFeed.current = subscribeToIndex(session.sessionId, {
      onPage: (p) => {
        if (p.status === 'ok') setMore((m) => ({ ...m, progress: (m.progress ?? 0) + 1 }));
      },
      onProgress: () => {},
      onReady: () => {
        void (async () => {
          try {
            const next = await getSession(session.sessionId);
            onSession(next);
            finish(next.frontier === 0 ? 'That is every page this crawler can find.' : null);
          } catch {
            finish('Those pages were read, but the page list could not be refreshed. Reload to see them.');
          }
        })();
      },
      onError: (e) => finish(e.message),
    });
  };

  const ask = async (question: string): Promise<void> => {
    if (!question.trim() || busy) return;
    setInput('');
    setBusy(true);
    setStage('retrieving');
    setTurns((t) => [...t, { role: 'user', text: question }, { role: 'assistant', text: '' }]);

    const patchLast = (fn: (turn: Turn) => Turn): void => {
      setTurns((t) => t.map((turn, i) => (i === t.length - 1 ? fn(turn) : turn)));
    };

    await sendMessage(session.sessionId, question, {
      onStatus: (s) => setStage(s),
      onToken: (text) => patchLast((t) => ({ ...t, text: t.text + text })),
      onSources: (sources) => patchLast((t) => ({ ...t, sources })),
      onDone: (info) => {
        setUsed(info.messagesUsed);
        if (info.messagesUsed >= info.messagesAllowed) setCapped(true);
      },
      onError: (e) => {
        patchLast((t) => ({ ...t, error: e.message }));
        if (e.code === 'SESSION_MESSAGE_CAP' || e.code === 'RATE_LIMITED') setCapped(true);
      },
    });

    setBusy(false);
    setStage(null);
    inputRef.current?.focus();
  };

  const remaining = session.messagesAllowed - used;
  const counter = remaining > 0
    ? `${remaining} message${remaining === 1 ? '' : 's'} left in this demo session`
    : 'No messages left in this demo session';

  return (
    <div className="md:flex-1 md:min-h-0 grid md:grid-cols-[236px_1fr] md:h-full">
      {/* Sidebar is desktop only; on a phone the paths live behind a disclosure. */}
      <aside className="hidden md:flex border-r rule px-6 py-[26px] flex-col overflow-hidden">
        <div className="text-[12px] text-[var(--muted)]">indexed · {okPages.length}</div>
        <div className="min-h-0 overflow-y-auto scroll-thin -mr-2 pr-2">
          <PathList pages={okPages} cited={cited} />
        </div>
        <ReadMore session={session} state={more} onRead={() => void readMore()} />
        <div className="mt-auto pt-[26px]">
          <EmbedSnippet sessionId={session.sessionId} widgetOrigin={session.widgetOrigin} />
          <p className="mt-[18px] text-[12px] leading-[1.55] text-[var(--muted)]">
            This session expires in 24 hours. A permanent one is a conversation —{' '}
            <a
              className="link-accent"
              href="https://kleiosoftware.com/book-a-call"
              target="_blank"
              rel="noopener noreferrer"
            >
              talk to Kleio
            </a>
            .
          </p>
        </div>
      </aside>

      <section className="min-w-0 flex flex-col min-h-[60vh] md:min-h-0 md:h-full">
        <header className="shrink-0 px-[18px] py-4 md:px-11 md:pt-[26px] md:pb-5 border-b rule">
          <div className="flex items-baseline justify-between gap-6">
            <h1 className="text-[17px] md:text-[22px] font-semibold tracking-[-0.02em] leading-[1.1] truncate">
              {session.domain}
            </h1>
            <button
              onClick={onReset}
              className="text-[11.5px] md:text-[12px] text-[var(--muted)] underline underline-offset-[3px] whitespace-nowrap py-2 md:py-0"
            >
              <span className="md:hidden">change site</span>
              <span className="hidden md:inline">← index a different site</span>
            </button>
          </div>
          <p className="hidden md:block mt-[7px] text-[13px] text-[var(--muted)]">
            {session.pageCount === 1
              ? 'Reading the landing page. Ask it something you already know the answer to.'
              : `Reading ${session.pageCount} pages. Ask it something you already know the answer to.`}
          </p>
          <div className="md:hidden mt-2 flex items-baseline justify-between text-[12px] text-[var(--muted)]">
            <span>{okPages.length} pages indexed</span>
            <button onClick={() => setListOpen(!listOpen)} className="link-accent py-2" aria-expanded={listOpen}>
              {listOpen ? 'hide the list ↑' : 'see the list ↓'}
            </button>
          </div>
          {listOpen && (
            <div className="md:hidden pb-1">
              <PathList pages={okPages} cited={cited} />
            </div>
          )}
          <div className="md:hidden mt-1.5">
            <ReadMore session={session} state={more} onRead={() => void readMore()} compact />
          </div>
        </header>

        <div
          ref={scroller}
          className="flex-1 min-h-0 overflow-y-auto scroll-thin px-[18px] py-[18px] md:px-11 md:py-[30px]"
        >
          {turns.length === 0 && (
            <>
              <div className="text-[13px] md:text-[14px] text-[var(--muted)]">Nothing asked yet.</div>
              {starters.length > 0 && (
                <div className="mt-6 max-w-[540px] border-t rule">
                  {starters.map((q) => (
                    <button
                      key={q}
                      onClick={() => void ask(q)}
                      className="w-full flex items-baseline justify-between gap-5 py-[14px] border-b rule text-left text-[15px]"
                    >
                      <span>{q}</span>
                      <span className="text-[12px] text-[var(--accent)] whitespace-nowrap">ask →</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {turns.map((turn, i) =>
            turn.role === 'user' ? (
              <div key={i} className="text-[13px] md:text-[14px] text-[var(--muted)] mt-7 first:mt-0">
                {turn.text}
              </div>
            ) : (
              <div key={i} className="mt-3 md:mt-4">
                {turn.error ? (
                  <p className="text-[var(--flag)] text-[14px] max-w-[640px]">{turn.error}</p>
                ) : (
                  <>
                    {busy && i === turns.length - 1 && turn.text === '' && <Thinking stage={stage} />}
                    {turn.text !== '' && (
                      <p
                        className="text-[16.5px] md:text-[17.5px] leading-[1.6] tracking-[-0.006em] max-w-[640px] whitespace-pre-wrap"
                        style={{ textWrap: 'pretty' } as React.CSSProperties}
                      >
                        <AnswerText text={turn.text} />
                        {busy && i === turns.length - 1 && (
                          <span className="caret h-[15px] ml-0.5 align-[-2px]" aria-hidden="true" />
                        )}
                      </p>
                    )}
                    {turn.sources && turn.sources.length > 0 && <Footnotes sources={turn.sources} />}
                  </>
                )}
              </div>
            ),
          )}

          {/* The snippet follows the transcript on a phone, where there is no sidebar. */}
          <div className="md:hidden mt-10 pt-2">
            <EmbedSnippet sessionId={session.sessionId} widgetOrigin={session.widgetOrigin} />
          </div>
        </div>

        <form
          className="shrink-0 px-[18px] pb-[18px] md:px-11 md:pb-[26px]"
          onSubmit={(e) => { e.preventDefault(); void ask(input); }}
        >
          <div className="border-t rule pt-[14px] md:pt-[18px] flex items-end justify-between gap-4 md:gap-6">
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={busy || capped}
              placeholder={capped ? 'Message limit reached for this session' : 'Ask about this site'}
              aria-label="Ask about this site"
              maxLength={1000}
              className="bare-field flex-1 text-[16px] md:text-[19px] pb-[9px] md:pb-2.5"
            />
            <button
              type="submit"
              disabled={busy || capped || !input.trim()}
              className="bare-action pb-[9px] md:pb-2.5 text-[15px] md:text-[16px] font-medium"
            >
              ask
            </button>
          </div>
          <div className="mt-2.5 text-[11px] md:text-[11.5px] text-[var(--muted)] tnum">
            {counter}
            <span className="md:hidden"> · expires in 24 hours</span>
          </div>
        </form>
      </section>
    </div>
  );
}
