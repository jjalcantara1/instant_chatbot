import { describe, it, expect, vi, beforeEach } from 'vitest';

// DNS is mocked so these assertions are deterministic and offline.
vi.mock('node:dns', () => {
  const table: Record<string, { a: string[]; aaaa: string[] }> = {
    'example.com': { a: ['93.184.216.34'], aaaa: [] },
    'public-and-private.test': { a: ['93.184.216.34', '10.0.0.5'], aaaa: [] }, // split horizon
    'rebind.test': { a: ['127.0.0.1'], aaaa: [] },
    'metadata.test': { a: ['169.254.169.254'], aaaa: [] },
    'v6private.test': { a: [], aaaa: ['fc00::1'] },
    'mapped.test': { a: [], aaaa: ['::ffff:127.0.0.1'] },
    'nxdomain.test': { a: [], aaaa: [] },
    'dual.test': { a: ['1.1.1.1'], aaaa: ['2606:4700:4700::1111'] },
  };
  const resolve4 = async (h: string) => {
    const e = table[h];
    if (!e || e.a.length === 0) throw new Error('ENOTFOUND');
    return e.a;
  };
  const resolve6 = async (h: string) => {
    const e = table[h];
    if (!e || e.aaaa.length === 0) throw new Error('ENOTFOUND');
    return e.aaaa;
  };
  return { promises: { resolve4, resolve6 }, default: { promises: { resolve4, resolve6 } } };
});

const { guardUrl, isBlockedAddress } = await import('../src/crawl/ssrf.js');

describe('isBlockedAddress', () => {
  const blocked = [
    '169.254.169.254',   // AWS/GCP metadata
    '169.254.170.2',     // ECS task metadata
    '127.0.0.1', '127.1.2.3',
    '10.0.0.1', '10.255.255.255',
    '172.16.0.1', '172.31.255.255',
    '192.168.1.1',
    '100.64.0.1',        // CGNAT
    '0.0.0.0',
    '224.0.0.1',         // multicast
    '255.255.255.255',
    '198.18.0.1',
    '::1',
    '::',
    'fc00::1', 'fd12:3456::1',
    'fe80::1',
    '::ffff:127.0.0.1',  // IPv4-mapped loopback
    '::ffff:169.254.169.254',
    'ff02::1',
  ];
  for (const ip of blocked) {
    it(`blocks ${ip}`, () => expect(isBlockedAddress(ip)).toBe(true));
  }

  const allowed = [
    '8.8.8.8', '1.1.1.1', '93.184.216.34',
    '172.15.255.255',    // just below the RFC1918 /12
    '172.32.0.1',        // just above it
    '9.255.255.255', '11.0.0.0',
    '100.63.255.255', '100.128.0.0',  // CGNAT boundaries
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
  ];
  for (const ip of allowed) {
    it(`allows ${ip}`, () => expect(isBlockedAddress(ip)).toBe(false));
  }

  it('fails closed on garbage', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
    expect(isBlockedAddress('999.999.999.999')).toBe(true);
  });
});

describe('guardUrl', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects the AWS metadata endpoint by IP literal, before any DNS or request', async () => {
    const r = await guardUrl('http://169.254.169.254/latest/meta-data/');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('IP_LITERAL');
  });

  it('rejects localhost', async () => {
    const r = await guardUrl('http://localhost:8080/');
    expect(r.ok).toBe(false);
    // Caught by the blocklist or the internal-TLD rule; either way it never resolves.
    if (!r.ok) expect(['BLOCKED_DOMAIN', 'INTERNAL_TLD', 'BAD_PORT']).toContain(r.reason);
  });

  it('rejects a raw private IPv4 literal', async () => {
    const r = await guardUrl('http://10.0.0.1/');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('IP_LITERAL');
  });

  it('rejects an IPv6 literal', async () => {
    const r = await guardUrl('http://[::1]/');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('IP_LITERAL');
  });

  it('rejects a DNS name that resolves to loopback', async () => {
    const r = await guardUrl('https://rebind.test/');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('PRIVATE_IP');
  });

  it('rejects a DNS name that resolves to the metadata address', async () => {
    const r = await guardUrl('https://metadata.test/');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('PRIVATE_IP');
  });

  it('rejects when ANY resolved address is private, even if another is public', async () => {
    const r = await guardUrl('https://public-and-private.test/');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('PRIVATE_IP');
  });

  it('rejects a private IPv6 result', async () => {
    const r = await guardUrl('https://v6private.test/');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('PRIVATE_IP');
  });

  it('rejects an IPv4-mapped IPv6 result', async () => {
    const r = await guardUrl('https://mapped.test/');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('PRIVATE_IP');
  });

  it('rejects non-http schemes', async () => {
    for (const u of ['file:///etc/passwd', 'ftp://example.com/', 'gopher://example.com/']) {
      const r = await guardUrl(u);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('BAD_SCHEME');
    }
  });

  it('rejects non-standard ports', async () => {
    const r = await guardUrl('http://example.com:22/');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('BAD_PORT');
  });

  it('rejects internal TLDs', async () => {
    for (const u of ['http://printer.local/', 'http://wiki.internal/', 'http://api.lan/']) {
      const r = await guardUrl(u);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('INTERNAL_TLD');
    }
  });

  it('rejects over-long URLs', async () => {
    const r = await guardUrl('https://example.com/' + 'a'.repeat(2100));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('URL_TOO_LONG');
  });

  it('rejects blocklisted domains and their subdomains', async () => {
    for (const u of ['https://webhook.site/abc', 'https://x.y.ngrok.io/', 'https://bit.ly/abc']) {
      const r = await guardUrl(u);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('BLOCKED_DOMAIN');
    }
  });

  it('rejects a domain with no records', async () => {
    const r = await guardUrl('https://nxdomain.test/');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NO_ADDRESSES');
  });

  it('allows an ordinary public site', async () => {
    const r = await guardUrl('https://example.com/about');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.addresses).toContain('93.184.216.34');
  });

  it('allows a dual-stack public site and returns both families', async () => {
    const r = await guardUrl('https://dual.test/');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.addresses).toEqual(['1.1.1.1', '2606:4700:4700::1111']);
  });
});
