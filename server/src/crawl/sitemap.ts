import { XMLParser } from 'fast-xml-parser';
import { safeFetch } from './fetcher.js';
import { normaliseUrl, sameSite, hasSkippableExtension } from './urlnorm.js';

const parser = new XMLParser({ ignoreAttributes: false, trimValues: true });

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Pull candidate URLs out of /sitemap.xml (plus any sitemaps robots.txt names).
 * Sitemap-first gives far better coverage than link-following alone, and it
 * gets us the real page list before the first HTML byte is parsed.
 *
 * Follows one level of sitemap index, capped, since this is a 25-page demo.
 */
export async function collectSitemapUrls(
  origin: string,
  extraSitemaps: string[] = [],
  limit = 300,
): Promise<string[]> {
  const roots = [new URL('/sitemap.xml', origin).toString(), ...extraSitemaps];
  const seen = new Set<string>();
  const out: string[] = [];
  const queue = [...new Set(roots)];
  let indexFetches = 0;

  while (queue.length > 0 && out.length < limit && indexFetches < 6) {
    const smUrl = queue.shift() as string;
    if (seen.has(smUrl)) continue;
    seen.add(smUrl);
    indexFetches++;

    const res = await safeFetch(smUrl, { allowAnyContentType: true, timeoutMs: 5000, maxBytes: 5 * 1024 * 1024 });
    if (!res.ok) continue;

    let doc: Record<string, unknown>;
    try { doc = parser.parse(res.html) as Record<string, unknown>; }
    catch { continue; }

    // A sitemap index points at more sitemaps.
    const index = doc['sitemapindex'] as { sitemap?: unknown } | undefined;
    if (index) {
      for (const entry of asArray(index.sitemap as Array<{ loc?: string }> | undefined)) {
        const loc = typeof entry?.loc === 'string' ? entry.loc : undefined;
        if (loc && sameSite(loc, origin)) queue.push(loc);
      }
      continue;
    }

    const urlset = doc['urlset'] as { url?: unknown } | undefined;
    if (!urlset) continue;

    for (const entry of asArray(urlset.url as Array<{ loc?: string }> | undefined)) {
      const loc = typeof entry?.loc === 'string' ? entry.loc : undefined;
      if (!loc) continue;
      const norm = normaliseUrl(loc);
      if (!norm) continue;
      if (!sameSite(norm, origin)) continue;
      if (hasSkippableExtension(norm)) continue;
      if (!out.includes(norm)) out.push(norm);
      if (out.length >= limit) break;
    }
  }

  return out;
}
