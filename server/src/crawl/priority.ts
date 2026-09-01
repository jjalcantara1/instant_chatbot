const HIGH_VALUE = /\/(about|about-us|services|service|pricing|price|plans|products|product|faq|faqs|contact|contact-us|team|work|portfolio|case-stud|solutions|how-it-works|features)(\/|$|-)/i;

const LOW_VALUE = /(\/blog\/20\d\d|\/news\/20\d\d|\/tag\/|\/tags\/|\/category\/|\/categories\/|\/author\/|\/archive|\/page\/\d+|\/comment|\/feed|\?replytocom)/i;

/**
 * Higher scores are crawled first. With a 25-page cap on a 400-page site this
 * decides whether the demo indexes the About section or 25 blog archive pages.
 */
export function scoreUrl(urlStr: string, rootUrl: string): number {
  let path: string;
  let rootPath: string;
  let sameHost: boolean;
  try {
    const u = new URL(urlStr);
    const r = new URL(rootUrl);
    path = u.pathname.replace(/\/+$/, '');
    rootPath = r.pathname.replace(/\/+$/, '');
    sameHost = u.hostname.toLowerCase() === r.hostname.toLowerCase();
  } catch { return 0; }

  if (sameHost && (path === rootPath || path === '')) return 100;

  const segments = path.split('/').filter(Boolean);
  const depth = segments.length;

  let score: number;
  if (depth <= 1) score = 50;
  else if (depth === 2) score = 30;
  else score = 10;

  // Same registrable domain but a different host is still in scope, just far
  // less likely to be the site the visitor meant. Without this, archived
  // subdomains (v1.docs, v2.docs) outrank the actual site's inner pages.
  if (!sameHost) score -= 40;

  if (HIGH_VALUE.test(path + '/')) score += 40;
  if (LOW_VALUE.test(urlStr)) score -= 30;

  // A query string on a crawlable page is usually a filter or a paginator.
  try { if (new URL(urlStr).search) score -= 10; } catch { /* ignore */ }

  return score;
}

/** Max-heap-ish priority queue. n is small (a few hundred), so a sorted splice is fine. */
export class PriorityQueue<T> {
  private items: Array<{ value: T; score: number }> = [];

  push(value: T, score: number): void {
    let lo = 0, hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.items[mid] as { score: number }).score >= score) lo = mid + 1;
      else hi = mid;
    }
    this.items.splice(lo, 0, { value, score });
  }

  pop(): T | undefined {
    return this.items.shift()?.value;
  }

  get size(): number { return this.items.length; }
}
