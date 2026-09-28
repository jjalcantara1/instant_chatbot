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
 * The similarity floor: below it a chunk is treated as unrelated to the
 * question, and a question with nothing above it is refused without calling
 * the model. The raw cosine range it judges is a property of the embedding
 * model, not of the site.
 *
 * It used to be expected to separate answerable questions from absent ones on
 * its own. Re-measured on kleiosoftware.com (17 pages, 30+ questions), it
 * cannot: with voyage-3-lite the chunk holding a one-line fact ranks first at
 * 0.25-0.34, while absent questions that name the brand score up to 0.49. At
 * 0.35 the landing-page index refused its own email address. So for voyage the
 * floor is now 0.25 - low enough to let single-sentence facts through, high
 * enough that plainly unrelated questions are still refused for free - and the
 * model, shown the excerpts, decides the rest. `npm run eval` is what holds
 * that line: every absent question must come back without a citation.
 * Re-measure before changing embedder; override with MIN_COSINE.
 */
function defaultMinCosine(provider: string): number {
  if (provider === 'voyage') return 0.25;
  // bge-small-en-v1.5 packs everything into a narrow high band: the weakest
  // real answer measured 0.479, the rest 0.535 and up, while questions no site
  // like this answers ("what's the weather tomorrow?") land at 0.45-0.55. So
  // almost every question reaches the model, which refuses what the excerpts
  // do not answer; this floor only catches the most unrelated.
  if (provider === 'local') return 0.45;
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

  embeddingProvider: embeddingProvider as 'openai' | 'voyage' | 'gemini' | 'local' | 'hash',
  openaiApiKey: str('OPENAI_API_KEY'),
  voyageApiKey: str('VOYAGE_API_KEY'),
  embeddingModel: str('EMBEDDING_MODEL', 'text-embedding-3-small'),
  /**
   * Where EMBEDDING_PROVIDER=local keeps its downloaded model. Next to the
   * database by default, because that is the one directory the systemd unit
   * lets the service write; transformers.js would otherwise try node_modules.
   */
  embeddingCacheDir: str('EMBEDDING_CACHE_DIR')
    ? resolve(projectRoot, str('EMBEDDING_CACHE_DIR'))
    : resolve(dirname(resolve(projectRoot, str('DATABASE_PATH', './data/sitechat.db'))), 'models'),

  ipHashSalt: str('IP_HASH_SALT', 'dev-salt-do-not-use-in-prod'),
  adminToken: str('ADMIN_TOKEN'),

  /**
   * What a visitor gets without asking for more. One page is the landing page
   * and nothing else: a single fetch, no sitemap round trips, one embedding
   * batch. That is the difference between a demo that answers in seconds and
   * one the visitor abandons — everything past the landing page is opt-in,
   * either up front or by expanding the session afterwards.
   */
  defaultPages: num('DEFAULT_PAGES', 1),
  /** Ceiling on what a visitor may ask for, in one pass or cumulatively. */
  maxPages: num('MAX_PAGES', 25),
  /** Page counts offered in the UI. Anything in 1..maxPages is accepted. */
  pageChoices: [1, 5, 15, 25],
  /** How many more pages one "read more" costs, when not given explicitly. */
  expandStep: num('EXPAND_STEP', 5),

  crawlTimeoutMs: num('CRAWL_TIMEOUT_MS', 45_000),
  dailyIndexCap: num('DAILY_INDEX_CAP', 200),
  concurrentCrawls: num('CONCURRENT_CRAWLS', 3),
  indexPerIpPerHour: num('INDEX_PER_IP_PER_HOUR', 3),
  expandsPerIpPerHour: num('EXPANDS_PER_IP_PER_HOUR', 10),
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
  // One. A fact a page states once - an email address, a call length - lives
  // in exactly one chunk, and requiring a second refused it every time.
  minChunksForAnswer: 1,
  embeddingDims: 1536,

  /**
   * Start a second identical chat request if the first has not responded
   * within this long, and stream whichever answers first. About one Gemini
   * call in twenty never returned headers at all, which left a visitor
   * watching "writing an answer" for 30 seconds before an error. 0 disables.
   */
  chatHedgeMs: num('CHAT_HEDGE_MS', 4_000),

  // Defaults suit a paid provider tier and hit the time budget in §4. A
  // free/low-quota key needs smaller batches, no parallelism, and a gap between
  // calls; that trades the 25s target for completing at all.
  embeddingBatchSize: num('EMBEDDING_BATCH_SIZE', 100),
  embeddingConcurrency: num('EMBEDDING_CONCURRENCY', 4),
  embeddingMinIntervalMs: num('EMBEDDING_MIN_INTERVAL_MS', 0),
} as const;

export type Config = typeof config;

/**
 * Clamp a requested page count to something we are willing to crawl. Anything
 * unparseable falls back to the default rather than to the ceiling: a bad
 * request should cost a visitor one page, not twenty-five.
 */
export function clampPages(requested: unknown, fallback: number = config.defaultPages): number {
  const n = Math.floor(Number(requested));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, config.maxPages);
}

/**
 * CRAWL_TIMEOUT_MS is the budget for a *full* 25-page crawl. Spending it on a
 * one-page pass means a site that hangs holds the visitor for 45 seconds to
 * fetch one document, so the deadline scales with what was actually asked for
 * and never exceeds the configured ceiling.
 */
export function crawlBudgetMs(pages: number): number {
  const scaled = 9_000 + 1_500 * Math.max(0, pages - 1);
  return Math.min(config.crawlTimeoutMs, Math.round(scaled));
}
