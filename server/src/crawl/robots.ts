import robotsParser from 'robots-parser';
import { safeFetch } from './fetcher.js';
import { config } from '../config.js';

export interface RobotsRules {
  isAllowed(url: string): boolean;
  sitemaps: string[];
  /** True when robots.txt was fetched and parsed; false means we failed open. */
  loaded: boolean;
}

const ALLOW_ALL: RobotsRules = { isAllowed: () => true, sitemaps: [], loaded: false };

/**
 * One robots.txt per origin per run, not per call site.
 *
 * `createSession` checks robots before it will create a session at all, then
 * `crawl` needs the same rules again, and an expansion pass needs them a third
 * time. Without this every index pays two or three round trips for one
 * document that cannot have changed in between. Entries are short-lived so a
 * site that tightens its rules is still honoured within the minute.
 */
const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 200;
const cache = new Map<string, { at: number; rules: Promise<RobotsRules> }>();

function cacheKey(origin: string): string {
  try { return new URL(origin).origin; } catch { return origin; }
}

export function clearRobotsCache(): void { cache.clear(); }

/**
 * A missing or unreachable robots.txt is not a disallow, so we fail open.
 * A robots.txt that parses is honoured for `User-agent: *`.
 */
export async function fetchRobots(origin: string): Promise<RobotsRules> {
  const key = cacheKey(origin);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return await hit.rules;

  // Store the promise, not the result, so two crawls starting at once on the
  // same origin share one fetch rather than racing to make two.
  const rules = loadRobots(origin);
  cache.set(key, { at: Date.now(), rules });
  if (cache.size > MAX_ENTRIES) {
    for (const [k, v] of cache) {
      if (Date.now() - v.at >= TTL_MS) cache.delete(k);
    }
    // Still oversized means everything is fresh; drop the oldest insertions.
    while (cache.size > MAX_ENTRIES) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
  return await rules;
}

async function loadRobots(origin: string): Promise<RobotsRules> {
  const robotsUrl = new URL('/robots.txt', origin).toString();

  const res = await safeFetch(robotsUrl, {
    allowAnyContentType: true,
    timeoutMs: 3000,
    maxBytes: 512 * 1024,
  });

  if (!res.ok) return ALLOW_ALL;

  try {
    const parsed = robotsParser(robotsUrl, res.html);
    const sitemaps = parsed.getSitemaps().filter((s) => typeof s === 'string');
    return {
      isAllowed: (url: string) => parsed.isAllowed(url, config.userAgent) !== false,
      sitemaps,
      loaded: true,
    };
  } catch {
    return ALLOW_ALL;
  }
}
