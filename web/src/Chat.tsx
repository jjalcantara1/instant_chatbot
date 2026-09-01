import { useEffect, useRef, useState } from 'react';
import { sendMessage, type AnswerStage, type PageEvent, type SessionDetail, type Source } from './api';

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  sources?: Source[];
  error?: string;
}

/** Renders [1] citation markers as superscript references rather than raw text. */
function AnswerText({ text }: { text: string }): React.ReactElement {
  const parts = text.split(/(\[\d{1,2}\])/g);
  return (
    <>
      {parts.map((part, i) => {
        const m = /^\[(\d{1,2})\]$/.exec(part);
        if (!m) return <span key={i}>{part}</span>;
        return (
          <sup key={i} className="font-mono text-[11px] text-[var(--signal)] px-[1px]">
            {m[1]}
          </sup>
        );
      })}
    </>
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
    <div className="mt-4">
      <div className="font-mono text-[12px] text-[var(--muted)] mb-1">put this on your site</div>
      <pre className="font-mono text-[11px] leading-relaxed bg-[var(--card)] border rule p-2 overflow-x-auto whitespace-pre-wrap break-all">
        {snippet}
      </pre>
      <button
        onClick={() => void copy()}
        className="mt-1 font-mono text-[12px] border rule px-2 py-1 hover:bg-[var(--card)]"
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </div>
  );
}

function PageList({ pages }: { pages: PageEvent[] }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const ok = pages.filter((p) => p.status === 'ok');
  const shown = open ? ok : ok.slice(0, 8);

  return (
    <div>
      <div className="font-mono text-[12px] text-[var(--muted)] mb-1">
        indexed · {ok.length}
      </div>
      <ul className="font-mono text-[12px] space-y-[2px]">
        {shown.map((p) => (
          <li key={p.url} className="truncate">
            <a
              href={p.url}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[var(--signal)] hover:underline"
              title={p.title || p.url}
            >
              {new URL(p.url).pathname || '/'}
            </a>
          </li>
        ))}
      </ul>
      {ok.length > 8 && (
        <button
          onClick={() => setOpen(!open)}
          className="mt-1 font-mono text-[12px] text-[var(--signal)] hover:underline"
        >
          {open ? 'show fewer' : `show all ${ok.length}`}
        </button>
      )}
    </div>
  );
}

/**
 * Retrieval runs before the model is called, and on a throttled embedding tier
 * that is seconds of nothing. Naming the phase beats a caret that just blinks.
 */
function Thinking({ stage }: { stage: AnswerStage | null }): React.ReactElement {
  const label = stage === 'generating' ? 'writing an answer' : 'searching the indexed pages';
  return (
    <p className="font-mono text-[13px] text-[var(--muted)]" role="status" aria-live="polite">
      {label}
      <span className="dots" aria-hidden="true" />
    </p>
  );
}

export function Chat({ session }: { session: SessionDetail }): React.ReactElement {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<AnswerStage | null>(null);
  const [used, setUsed] = useState(session.messagesUsed);
  const [capped, setCapped] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [turns]);

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

  return (
    <div className="mx-auto max-w-5xl w-full px-4 py-6 md:py-4 grid gap-6 md:grid-cols-[13rem_1fr] md:flex-1 md:min-h-0">
      {/* Stays put while the transcript moves; scrolls internally if the page
          list outgrows the viewport. */}
      <aside className="md:border-r rule md:pr-5 md:h-full md:overflow-y-auto scroll-thin">
        <PageList pages={session.pages} />
        <div className="border-t rule my-4" />
        <EmbedSnippet sessionId={session.sessionId} widgetOrigin={session.widgetOrigin} />
        <p className="mt-4 text-[13px] text-[var(--muted)] leading-snug">
          This session expires in 24 hours. A permanent one is a conversation —{' '}
          <a
            className="text-[var(--signal)] underline underline-offset-2"
            href="https://kleiosoftware.com/book-a-call"
            target="_blank"
            rel="noopener noreferrer"
          >
            talk to Kleio
          </a>
          .
        </p>
      </aside>

      <section className="min-w-0 flex flex-col min-h-[60vh] md:min-h-0 md:h-full">
        <header className="shrink-0 pb-3 border-b rule">
          <h1 className="font-mono text-[13px]">{session.domain}</h1>
          <p className="text-[13px] text-[var(--muted)] mt-1">
            Reading {session.pageCount} pages. Ask it something you already know the answer to.
          </p>
        </header>

        <div ref={scroller} className="flex-1 min-h-0 overflow-y-auto scroll-thin py-4 space-y-5">
          {turns.length === 0 && (
            <p className="text-[var(--muted)] text-[14px]">
              Nothing asked yet.
            </p>
          )}

          {turns.map((turn, i) =>
            turn.role === 'user' ? (
              <div key={i} className="font-mono text-[13px]">
                <span className="text-[var(--signal)]">› </span>
                {turn.text}
              </div>
            ) : (
              <div key={i} className="max-w-prose">
                {turn.error ? (
                  <p className="text-[var(--flag)] text-[14px]">{turn.error}</p>
                ) : (
                  <>
                    {busy && i === turns.length - 1 && turn.text === '' && (
                      <Thinking stage={stage} />
                    )}
                    <p className="whitespace-pre-wrap">
                      <AnswerText text={turn.text} />
                      {busy && i === turns.length - 1 && turn.text !== '' && (
                        <span className="cursor text-[var(--signal)]">▌</span>
                      )}
                    </p>
                    {turn.sources && turn.sources.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {turn.sources.map((s) => (
                          <a
                            key={s.url}
                            href={s.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-mono text-[11px] border rule px-1.5 py-0.5 hover:border-[var(--signal)] hover:text-[var(--signal)]"
                            title={s.title}
                          >
                            {new URL(s.url).pathname || '/'} ↗
                          </a>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            ),
          )}
        </div>

        <form
          className="shrink-0 border-t rule pt-3"
          onSubmit={(e) => { e.preventDefault(); void ask(input); }}
        >
          <div className="flex gap-2">
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={busy || capped}
              placeholder={capped ? 'Message limit reached for this session' : 'Ask about this site'}
              aria-label="Ask about this site"
              maxLength={1000}
              className="flex-1 bg-[var(--card)] border rule px-3 py-2 text-[14px] disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={busy || capped || !input.trim()}
              className="border rule px-4 py-2 font-mono text-[13px] hover:bg-[var(--card)] disabled:opacity-40"
            >
              {busy ? '…' : 'ask'}
            </button>
          </div>
          <div className="font-mono text-[11px] text-[var(--muted)] mt-1.5">
            {remaining > 0
              ? `${remaining} message${remaining === 1 ? '' : 's'} left in this demo session`
              : 'No messages left in this demo session'}
          </div>
        </form>
      </section>
    </div>
  );
}
