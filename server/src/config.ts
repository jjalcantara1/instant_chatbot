import 'dotenv/config';
import { resolve } from 'node:path';

function str(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    return '';
  }
  return v;
}

function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: num('PORT', 8080),
  databasePath: resolve(process.cwd(), str('DATABASE_PATH', './data/sitechat.db')),

  anthropicApiKey: str('ANTHROPIC_API_KEY'),
  // Pinned snapshot. The dateless alias `claude-haiku-4-5` resolves to the same model.
  chatModel: str('CHAT_MODEL', 'claude-haiku-4-5-20251001'),

  embeddingProvider: str('EMBEDDING_PROVIDER', 'openai') as 'openai' | 'voyage',
  openaiApiKey: str('OPENAI_API_KEY'),
  voyageApiKey: str('VOYAGE_API_KEY'),
  embeddingModel: str('EMBEDDING_MODEL', 'text-embedding-3-small'),

  ipHashSalt: str('IP_HASH_SALT', 'dev-salt-do-not-use-in-prod'),
  adminToken: str('ADMIN_TOKEN'),

  maxPages: num('MAX_PAGES', 25),
  crawlTimeoutMs: num('CRAWL_TIMEOUT_MS', 45_000),
  dailyIndexCap: num('DAILY_INDEX_CAP', 200),
  concurrentCrawls: num('CONCURRENT_CRAWLS', 3),
  indexPerIpPerHour: num('INDEX_PER_IP_PER_HOUR', 3),
  messagesPerIpPerHour: num('MESSAGES_PER_IP_PER_HOUR', 60),
  maxMessagesPerSession: num('MAX_MESSAGES_PER_SESSION', 20),

  publicWidgetOrigin: str('PUBLIC_WIDGET_ORIGIN', 'http://localhost:5173'),

  // Crawl tuning (not visitor-configurable)
  crawlConcurrency: 6,
  perRequestTimeoutMs: 8_000,
  maxBodyBytes: 2 * 1024 * 1024,
  maxRedirects: 3,
  maxUrlLength: 2048,
  userAgent: 'KleioSiteChat/1.0 (+https://kleio-software.web.app/site-chat)',
  sessionTtlMs: 24 * 60 * 60 * 1000,

  // Retrieval
  topK: 6,
  candidateK: 20,
  rrfK: 60,
  minCosine: 0.25,
  minChunksForAnswer: 2,
  embeddingDims: 1536,
  embeddingBatchSize: 100,
} as const;

export type Config = typeof config;
