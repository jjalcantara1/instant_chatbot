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
export interface Embedder {
  readonly name: string;
  readonly dims: number;
  embed(texts: string[]): Promise<EmbedResult>;
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

async function postJson(url: string, apiKey: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<unknown> {
  const res = await request(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
    headersTimeout: 30_000,
    bodyTimeout: 30_000,
  });
  const text = await res.body.text();
  if (res.statusCode >= 400) {
    throw new Error(`Embedding provider returned ${res.statusCode}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
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

  async embed(texts: string[]): Promise<EmbedResult> {
    if (texts.length === 0) return { vectors: [], tokens: 0 };
    const json = await postJson('https://api.voyageai.com/v1/embeddings', this.apiKey, {
      model: this.name,
      input: texts,
      input_type: 'document',
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

export function getEmbedder(): Embedder {
  const provider = process.env['EMBEDDING_PROVIDER'] ?? config.embeddingProvider;

  if (provider === 'hash') return new HashEmbedder();

  if (provider === 'voyage') {
    if (!config.voyageApiKey) throw new Error('VOYAGE_API_KEY is not set.');
    const model = config.embeddingModel.startsWith('voyage') ? config.embeddingModel : 'voyage-3-lite';
    return new VoyageEmbedder(config.voyageApiKey, model);
  }

  if (!config.openaiApiKey) throw new Error('OPENAI_API_KEY is not set.');
  return new OpenAIEmbedder(config.openaiApiKey, config.embeddingModel);
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
): Promise<EmbedResult> {
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) batches.push(texts.slice(i, i + batchSize));

  const results = new Array<EmbedResult>(batches.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= batches.length) return;
      results[i] = await embedder.embed(batches[i] as string[]);
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
