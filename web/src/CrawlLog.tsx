import { useEffect, useState } from 'react';
import type { PageEvent } from './api';

const STAGE_LABEL: Record<string, string> = {
  resolving: 'resolving address',
  robots: 'reading robots.txt',
  sitemap: 'reading sitemap',
  crawling: 'crawling',
  indexing: 'building index',
  queued: 'waiting for a free slot',
  ready: 'ready',
};

function shortPath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === '/' ? '/' : u.pathname.replace(/\/$/, '');
  } catch { return url; }
}

/**
 * Between embedding batches nothing else on this screen moves — on a throttled
 * tier that can be twenty seconds of apparent death. This is the one element
 * that keeps ticking, and because it counts real seconds since the indexer last
 * moved a counter, a genuine stall reads differently from a slow run instead of
 * being disguised by a spinner.
 */
function Heartbeat({ chunks, embedded, stage, lastEventAt }: {
  chunks: number; embedded: number; stage: string; lastEventAt: number;
}): React.ReactElement | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const quietFor = Math.max(0, Math.floor((now - lastEventAt) / 1000));
  const embedding = stage === 'indexing' && chunks > 0;
  if (!embedding && quietFor < 4) return null;

  return (
    <div className="mt-3 text-[12px] md:text-[13px] text-[var(--muted)] tnum" role="status" aria-live="polite">
      {embedding && <>embedded {embedded} of {chunks}<span className="mx-2">·</span></>}
      {quietFor < 1
        ? <>working<span className="dots" aria-hidden="true" /></>
        : <>last update {quietFor}s ago</>}
    </div>
  );
}

function Elapsed({ from, running }: { from: number; running: boolean }): React.ReactElement {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [running]);
  const ms = Math.max(0, (running ? now : from) - from);
  const s = Math.floor(ms / 1000);
  return (
    <span className="tnum">
      {String(Math.floor(s / 60)).padStart(2, '0')}:{String(s % 60).padStart(2, '0')}.
      {Math.floor((ms % 1000) / 100)}
    </span>
  );
}

export interface CrawlLogProps {
  domain: string;
  /** Page budget this run was started with. */
  target: number;
  pages: PageEvent[];
  chunks: number;
  embedded: number;
  queued: number;
  stage: string;
  startedAt: number;
  lastEventAt: number;
  running: boolean;
}

const VISIBLE = 12;

/** A simple ramp, not a mask: older rows recede rather than being clipped. */
const FADE = [1, 1, 1, 1, 1, 0.62, 0.4, 0.2];
const fadeAt = (i: number): number => FADE[i] ?? 0.15;

export function CrawlLog(props: CrawlLogProps): React.ReactElement {
  const { domain, target, pages, chunks, embedded, queued, stage, startedAt, lastEventAt, running } = props;

  const recent = [...pages].reverse().slice(0, VISIBLE);

  const ok = pages.filter((p) => p.status === 'ok').length;
  const showEmbedded = stage === 'indexing' || (embedded > 0 && queued === 0);

  return (
    <>
      <div className="flex justify-between items-baseline gap-4 px-[18px] pt-4 pb-3 md:px-12 md:pt-[22px] md:pb-5">
        <span className="font-mono text-[13px] md:text-[14px] truncate">{domain}</span>
        <span className="flex items-baseline gap-4 font-mono text-[13px] md:text-[14px] text-[var(--muted)] shrink-0">
          {/* What the run is working towards. Without it the counters climb
              against nothing and a one-page crawl looks like it stalled. */}
          <span className="hidden sm:inline">
            {target === 1 ? 'landing page' : `up to ${target} pages`}
          </span>
          <Elapsed from={startedAt} running={running} />
        </span>
      </div>

      <div className="px-[18px] pb-5 md:px-12 md:pb-[30px] border-b rule flex flex-col gap-5 md:flex-row md:items-end md:justify-between md:gap-10">
        <div>
          <div className="flex items-end gap-1.5">
            <span className="text-[26px] md:text-[38px] font-medium tracking-[-0.028em] leading-none">
              {STAGE_LABEL[stage] ?? stage}
            </span>
            {running && (
              <span className="caret h-[22px] md:h-[34px] mb-[3px] md:mb-[5px]" aria-hidden="true" />
            )}
          </div>
          {running && (
            <Heartbeat chunks={chunks} embedded={embedded} stage={stage} lastEventAt={lastEventAt} />
          )}
        </div>

        <div className="flex justify-between md:justify-start gap-8 md:gap-[52px] md:pb-1.5" role="status" aria-live="polite">
          <Stat n={ok} label="pages read" />
          <Stat n={chunks} label="chunks built" />
          {showEmbedded
            ? <Stat n={embedded} label="embedded" />
            // On a one-page run nothing in the queue will ever be read, so it
            // is not "in queue" — it is what a later "read more" can reach.
            : <Stat n={queued} label={target === 1 ? 'pages found' : 'in queue'} />}
        </div>
      </div>

      <div className="flex-1 px-[18px] md:px-12 overflow-hidden" aria-label="Pages being read, newest first">
        {recent.length === 0 && (
          <div className="py-6 font-mono text-[13.5px] text-[var(--muted)]">
            waiting for the first page…
          </div>
        )}
        {recent.map((p, i) => {
          const index = pages.length - i;
          const isNewest = i === 0;
          const failed = p.status !== 'ok';
          return (
            <div
              key={`${p.url}-${index}`}
              className={`logrow ${isNewest ? 'logrow-new' : ''}`}
              style={{ opacity: fadeAt(i) }}
            >
              <span className={`font-mono tnum text-right ${isNewest ? 'text-[var(--accent)]' : 'text-[var(--muted)]'}`}>
                {index}
              </span>
              <span className="font-mono truncate" title={p.url}>{shortPath(p.url)}</span>
              <span
                className={`logtitle truncate ${failed ? 'text-[var(--flag)]' : 'text-[var(--muted)]'}`}
                title={p.title}
              >
                {failed ? statusNote(p.status) : p.title}
              </span>
              <span className={`font-mono tnum text-right ${failed ? 'text-[var(--flag)]' : 'text-[var(--muted)]'}`}>
                {failed ? '—' : p.charCount.toLocaleString()}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}

function statusNote(status: string): string {
  if (status === 'empty') return 'no readable text';
  if (status === 'skipped') return 'skipped';
  return 'could not read';
}

/** A counter at zero is not news, so it recedes to muted until it moves. */
function Stat({ n, label }: { n: number; label: string }): React.ReactElement {
  return (
    <div>
      <div
        className={`tnum text-[30px] md:text-[44px] font-semibold tracking-[-0.03em] leading-[.9] ${n === 0 ? 'text-[var(--muted)]' : ''}`}
      >
        {n}
      </div>
      <div className="text-[12px] text-[var(--muted)] mt-2">{label}</div>
    </div>
  );
}
