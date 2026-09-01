import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The property under test: safeFetch re-runs the REAL SSRF guard on every
 * redirect hop, so a chain that ends at a private address fails closed.
 *
 * Hop 1 has to be reachable from the test, which means a loopback server, and
 * loopback is exactly what the guard exists to refuse. So two narrow seams are
 * opened for the FIRST hop only:
 *   - guardUrl approves the synthetic host `seed.test`, and delegates every
 *     other URL to the real implementation.
 *   - isBlockedAddress permits 127.0.0.1, and delegates every other address.
 * Hop 2 is therefore judged entirely by the real, unmodified guard.
 */
let serverPort = 0;

vi.mock('../src/crawl/ssrf.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/crawl/ssrf.js')>();
  return {
    ...real,
    guardUrl: vi.fn(async (input: string) => {
      let host = '';
      try { host = new URL(input).hostname; } catch { /* fall through to real */ }
      if (host === 'seed.test') {
        return { ok: true, url: new URL(input), addresses: ['127.0.0.1'] };
      }
      return real.guardUrl(input);
    }),
    isBlockedAddress: vi.fn((addr: string) =>
      addr === '127.0.0.1' ? false : real.isBlockedAddress(addr)),
  };
});

const { safeFetch } = await import('../src/crawl/fetcher.js');
const ssrf = await import('../src/crawl/ssrf.js');

let server: Server;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/to-metadata') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    } else if (url === '/to-private-host') {
      res.writeHead(302, { location: 'http://10.0.0.1/admin' });
      res.end();
    } else if (url === '/hop1') {
      res.writeHead(302, { location: `http://seed.test:${serverPort}/hop2` });
      res.end();
    } else if (url === '/hop2') {
      res.writeHead(302, { location: 'http://[::1]/' });
      res.end();
    } else if (url === '/loop') {
      res.writeHead(302, { location: `http://seed.test:${serverPort}/loop` });
      res.end();
    } else if (url === '/ok') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>Fine</title></head><body><p>Hello there.</p></body></html>');
    } else {
      res.writeHead(404); res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  serverPort = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const seed = (path: string): string => `http://seed.test:${serverPort}${path}`;

describe('redirect re-validation', () => {
  it('control: a normal 200 on the approved seed host succeeds', async () => {
    const res = await safeFetch(seed('/ok'));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.html).toContain('Hello there');
  });

  it('blocks a redirect to the cloud metadata address', async () => {
    const res = await safeFetch(seed('/to-metadata'));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('BLOCKED');
  });

  it('blocks a redirect to an RFC1918 address', async () => {
    const res = await safeFetch(seed('/to-private-host'));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('BLOCKED');
  });

  it('blocks a private address reached on the second hop, not just the first', async () => {
    const res = await safeFetch(seed('/hop1'));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('BLOCKED');
  });

  it('consults the real guard once per hop', async () => {
    vi.mocked(ssrf.guardUrl).mockClear();
    await safeFetch(seed('/hop1'));
    const seen = vi.mocked(ssrf.guardUrl).mock.calls.map((c) => c[0]);
    expect(seen).toHaveLength(3); // /hop1, /hop2, then the ::1 target
    expect(seen[2]).toContain('::1');
  });

  it('gives up on a redirect loop rather than following forever', async () => {
    const res = await safeFetch(seed('/loop'));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('TOO_MANY_REDIRECTS');
  });
});
