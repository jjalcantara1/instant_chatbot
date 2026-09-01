import { config } from '../config.js';
import type { DB } from '../db.js';
import { fromBlob, type Embedder } from '../indexing/embed.js';
import { Bm25Index } from './bm25.js';

export interface StoredChunk {
  id: number;
  pageId: number;
  url: string;
  title: string;
  headingPath: string;
  text: string;
  vector: Float32Array;
}

export interface RetrievedChunk extends StoredChunk {
  cosine: number;
  fused: number;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  /** True when too little survived the score floor to answer honestly. */
  insufficient: boolean;
}

interface SessionIndex {
  chunks: StoredChunk[];
  byId: Map<number, StoredChunk>;
  bm25: Bm25Index;
  loadedAt: number;
}

const cache = new Map<string, SessionIndex>();
const CACHE_TTL_MS = 10 * 60 * 1000;

export function invalidateSession(sessionId: string): void {
  cache.delete(sessionId);
}

export function loadSessionIndex(db: DB, sessionId: string): SessionIndex {
  const hit = cache.get(sessionId);
  if (hit && Date.now() - hit.loadedAt < CACHE_TTL_MS) return hit;

  const rows = db.prepare(`
    SELECT c.id, c.page_id AS pageId, c.heading_path AS headingPath, c.text, c.embedding,
           p.url, p.title
    FROM chunks c JOIN pages p ON p.id = c.page_id
    WHERE c.session_id = ?
  `).all(sessionId) as Array<{
    id: number; pageId: number; headingPath: string | null; text: string;
    embedding: Buffer; url: string; title: string | null;
  }>;

  const chunks: StoredChunk[] = rows.map((r) => ({
    id: r.id,
    pageId: r.pageId,
    url: r.url,
    title: r.title ?? '',
    headingPath: r.headingPath ?? '',
    text: r.text,
    vector: fromBlob(r.embedding),
  }));

  const index: SessionIndex = {
    chunks,
    byId: new Map(chunks.map((c) => [c.id, c])),
    // BM25 sees the heading path too, so a query naming a section can match it.
    bm25: new Bm25Index(chunks.map((c) => ({
      id: c.id,
      text: `${c.title} ${c.headingPath} ${c.text}`,
    }))),
    loadedAt: Date.now(),
  };
  cache.set(sessionId, index);
  return index;
}

/** Vectors are unit-normalised at embed time, so cosine is a plain dot product. */
function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] as number) * (b[i] as number);
  return s;
}

/**
 * Hybrid retrieval with reciprocal rank fusion, then a hard similarity floor.
 *
 * The floor is what makes "that isn't on this site" work. RRF will always
 * return a ranked list, however irrelevant, because BM25 happily matches a
 * stray token. Without step 6/7 the model receives six confident-looking
 * excerpts about nothing in particular and writes a fluent wrong answer.
 */
export async function retrieve(
  db: DB,
  sessionId: string,
  query: string,
  embedder: Embedder,
): Promise<RetrievalResult> {
  const index = loadSessionIndex(db, sessionId);
  if (index.chunks.length === 0) return { chunks: [], insufficient: true };

  const { vectors } = await embedder.embed([query], 'query');
  const qv = vectors[0];
  if (!qv) return { chunks: [], insufficient: true };

  // Rank A: dense.
  const cosines = new Map<number, number>();
  for (const c of index.chunks) cosines.set(c.id, dot(qv, c.vector));

  const rankA = [...cosines.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, config.candidateK);

  // Rank B: lexical.
  const rankB = index.bm25.search(query, config.candidateK);

  // Fuse.
  const posA = new Map(rankA.map(([id], i) => [id, i + 1]));
  const posB = new Map(rankB.map((r, i) => [r.id, i + 1]));
  const k = config.rrfK;

  const fused = new Map<number, number>();
  for (const [id, rank] of posA) fused.set(id, (fused.get(id) ?? 0) + 1 / (k + rank));
  for (const [id, rank] of posB) fused.set(id, (fused.get(id) ?? 0) + 1 / (k + rank));

  const ranked: RetrievedChunk[] = [...fused.entries()]
    .map(([id, score]) => {
      const c = index.byId.get(id) as StoredChunk;
      return { ...c, cosine: cosines.get(id) ?? 0, fused: score };
    })
    .sort((a, b) => b.fused - a.fused)
    .slice(0, config.topK);

  // Step 6: drop anything the dense retriever thinks is noise, however much
  // BM25 liked it.
  const survivors = ranked.filter((c) => c.cosine >= config.minCosine);

  // Step 7: too little left to answer from. The chat layer says so plainly
  // instead of asking the model to be honest about an empty hand.
  if (survivors.length < config.minChunksForAnswer) {
    return { chunks: survivors, insufficient: true };
  }

  return { chunks: survivors, insufficient: false };
}
