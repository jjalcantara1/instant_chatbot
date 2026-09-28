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

/**
 * Whether this session was indexed by a different embedding model than the
 * one that would search it now.
 *
 * Vectors from two models are not comparable, and the arithmetic will not say
 * so: a dot product over mismatched vectors still returns numbers, and the
 * chat would answer from noise for the rest of the session's 24 hours. Newer
 * sessions record their model; for older ones the vectors' width is the tell,
 * since the supported providers all differ in width - except the offline hash
 * embedder, which only ever runs in development.
 */
export function indexedWithAnotherModel(db: DB, sessionId: string, embedder: Embedder): boolean {
  const row = db.prepare('SELECT embedding_model AS model FROM sessions WHERE id = ?')
    .get(sessionId) as { model: string | null } | undefined;
  if (row?.model) return row.model !== embedder.name;
  const chunk = db.prepare('SELECT length(embedding) AS bytes FROM chunks WHERE session_id = ? LIMIT 1')
    .get(sessionId) as { bytes: number } | undefined;
  return chunk !== undefined && chunk.bytes / 4 !== embedder.dims;
}

/** Vectors are unit-normalised at embed time, so cosine is a plain dot product. */
function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] as number) * (b[i] as number);
  return s;
}

const QUERY_CACHE_MAX = 2_000;
const queryCache = new WeakMap<Embedder, Map<string, Float32Array>>();

/**
 * Query vectors, from memory where possible, with every miss embedded in one
 * request.
 *
 * A query vector depends only on the text and the model, never on the site.
 * So a suggested question embedded while it was being verified costs nothing
 * when the visitor clicks it - usually their first question, and one fewer
 * round trip on a rate-limited key - and the generic probes every index checks
 * are embedded once per process rather than once per site. Keyed by embedder
 * instance, so two models can never share a vector.
 */
export async function embedQueries(embedder: Embedder, texts: string[]): Promise<Array<Float32Array | undefined>> {
  let vectors = queryCache.get(embedder);
  if (!vectors) {
    vectors = new Map();
    queryCache.set(embedder, vectors);
  }
  const store = vectors;

  const missing = [...new Set(texts.filter((t) => !store.has(t)))];
  if (missing.length > 0) {
    const res = await embedder.embed(missing, 'query');
    missing.forEach((t, i) => {
      const v = res.vectors[i];
      if (v) store.set(t, v);
    });
    while (store.size > QUERY_CACHE_MAX) store.delete(store.keys().next().value as string);
  }

  return texts.map((t) => {
    const v = store.get(t);
    // Refresh recency, so the oldest entries are the ones evicted.
    if (v) { store.delete(t); store.set(t, v); }
    return v;
  });
}

/**
 * What a follow-up is searched for, alongside the question itself.
 *
 * "Who was it built for?" says nothing about what "it" is, so on its own it
 * retrieves whatever mentions building things for people. The question before
 * it names the subject. Exported so the eval can fetch the same text ahead of
 * time instead of spending a round trip per question.
 */
export function followUpQuery(previousQuestion: string, question: string): string {
  return `${previousQuestion} ${question}`;
}

/**
 * Hybrid retrieval with reciprocal rank fusion, then a similarity floor.
 *
 * With a previous question, retrieval searches twice - for the question alone
 * and for it with the previous one prepended - from one embedding request, and
 * fuses the two the same way it fuses dense and lexical ranks: by summing each
 * chunk's scores. The combined search finds what a pronoun refers to, the
 * standalone one keeps a change of subject working, and a chunk that is right
 * for both - on the topic, and about what was actually asked - rises above one
 * that is only on the topic.
 *
 * Keeping each search's best score instead did not do that. After "What does
 * the steel connections classifier do?", "Can I try it myself?" filled all six
 * slots with the case study's other sections - its call to action ranked first
 * - and the chunk saying the tool is "deployed, public, and clickable today"
 * never reached the model.
 */
export async function retrieve(
  db: DB,
  sessionId: string,
  query: string,
  embedder: Embedder,
  previousQuestion?: string,
): Promise<RetrievalResult> {
  const index = loadSessionIndex(db, sessionId);
  if (index.chunks.length === 0) return { chunks: [], insufficient: true };

  const texts = previousQuestion ? [query, followUpQuery(previousQuestion, query)] : [query];
  const vectors = await embedQueries(embedder, texts);

  const summed = new Map<number, RetrievedChunk>();
  texts.forEach((text, i) => {
    const qv = vectors[i];
    if (!qv) return;
    for (const c of rankCandidates(db, sessionId, text, qv)) {
      const seen = summed.get(c.id);
      summed.set(c.id, seen ? { ...seen, fused: seen.fused + c.fused, cosine: Math.max(seen.cosine, c.cosine) } : c);
    }
  });

  const chunks = [...summed.values()].sort((a, b) => b.fused - a.fused).slice(0, config.topK);
  return { chunks, insufficient: chunks.length < config.minChunksForAnswer };
}

/**
 * The ranking half of `retrieve`, given a query vector that has already been
 * computed.
 *
 * Split out so a caller with several queries can embed them in one request and
 * then rank each locally. That matters on a rate-limited embedding key, where
 * the cost of checking N questions is the number of HTTP round trips, not the
 * arithmetic — the arithmetic is a dot product over vectors already in memory.
 *
 * The floor is applied BEFORE the list is cut to topK. RRF will always return
 * a ranked list, however irrelevant, because BM25 happily matches a stray
 * token; cutting first let those lexical matches take slots and then be thrown
 * away by the floor, which could leave a question with nothing even though
 * better-matching chunks were ranked just below the cut. Paraphrased questions
 * - the ones with no words in common with the page - suffered most.
 *
 * What the floor is for has changed, too. Measured against voyage-3-lite on
 * kleiosoftware.com, raw cosine does not separate answerable questions from
 * absent ones: a single-sentence fact (an email address, "a 15 to 45 minute
 * call") ranks first at 0.25-0.34, while an absent question that names the
 * brand scores up to 0.49. So the floor now only removes what is plainly
 * unrelated, and the model decides the rest from what it is shown. An answer
 * with no citation is a refusal, which is how the eval judges every absent
 * question.
 */
export function rankWithVector(
  db: DB,
  sessionId: string,
  query: string,
  qv: Float32Array,
): RetrievalResult {
  const chunks = rankCandidates(db, sessionId, query, qv).slice(0, config.topK);
  // Nothing close enough to answer from. The chat layer says so plainly
  // instead of asking the model to be honest about an empty hand.
  return { chunks, insufficient: chunks.length < config.minChunksForAnswer };
}

/** Every candidate that clears the floor, best fused score first, uncut. */
function rankCandidates(
  db: DB,
  sessionId: string,
  query: string,
  qv: Float32Array,
): RetrievedChunk[] {
  const index = loadSessionIndex(db, sessionId);
  if (index.chunks.length === 0) return [];

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

  // Drop anything the dense retriever thinks is noise, however much BM25
  // liked it. Callers cut to topK only after this.
  return [...fused.entries()]
    .map(([id, score]) => {
      const c = index.byId.get(id) as StoredChunk;
      return { ...c, cosine: cosines.get(id) ?? 0, fused: score };
    })
    .filter((c) => c.cosine >= config.minCosine)
    .sort((a, b) => b.fused - a.fused);
}
