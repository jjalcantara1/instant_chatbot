import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * npm workspaces run every server script with cwd=server/, but .env and data/
 * live at the repo root. Resolving either against cwd silently misses them —
 * the keys simply never load — so anchor both to the root instead.
 */
function findProjectRoot(): string {
  const starts = [dirname(fileURLToPath(import.meta.url)), process.cwd()];
  for (const marker of ['.env', 'package-lock.json']) {
    for (const start of starts) {
      let dir = start;
      for (let hops = 0; hops < 6; hops++) {
        if (existsSync(resolve(dir, marker))) return dir;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  }
  return process.cwd();
}

const projectRoot = findProjectRoot();

// Never overrides what is already set, so systemd's EnvironmentFile still wins.
loadEnv({ path: resolve(projectRoot, '.env'), quiet: true });

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

/**
 * The similarity floor in §6.5 step 6 is what stops an off-site question being
 * answered fluently and wrongly, and the raw cosine range it judges is a
 * property of the embedding model, not of the site.
 *
 * Measured on kleiosoftware.com (8 pages / 142 chunks, 5 answerable + 5 absent
 * questions), voyage-3-lite separates cleanly anywhere in 0.35-0.375, while the
 * 0.25 that suits text-embedding-3-small lets 4 of 5 absent questions through.
 * Re-measure before changing embedder; override with MIN_COSINE.
 */
function defaultMinCosine(provider: string): number {
  if (provider === 'voyage') return 0.35;
  // Provisional until `npm run eval` is run against this embedder: the floor is
  // a property of the model's cosine distribution and does not carry over.
  if (provider === 'gemini') return 0.5;
  if (provider === 'hash') return 0.5;
  return 0.25;
}

const embeddingProvider = str('EMBEDDING_PROVIDER', 'openai');
const chatProvider = str('CHAT_PROVIDER', 'anthropic');
const chatModelRaw = str('CHAT_MODEL');

/**
 * Which chat model actually runs. CHAT_MODEL is provider-specific, so a model
 * left over from the other provider would otherwise be sent verbatim and 404;
 * fall back to the provider's own default instead of failing at request time.
 */
export function resolveChat(): { provider: string; model: string } {
  const configured = chatModelRaw;
  if (chatProvider === 'gemini') {
    return { provider: 'gemini', model: configured.startsWith('gemini') ? configured : 'gemini-3.5-flash-lite' };
  }
  return { provider: 'anthropic', model: configured.startsWith('claude') ? configured : 'claude-haiku-4-5-20251001' };
}

export const config = {
  port: num('PORT', 8080),
  databasePath: resolve(projectRoot, str('DATABASE_PATH', './data/sitechat.db')),

  chatProvider,
  anthropicApiKey: str('ANTHROPIC_API_KEY'),
  geminiApiKey: str('GEMINI_API_KEY') || str('GOOGLE_API_KEY'),
  // Overridable so tests can point at a loopback server, and so a proxy or
  // gateway can be put in front without touching code.
  geminiBaseUrl: str('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com'),
  // Required only for identity-linked keys, which reject every request without
  // it. Sent as a header when set; omitted entirely otherwise. WORKSPACE_ID is
  // accepted as an alias so an existing environment keeps working.
  anthropicWorkspaceId: str('ANTHROPIC_WORKSPACE_ID') || str('WORKSPACE_ID'),
  // Verified against the live Models API: both this pinned snapshot and the
  // dateless alias `claude-haiku-4-5` resolve to Claude Haiku 4.5.
  chatModel: resolveChat().model,

  embeddingProvider: embeddingProvider as 'openai' | 'voyage' | 'gemini' | 'hash',
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
  minCosine: num('MIN_COSINE', defaultMinCosine(embeddingProvider)),
  minChunksForAnswer: 2,
  embeddingDims: 1536,

  // Defaults suit a paid provider tier and hit the time budget in §4. A
  // free/low-quota key needs smaller batches, no parallelism, and a gap between
  // calls; that trades the 25s target for completing at all.
  embeddingBatchSize: num('EMBEDDING_BATCH_SIZE', 100),
  embeddingConcurrency: num('EMBEDDING_CONCURRENCY', 4),
  embeddingMinIntervalMs: num('EMBEDDING_MIN_INTERVAL_MS', 0),
} as const;

export type Config = typeof config;
