import { useEffect, useRef, useState } from 'react';
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
    const p = u.pathname === '/' ? '/' : u.pathname.replace(/\/$/, '');
    return p;
  } catch { return url; }
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
  pages: PageEvent[];
  chunks: number;
  embedded: number;
  queued: number;
  stage: string;
  startedAt: number;
  running: boolean;
}

const VISIBLE = 12;

export function CrawlLog(props: CrawlLogProps): React.ReactElement {
  const { domain, pages, chunks, embedded, queued, stage, startedAt, running } = props;
  const seenCount = useRef(0);

  // Newest first. Only rows past the previous render animate.
  const recent = [...pages].reverse().slice(0, VISIBLE);
  const previouslySeen = seenCount.current;
  useEffect(() => { seenCount.current = pages.length; });

  const ok = pages.filter((p) => p.status === 'ok').length;

  return (
    <div className="w-full max-w-3xl mx-auto">
      <div className="flex items-baseline justify-between gap-4 px-3 pb-2">
        <span className="font-mono text-[13px] truncate">{domain}</span>
        <span className="font-mono text-[13px] text-[var(--muted)]">
          <Elapsed from={startedAt} running={running} />
        </span>
      </div>

      <div className="border-t rule" />

      <div className="px-3 py-2 font-mono text-[13px]">
        <span className="text-[var(--signal)]">{STAGE_LABEL[stage] ?? stage}</span>
        {stage === 'indexing' && chunks > 0 && (
          <span className="text-[var(--muted)]"> · {embedded}/{chunks} embedded</span>
        )}
        {running && <span className="cursor text-[var(--signal)]" aria-hidden="true"> ▌</span>}
      </div>

      <div className="border-t rule" />

      <div className="grid grid-cols-3 gap-3 px-3 py-3" role="status" aria-live="polite">
        <Stat n={ok} label="pages read" />
        <Stat n={chunks} label="chunks built" />
        {stage === 'indexing' || (embedded > 0 && queued === 0)
          ? <Stat n={embedded} label="embedded" />
          : <Stat n={queued} label="in queue" />}
      </div>

      <div className="border-t rule" />

      <div
        className="bg-[var(--card)] border-b rule overflow-hidden"
        aria-label="Pages being read, newest first"
      >
        {recent.length === 0 && (
          <div className="px-3 py-6 font-mono text-[13px] text-[var(--muted)]">
            waiting for the first page…
          </div>
        )}
        {recent.map((p, i) => {
          const index = pages.length - i;
          const isNew = index > previouslySeen;
          const faded = i >= VISIBLE - 3;
          return (
            <div
              key={`${p.url}-${index}`}
              className={`logrow ${isNew ? 'logrow-new' : ''}`}
              style={faded ? { opacity: 1 - (i - (VISIBLE - 4)) * 0.22 } : undefined}
            >
              <span className="text-[var(--muted)] text-right">{index}</span>
              <span className="truncate" title={p.url}>
                {shortPath(p.url)}
              </span>
              <span className="logtitle truncate text-[var(--muted)]" title={p.title}>
                {p.status === 'ok' ? p.title : statusNote(p.status)}
              </span>
              <span
                className={`text-right ${p.status === 'ok' ? 'text-[var(--good)]' : 'text-[var(--flag)]'}`}
              >
                {p.status === 'ok' ? p.charCount.toLocaleString() : '—'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function statusNote(status: string): string {
  if (status === 'empty') return 'no readable text';
  if (status === 'skipped') return 'skipped';
  return 'could not read';
}

function Stat({ n, label }: { n: number; label: string }): React.ReactElement {
  return (
    <div>
      <div className="font-mono tnum text-[26px] leading-none">{n}</div>
      <div className="font-mono text-[12px] text-[var(--muted)] mt-1">{label}</div>
    </div>
  );
}
