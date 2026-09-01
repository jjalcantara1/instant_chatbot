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
 * A missing or unreachable robots.txt is not a disallow, so we fail open.
 * A robots.txt that parses is honoured for `User-agent: *`.
 */
export async function fetchRobots(origin: string): Promise<RobotsRules> {
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
