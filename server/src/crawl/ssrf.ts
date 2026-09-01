import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { config } from '../config.js';

export type GuardFailure =
  | 'BAD_SCHEME' | 'IP_LITERAL' | 'BAD_PORT' | 'URL_TOO_LONG'
  | 'INTERNAL_TLD' | 'DNS_FAIL' | 'PRIVATE_IP' | 'BLOCKED_DOMAIN' | 'NO_ADDRESSES';

export interface GuardOk { ok: true; url: URL; addresses: string[]; }
export interface GuardErr { ok: false; reason: GuardFailure; detail: string; }
export type GuardResult = GuardOk | GuardErr;

/** IPv4 CIDRs that must never be fetched. Superset of the spec list. */
const V4_BLOCKS: Array<[string, number]> = [
  ['0.0.0.0', 8],        // "this network"
  ['10.0.0.0', 8],       // RFC1918
  ['100.64.0.0', 10],    // CGNAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local, where cloud metadata lives
  ['172.16.0.0', 12],    // RFC1918
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // TEST-NET-1
  ['192.168.0.0', 16],   // RFC1918
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // TEST-NET-2
  ['203.0.113.0', 24],   // TEST-NET-3
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved / broadcast
];

/** IPv6 CIDRs that must never be fetched. */
const V6_BLOCKS: Array<[string, number]> = [
  ['::', 128],           // unspecified
  ['::1', 128],          // loopback
  ['::ffff:0:0', 96],    // IPv4-mapped; a resolver returning these is a bypass vector
  ['fc00::', 7],         // unique local
  ['fe80::', 10],        // link-local
  ['ff00::', 8],         // multicast
  ['2001:db8::', 32],    // documentation
];

const INTERNAL_SUFFIXES = ['.local', '.internal', '.localhost', '.home.arpa', '.lan'];

function v4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

/** Expand an IPv6 string to its 16 raw bytes. Handles "::" and a trailing dotted quad. */
function v6ToBytes(ip: string): Uint8Array | null {
  let s = ip.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);

  let tailBytes: number[] = [];
  const lastColon = s.lastIndexOf(':');
  if (lastColon === -1) return null;
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const n = v4ToInt(tail);
    if (n === null) return null;
    tailBytes = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    s = s.slice(0, lastColon + 1) + '0:0';
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  const head = parseGroups(halves[0] ?? '');
  if (head === null) return null;

  let groups: number[];
  if (halves.length === 2) {
    const back = parseGroups(halves[1] ?? '');
    if (back === null) return null;
    const fill = 8 - head.length - back.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...back];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => { bytes[i * 2] = (g >>> 8) & 255; bytes[i * 2 + 1] = g & 255; });
  if (tailBytes.length === 4) bytes.set(tailBytes, 12);
  return bytes;
}

function v4InBlock(ip: number, base: string, bits: number): boolean {
  const b = v4ToInt(base);
  if (b === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return ((ip & mask) >>> 0) === ((b & mask) >>> 0);
}

function v6InBlock(ip: Uint8Array, base: string, bits: number): boolean {
  const b = v6ToBytes(base);
  if (!b) return false;
  const full = Math.floor(bits / 8);
  for (let i = 0; i < full; i++) if (ip[i] !== b[i]) return false;
  const rem = bits % 8;
  if (rem === 0) return true;
  const mask = (0xff << (8 - rem)) & 0xff;
  return ((ip[full] ?? 0) & mask) === ((b[full] ?? 0) & mask);
}

/** True when an address literal must never be connected to. Unparseable means blocked. */
export function isBlockedAddress(addr: string): boolean {
  const kind = isIP(addr);
  if (kind === 4) {
    const n = v4ToInt(addr);
    if (n === null) return true;
    return V4_BLOCKS.some(([b, bits]) => v4InBlock(n, b, bits));
  }
  if (kind === 6) {
    const bytes = v6ToBytes(addr);
    if (!bytes) return true;
    return V6_BLOCKS.some(([b, bits]) => v6InBlock(bytes, b, bits));
  }
  return true; // not an IP at all: caller misuse, fail closed
}

let blockedDomains: Set<string> | null = null;

function loadBlockedDomains(): Set<string> {
  if (blockedDomains) return blockedDomains;
  const set = new Set<string>();
  for (const candidate of ['config/blocked-domains.txt', 'server/config/blocked-domains.txt']) {
    try {
      const raw = readFileSync(pathResolve(process.cwd(), candidate), 'utf8');
      for (const line of raw.split('\n')) {
        const t = line.trim().toLowerCase();
        if (t && !t.startsWith('#')) set.add(t);
      }
      break;
    } catch { /* try the next location */ }
  }
  blockedDomains = set;
  return set;
}

export function isBlockedDomain(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  const list = loadBlockedDomains();
  if (list.has(h)) return true;
  const parts = h.split('.');
  for (let i = 1; i < parts.length; i++) {
    if (list.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

/**
 * Full guard. Runs before any network request and again on every redirect hop.
 * Fails closed: anything it cannot positively verify is rejected.
 */
export async function guardUrl(input: string): Promise<GuardResult> {
  if (input.length > config.maxUrlLength) {
    return { ok: false, reason: 'URL_TOO_LONG', detail: 'That URL is longer than ' + config.maxUrlLength + ' characters.' };
  }

  let url: URL;
  try { url = new URL(input); }
  catch { return { ok: false, reason: 'BAD_SCHEME', detail: 'That is not a valid URL.' }; }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'BAD_SCHEME', detail: 'Only http and https addresses can be indexed.' };
  }

  const port = url.port;
  if (port !== '' && port !== '80' && port !== '443') {
    return { ok: false, reason: 'BAD_PORT', detail: 'Only ports 80 and 443 are allowed.' };
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  // The URL parser keeps IPv6 hosts in bracket form; strip them for the literal check.
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

  if (isIP(bare) !== 0) {
    return { ok: false, reason: 'IP_LITERAL', detail: 'Enter a domain name, not a raw IP address.' };
  }

  if (INTERNAL_SUFFIXES.some((s) => hostname === s.slice(1) || hostname.endsWith(s))) {
    return { ok: false, reason: 'INTERNAL_TLD', detail: 'That hostname points at a private network.' };
  }

  if (isBlockedDomain(hostname)) {
    return { ok: false, reason: 'BLOCKED_DOMAIN', detail: 'That domain is not available in this demo.' };
  }

  const [a, aaaa] = await Promise.all([
    dns.resolve4(hostname).catch(() => [] as string[]),
    dns.resolve6(hostname).catch(() => [] as string[]),
  ]);
  const addresses = [...a, ...aaaa];

  if (addresses.length === 0) {
    return { ok: false, reason: 'NO_ADDRESSES', detail: 'That domain could not be resolved.' };
  }

  // ANY private address disqualifies the host, not just the first one.
  if (addresses.some(isBlockedAddress)) {
    return { ok: false, reason: 'PRIVATE_IP', detail: 'That hostname resolves to a private network address.' };
  }

  return { ok: true, url, addresses };
}
