import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { config } from '../config.js';
import { getDb } from '../db.js';

/** Raw IPs are never stored. The salt makes the hashes non-enumerable. */
export function hashIp(ip: string): string {
  return createHash('sha256').update(config.ipHashSalt).update(ip).digest('hex').slice(0, 32);
}

export function clientIp(req: Request): string {
  // Caddy sits in front in production and sets X-Forwarded-For.
  const fwd = req.headers['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : fwd;
  if (first) {
    const ip = first.split(',')[0]?.trim();
    if (ip) return ip;
  }
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export interface LimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  retryAfterSeconds: number;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Read the current allowance WITHOUT spending any of it.
 *
 * Checking and consuming are separate on purpose. These limits exist to cap
 * cost, and a URL that fails validation costs nothing — if a rejection spent a
 * slot, two typos would lock a visitor out for an hour having indexed nothing.
 * Callers peek first, do the work, then consume only on success.
 */
export function peekRateLimit(ip: string, action: 'index' | 'message', limit: number): LimitResult {
  const db = getDb();
  const now = Date.now();
  const windowStart = Math.floor(now / HOUR_MS) * HOUR_MS;

  const row = db.prepare(
    'SELECT count FROM rate_limits WHERE ip_hash = ? AND action = ? AND window_start = ?',
  ).get(hashIp(ip), action, windowStart) as { count: number } | undefined;

  const used = row?.count ?? 0;
  return {
    allowed: used < limit,
    remaining: Math.max(0, limit - used),
    limit,
    retryAfterSeconds: Math.ceil((windowStart + HOUR_MS - now) / 1000),
  };
}

/** Spend one unit of the allowance. Call only once the work has been accepted. */
export function consumeRateLimit(ip: string, action: 'index' | 'message'): void {
  const windowStart = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  getDb().prepare(
    `INSERT INTO rate_limits (ip_hash, action, window_start, count) VALUES (?, ?, ?, 1)
     ON CONFLICT(ip_hash, action, window_start) DO UPDATE SET count = count + 1`,
  ).run(hashIp(ip), action, windowStart);
}

/** Global daily cap on index runs, so one busy day cannot run up a bill. */
export function checkDailyCap(): { allowed: boolean; used: number; cap: number } {
  const db = getDb();
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  const row = db.prepare(
    'SELECT COUNT(*) AS n FROM sessions WHERE created_at >= ?',
  ).get(dayStart.getTime()) as { n: number };

  return { allowed: row.n < config.dailyIndexCap, used: row.n, cap: config.dailyIndexCap };
}
