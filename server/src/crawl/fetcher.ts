import { Agent, request } from 'undici';
import { isIP } from 'node:net';
import { config } from '../config.js';
import { guardUrl, isBlockedAddress } from './ssrf.js';

/**
 * Hostnames the guard has cleared, mapped to the exact addresses it vetted.
 * The dispatcher below will only ever connect to an address from this map,
 * which closes the DNS-rebinding window between validation and connect.
 */
const vetted = new Map<string, string[]>();

function pin(hostname: string, addresses: string[]): void {
  vetted.set(hostname.toLowerCase(), addresses);
}

type LookupCb = (
  err: NodeJS.ErrnoException | null,
  address?: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

function pinnedLookup(hostname: string, options: { all?: boolean }, cb: LookupCb): void {
  const addrs = vetted.get(hostname.toLowerCase());
  if (!addrs || addrs.length === 0) {
    cb(Object.assign(new Error(`refusing to connect to unvetted host ${hostname}`), { code: 'EACCES' }));
    return;
  }
  // Re-check at connect time. Cheap, and it means a bug upstream cannot
  // turn into an outbound request to a private address.
  const safe = addrs.filter((a) => !isBlockedAddress(a));
  if (safe.length === 0) {
    cb(Object.assign(new Error(`all addresses for ${hostname} are private`), { code: 'EACCES' }));
    return;
  }
  if (options.all) {
    cb(null, safe.map((a) => ({ address: a, family: isIP(a) })));
  } else {
    const first = safe[0] as string;
    cb(null, first, isIP(first));
  }
}

const agent = new Agent({
  connect: { lookup: pinnedLookup as never, timeout: config.perRequestTimeoutMs },
  bodyTimeout: config.perRequestTimeoutMs,
  headersTimeout: config.perRequestTimeoutMs,
  connections: 32,
});

const HTML_TYPES = ['text/html', 'application/xhtml+xml'];

export type FetchFailure =
  | 'BLOCKED' | 'TIMEOUT' | 'NETWORK' | 'HTTP_ERROR'
  | 'NOT_HTML' | 'TOO_MANY_REDIRECTS' | 'TOO_LARGE';

export interface FetchOk {
  ok: true;
  finalUrl: string;
  html: string;
  status: number;
  contentType: string;
  truncated: boolean;
}
export interface FetchErr { ok: false; reason: FetchFailure; detail: string; status?: number; }
export type FetchResult = FetchOk | FetchErr;

export interface FetchOptions {
  /** Accept non-HTML bodies (used for robots.txt and sitemap.xml). */
  allowAnyContentType?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Fetch one URL with the SSRF guard applied to the initial URL and to every
 * redirect hop. Redirects are followed manually for exactly that reason.
 */
export async function safeFetch(startUrl: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? config.perRequestTimeoutMs;
  const maxBytes = opts.maxBytes ?? config.maxBodyBytes;
  let current = startUrl;

  for (let hop = 0; hop <= config.maxRedirects; hop++) {
    const guard = await guardUrl(current);
    if (!guard.ok) {
      return { ok: false, reason: 'BLOCKED', detail: guard.detail };
    }
    pin(guard.url.hostname, guard.addresses);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await request(guard.url.toString(), {
        method: 'GET',
        dispatcher: agent,
        signal: controller.signal,
        // undici's request() does not follow redirects; each hop is re-validated below.
        headers: {
          'user-agent': config.userAgent,
          accept: opts.allowAnyContentType
            ? '*/*'
            : 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
          'accept-language': 'en',
        },
      });

      const status = res.statusCode;

      if (status >= 300 && status < 400) {
        const loc = res.headers['location'];
        const locStr = Array.isArray(loc) ? loc[0] : loc;
        await res.body.dump();
        if (!locStr) {
          return { ok: false, reason: 'HTTP_ERROR', detail: `Redirect with no target (${status}).`, status };
        }
        let next: string;
        try { next = new URL(locStr, guard.url).toString(); }
        catch { return { ok: false, reason: 'HTTP_ERROR', detail: 'Redirect target is not a valid URL.', status }; }
        current = next;
        continue; // loop re-runs the guard on the new URL
      }

      if (status >= 400) {
        await res.body.dump();
        return { ok: false, reason: 'HTTP_ERROR', detail: `The page returned HTTP ${status}.`, status };
      }

      const ctRaw = res.headers['content-type'];
      const contentType = ((Array.isArray(ctRaw) ? ctRaw[0] : ctRaw) ?? '').toLowerCase();

      if (!opts.allowAnyContentType) {
        const base = contentType.split(';')[0]?.trim() ?? '';
        if (!HTML_TYPES.includes(base)) {
          await res.body.dump();
          return { ok: false, reason: 'NOT_HTML', detail: `Not an HTML page (${base || 'unknown type'}).`, status };
        }
      }

      // Read with a hard byte cap; abort the stream rather than buffering a huge body.
      const chunks: Buffer[] = [];
      let total = 0;
      let truncated = false;
      for await (const chunk of res.body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike);
        total += buf.length;
        if (total > maxBytes) {
          chunks.push(buf.subarray(0, Math.max(0, buf.length - (total - maxBytes))));
          truncated = true;
          res.body.destroy(); // genuine early abort: we do not want the rest
          break;
        }
        chunks.push(buf);
      }

      return {
        ok: true,
        finalUrl: guard.url.toString(),
        html: Buffer.concat(chunks).toString('utf8'),
        status,
        contentType,
        truncated,
      };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.name === 'AbortError' || e.code === 'UND_ERR_HEADERS_TIMEOUT' || e.code === 'UND_ERR_BODY_TIMEOUT' || e.code === 'UND_ERR_CONNECT_TIMEOUT') {
        return { ok: false, reason: 'TIMEOUT', detail: 'That page took too long to respond.' };
      }
      if (e.code === 'EACCES') {
        return { ok: false, reason: 'BLOCKED', detail: e.message };
      }
      return { ok: false, reason: 'NETWORK', detail: e.message || 'The request failed.' };
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, reason: 'TOO_MANY_REDIRECTS', detail: `More than ${config.maxRedirects} redirects.` };
}

export async function closeFetcher(): Promise<void> {
  await agent.close();
}
