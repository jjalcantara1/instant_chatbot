import { request } from 'undici';
import { config } from '../config.js';

export interface EmbedResult {
  vectors: Float32Array[];
  /** Reported by the provider where available, else estimated. */
  tokens: number;
}

/**
 * The whole embedding surface. Swapping providers means writing one of these
 * and nothing else in the codebase changes.
 */
/**
 * Voyage embeds a search query and a stored passage differently and asks to be
 * told which is which; sending 'document' for both measurably flattens the
 * similarity range, which is what the retrieval floor is judged against.
 * Providers without the distinction ignore it.
 */
export type EmbedKind = 'document' | 'query';

export interface Embedder {
  readonly name: string;
  readonly dims: number;
  embed(texts: string[], kind?: EmbedKind): Promise<EmbedResult>;
}

/** Unit-normalise so cosine similarity is a plain dot product downstream. */
function normalise(v: number[]): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  const inv = sum > 0 ? 1 / Math.sqrt(sum) : 0;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = (v[i] as number) * inv;
  return out;
}

const EMBED_ATTEMPTS = 4;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Both providers rate-limit, and a free-tier key limits hard. Without a retry
 * one 429 mid-crawl throws away every page already embedded and the visitor
 * gets INTERNAL, so back off and try again before giving up.
 */
function retryDelayMs(attempt: number, retryAfter: string | string[] | undefined): number {
  const header = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 20_000);
  // Exponential with jitter, so parallel batches do not retry in lockstep.
  // When pacing is configured the provider's window is measured in minutes, so
  // an 8s ceiling just burns the retries; let the ceiling follow the pacing.
  const ceiling = Math.max(8_000, config.embeddingMinIntervalMs);
  return Math.min(500 * 2 ** attempt, ceiling) + Math.floor(Math.random() * 250);
}

/**
 * Spaces out request starts when EMBEDDING_MIN_INTERVAL_MS is set, so a
 * low-quota key never trips its limit in the first place. Retries recover from
 * a 429; pacing avoids earning one. Zero (the default) disables it entirely.
 */
let nextSlot = 0;
async function takeRateLimitSlot(): Promise<void> {
  const gap = config.embeddingMinIntervalMs;
  if (gap <= 0) return;
  const now = Date.now();
  const start = Math.max(now, nextSlot);
  nextSlot = start + gap;
  if (start > now) await sleep(start - now);
}

async function postJson(url: string, apiKey: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<unknown> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < EMBED_ATTEMPTS; attempt++) {
    await takeRateLimitSlot();
    const res = await request(url, {
      method: 'POST',
      headers: {
        // Google authenticates by its own header and rejects a stray bearer
        // token, so only send one scheme.
        ...(extraHeaders['x-goog-api-key'] ? {} : { authorization: `Bearer ${apiKey}` }),
        'content-type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      headersTimeout: 30_000,
      bodyTimeout: 30_000,
    });
    const text = await res.body.text();

    if (res.statusCode < 400) return JSON.parse(text) as unknown;

    lastError = new Error(`Embedding provider returned ${res.statusCode}: ${text.slice(0, 900)}`);
    // 4xx other than 429 is a bad key or a bad request: retrying cannot help.
    const retryable = res.statusCode === 429 || res.statusCode >= 500;
    if (!retryable || attempt === EMBED_ATTEMPTS - 1) throw lastError;

    await sleep(retryDelayMs(attempt, res.headers['retry-after']));
  }

  throw lastError ?? new Error('Embedding provider request failed.');
}

class OpenAIEmbedder implements Embedder {
  readonly name: string;
  readonly dims = 1536;
  constructor(private readonly apiKey: string, model: string) { this.name = model; }

  async embed(texts: string[]): Promise<EmbedResult> {
    if (texts.length === 0) return { vectors: [], tokens: 0 };
    const json = await postJson('https://api.openai.com/v1/embeddings', this.apiKey, {
      model: this.name,
      input: texts,
      encoding_format: 'float',
    }) as {
      data: Array<{ index: number; embedding: number[] }>;
      usage?: { prompt_tokens?: number };
    };

    // The API does not promise ordering, so place by index.
    const vectors = new Array<Float32Array>(texts.length);
    for (const row of json.data) vectors[row.index] = normalise(row.embedding);
    return {
      vectors: vectors as Float32Array[],
      tokens: json.usage?.prompt_tokens ?? texts.reduce((s, t) => s + Math.round(t.length / 4), 0),
    };
  }
}

class VoyageEmbedder implements Embedder {
  readonly name: string;
  readonly dims = 512;
  constructor(private readonly apiKey: string, model: string) { this.name = model; }

  async embed(texts: string[], kind: EmbedKind = 'document'): Promise<EmbedResult> {
    if (texts.length === 0) return { vectors: [], tokens: 0 };
    const json = await postJson('https://api.voyageai.com/v1/embeddings', this.apiKey, {
      model: this.name,
      input: texts,
      input_type: kind,
    }) as {
      data: Array<{ index: number; embedding: number[] }>;
      usage?: { total_tokens?: number };
    };
    const vectors = new Array<Float32Array>(texts.length);
    for (const row of json.data) vectors[row.index] = normalise(row.embedding);
    return {
      vectors: vectors as Float32Array[],
      tokens: json.usage?.total_tokens ?? texts.reduce((s, t) => s + Math.round(t.length / 4), 0),
    };
  }
}

/**
 * Google's embedding API. Batches up to 100 inputs per call (a hard API limit)
 * and takes an explicit task type, the same document/query distinction Voyage
 * makes. 768 dimensions is the smallest of the supported output sizes and is
 * ample for a few hundred chunks; truncated outputs are not unit-length as
 * returned, so normalise() matters here.
 */
class GeminiEmbedder implements Embedder {
  readonly name: string;
  readonly dims = 768;
  constructor(private readonly apiKey: string, model: string) { this.name = model; }

  async embed(texts: string[], kind: EmbedKind = 'document'): Promise<EmbedResult> {
    if (texts.length === 0) return { vectors: [], tokens: 0 };
    const taskType = kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
    const json = await postJson(
      `${config.geminiBaseUrl}/v1beta/models/${encodeURIComponent(this.name)}:batchEmbedContents`,
      this.apiKey,
      {
        requests: texts.map((text) => ({
          model: `models/${this.name}`,
          content: { parts: [{ text }] },
          taskType,
          outputDimensionality: this.dims,
        })),
      },
      // Google authenticates by header, not bearer token.
      { 'x-goog-api-key': this.apiKey },
    ) as { embeddings?: Array<{ values: number[] }> };

    const rows = json.embeddings ?? [];
    if (rows.length !== texts.length) {
      throw new Error(`Gemini returned ${rows.length} embeddings for ${texts.length} inputs.`);
    }
    return {
      // Batch responses come back in request order; there is no index field.
      vectors: rows.map((r) => normalise(r.values)),
      tokens: texts.reduce((sum, t) => sum + Math.round(t.length / 4), 0),
    };
  }
}

/**
 * Deterministic offline embedder: hashed bag of character n-grams.
 * Retrieval quality is poor, so it is only for exercising the pipeline
 * without network or keys. Never selected unless explicitly asked for.
 */
export class HashEmbedder implements Embedder {
  readonly name = 'hash-dev';
  readonly dims = 512;

  async embed(texts: string[]): Promise<EmbedResult> {
    const vectors = texts.map((t) => {
      const acc = new Array<number>(this.dims).fill(0);
      const s = t.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ');
      for (const token of s.split(/\s+/).filter(Boolean)) {
        let h = 2166136261;
        for (let i = 0; i < token.length; i++) {
          h ^= token.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
        const slot = Math.abs(h) % this.dims;
        acc[slot] = (acc[slot] ?? 0) + 1;
      }
      return normalise(acc);
    });
    return { vectors, tokens: texts.reduce((s, t) => s + Math.round(t.length / 4), 0) };
  }
}

/** How one open model wants to be called. */
interface LocalModelSpec {
  dims: number;
  pooling: 'cls' | 'mean';
  /** Prepended to questions. bge was trained with this instruction for retrieval. */
  queryPrefix: string;
  documentPrefix: string;
}

/**
 * Open models this server knows how to call. Each needs its own similarity
 * floor measured with `npm run eval` before it is added here.
 *
 * bge-small-en-v1.5 was chosen by measurement, not reputation: against the
 * eval's questions on the chunks voyage-3-lite indexed, it put the answering
 * chunk among the six the model sees for 42 of 42 questions (voyage-3-lite
 * also 42/42) with a better mean reciprocal rank (0.887 vs 0.839), ahead of
 * gte-small, snowflake-arctic-embed-s/-xs, all-MiniLM-L6-v2 and
 * multilingual-e5-small. It is English-only; a site in another language will
 * retrieve noticeably worse than it did on Voyage.
 */
export const LOCAL_MODELS: Record<string, LocalModelSpec> = {
  'Xenova/bge-small-en-v1.5': {
    dims: 384,
    pooling: 'cls',
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
    documentPrefix: '',
  },
};

export const DEFAULT_LOCAL_MODEL = 'Xenova/bge-small-en-v1.5';

/** Texts per inference call. Bigger batches grow the runtime's memory arena. */
const LOCAL_BATCH = 8;

interface FeatureExtractor {
  (texts: string[], options: { pooling: 'cls' | 'mean'; normalize: boolean }): Promise<{ data: ArrayLike<number>; dims: number[] }>;
}

/**
 * An open embedding model run inside this process with transformers.js: no
 * key, no quota, no network round trip per question. That round trip was the
 * whole problem on an unbilled Voyage key, where every question's embedding
 * waited for a pacing slot shared by every visitor.
 *
 * It costs memory and CPU on the box instead. One thread, so the event loop
 * keeps the other vCPU of a small VM; batches of eight, which on a 17-page site
 * held the runtime's memory arena to about +100 MB over the ~80 MB model. The
 * model downloads once (34 MB) into EMBEDDING_CACHE_DIR, which has to be
 * writable - node_modules is not, under the systemd unit.
 *
 * transformers.js loads the ONNX runtime's native binding on import, so it is
 * only imported when this embedder is actually used.
 */
export class LocalEmbedder implements Embedder {
  readonly name: string;
  readonly dims: number;
  private extractor: Promise<FeatureExtractor> | null = null;
  /** Inference runs one call at a time: concurrent calls only contend for one thread. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(model: string, private readonly spec: LocalModelSpec, private readonly cacheDir: string) {
    this.name = model;
    this.dims = spec.dims;
  }

  private load(): Promise<FeatureExtractor> {
    if (!this.extractor) {
      this.extractor = (async () => {
        const { pipeline, env } = await import('@huggingface/transformers');
        env.cacheDir = this.cacheDir;
        const extractor = await pipeline('feature-extraction', this.name, {
          dtype: 'q8',
          session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
        });
        return extractor as unknown as FeatureExtractor;
      })();
      // A failed download must not poison every later attempt.
      this.extractor.catch(() => { this.extractor = null; });
    }
    return this.extractor;
  }

  async embed(texts: string[], kind: EmbedKind = 'document'): Promise<EmbedResult> {
    if (texts.length === 0) return { vectors: [], tokens: 0 };
    const prefix = kind === 'query' ? this.spec.queryPrefix : this.spec.documentPrefix;

    const run = this.queue.then(async () => {
      const extractor = await this.load();
      const vectors: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += LOCAL_BATCH) {
        const batch = texts.slice(i, i + LOCAL_BATCH).map((t) => prefix + t);
        const out = await extractor(batch, { pooling: this.spec.pooling, normalize: true });
        const width = out.dims[out.dims.length - 1] as number;
        const data = Float32Array.from(out.data);
        for (let j = 0; j < batch.length; j++) vectors.push(data.slice(j * width, (j + 1) * width));
      }
      return vectors;
    });
    this.queue = run.catch(() => {});

    return { vectors: await run, tokens: texts.reduce((s, t) => s + Math.round(t.length / 4), 0) };
  }
}

/**
 * What getEmbedder() would actually use, without needing a key to be present.
 * The boot banner and /admin/stats both report the embedder, and reading
 * EMBEDDING_MODEL raw there lies whenever the provider overrides it.
 */
export function resolveEmbedding(): { provider: string; model: string } {
  const provider = process.env['EMBEDDING_PROVIDER'] ?? config.embeddingProvider;
  if (provider === 'hash') return { provider, model: 'hash-dev' };
  if (provider === 'local') {
    return { provider, model: config.embeddingModel in LOCAL_MODELS ? config.embeddingModel : DEFAULT_LOCAL_MODEL };
  }
  if (provider === 'gemini') {
    return {
      provider,
      model: config.embeddingModel.startsWith('gemini') ? config.embeddingModel : 'gemini-embedding-001',
    };
  }
  if (provider === 'voyage') {
    return {
      provider,
      model: config.embeddingModel.startsWith('voyage') ? config.embeddingModel : 'voyage-3-lite',
    };
  }
  return { provider, model: config.embeddingModel };
}

let cached: { key: string; embedder: Embedder } | null = null;

/**
 * One embedder per provider and model for the life of the process, the way
 * getChatModel() works. Retrieval keeps a cache of query vectors per embedder,
 * and a fresh instance per question would make every lookup a miss.
 */
export function getEmbedder(): Embedder {
  const { provider, model } = resolveEmbedding();
  const key = `${provider}/${model}`;
  if (cached?.key === key) return cached.embedder;

  let embedder: Embedder;
  if (provider === 'hash') {
    embedder = new HashEmbedder();
  } else if (provider === 'local') {
    embedder = new LocalEmbedder(model, LOCAL_MODELS[model] as LocalModelSpec, config.embeddingCacheDir);
  } else if (provider === 'voyage') {
    if (!config.voyageApiKey) throw new Error('VOYAGE_API_KEY is not set.');
    embedder = new VoyageEmbedder(config.voyageApiKey, model);
  } else if (provider === 'gemini') {
    if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY is not set.');
    embedder = new GeminiEmbedder(config.geminiApiKey, model);
  } else {
    if (!config.openaiApiKey) throw new Error('OPENAI_API_KEY is not set.');
    embedder = new OpenAIEmbedder(config.openaiApiKey, model);
  }

  cached = { key, embedder };
  return embedder;
}

/**
 * Embed in provider-sized batches, preserving input order.
 *
 * Batches run concurrently. A content-heavy site can produce thousands of
 * chunks rather than the couple of hundred a small marketing site does, and
 * issuing those round trips one after another is what pushes a fast crawl past
 * the time budget.
 */
export async function embedBatched(
  embedder: Embedder,
  texts: string[],
  batchSize: number = config.embeddingBatchSize,
  concurrency = 4,
  kind: EmbedKind = 'document',
): Promise<EmbedResult> {
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) batches.push(texts.slice(i, i + batchSize));

  const results = new Array<EmbedResult>(batches.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= batches.length) return;
      results[i] = await embedder.embed(batches[i] as string[], kind);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));

  const vectors: Float32Array[] = [];
  let tokens = 0;
  for (const r of results) {
    vectors.push(...r.vectors);
    tokens += r.tokens;
  }
  return { vectors, tokens };
}

export function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function fromBlob(b: Buffer): Float32Array {
  // Copy rather than view: better-sqlite3 buffers are not guaranteed aligned.
  const copy = Buffer.from(b);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}
