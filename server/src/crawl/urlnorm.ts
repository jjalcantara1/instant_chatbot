import { getDomain } from 'tldts';

const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|gbraid$|wbraid$|msclkid$|mc_cid$|mc_eid$|ref$|referrer$|source$|igshid$|_ga$|yclid$|si$)/i;

const SKIP_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods',
  'zip', 'gz', 'tar', 'rar', '7z', 'dmg', 'exe', 'pkg', 'deb', 'rpm',
  'jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'avif', 'ico', 'bmp', 'tiff',
  'mp4', 'webm', 'mov', 'avi', 'mkv', 'mp3', 'wav', 'ogg', 'flac', 'm4a',
  'css', 'js', 'mjs', 'json', 'xml', 'rss', 'atom', 'txt', 'csv',
  'woff', 'woff2', 'ttf', 'eot', 'otf', 'map',
]);

/**
 * Canonical form used for dedupe. Strips the fragment and tracking params,
 * lowercases the host, and drops a trailing slash so "/about" and "/about/"
 * are one page.
 */
export function normaliseUrl(input: string, base?: string): string | null {
  let u: URL;
  try { u = base ? new URL(input, base) : new URL(input); }
  catch { return null; }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  u.hash = '';
  u.username = '';
  u.password = '';
  u.hostname = u.hostname.toLowerCase().replace(/\.$/, '');

  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
    u.port = '';
  }

  const keep: Array<[string, string]> = [];
  for (const [k, v] of u.searchParams) {
    if (!TRACKING_PARAM.test(k)) keep.push([k, v]);
  }
  keep.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  u.search = '';
  for (const [k, v] of keep) u.searchParams.append(k, v);

  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '');
  }
  u.pathname = u.pathname.replace(/\/{2,}/g, '/');

  return u.toString();
}

export function hasSkippableExtension(urlStr: string): boolean {
  try {
    const path = new URL(urlStr).pathname;
    const last = path.split('/').pop() ?? '';
    const dot = last.lastIndexOf('.');
    if (dot === -1) return false;
    return SKIP_EXTENSIONS.has(last.slice(dot + 1).toLowerCase());
  } catch { return true; }
}

/**
 * Registrable domain via the public suffix list, so foo.co.uk groups correctly
 * instead of matching on a naive two-label suffix.
 *
 * allowPrivateDomains matters for scope safety, not just correctness: without
 * it, web.app / github.io / netlify.app / pages.dev are read as ordinary
 * domains, so a crawl seeded at one customer's site would treat every other
 * site on that shared suffix as same-domain and in scope.
 */
export function registrableDomain(urlStr: string): string | null {
  try { return getDomain(new URL(urlStr).hostname, { allowPrivateDomains: true }); }
  catch { return null; }
}

export function sameSite(a: string, b: string): boolean {
  const da = registrableDomain(a);
  const db = registrableDomain(b);
  return da !== null && da === db;
}
