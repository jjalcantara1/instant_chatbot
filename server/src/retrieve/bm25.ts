/**
 * BM25 over the session's chunk text. Vector search alone underperforms on a
 * 200-chunk corpus for exactly the things visitors test with: proper nouns,
 * prices, product names, phone numbers. Those are lexical matches.
 */

const K1 = 1.2;
const B = 0.75;

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9$£€%.\-\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[.\-]+|[.\-]+$/g, ''))
    .filter((t) => t.length > 0 && t.length < 40);
}

export interface Bm25Doc { id: number; text: string; }

export class Bm25Index {
  private readonly docLengths = new Map<number, number>();
  /** term -> docId -> term frequency */
  private readonly postings = new Map<string, Map<number, number>>();
  private avgDocLength = 0;
  private docCount = 0;

  constructor(docs: Bm25Doc[]) {
    let total = 0;
    for (const doc of docs) {
      const terms = tokenize(doc.text);
      this.docLengths.set(doc.id, terms.length);
      total += terms.length;
      const counts = new Map<string, number>();
      for (const t of terms) counts.set(t, (counts.get(t) ?? 0) + 1);
      for (const [term, tf] of counts) {
        let p = this.postings.get(term);
        if (!p) { p = new Map(); this.postings.set(term, p); }
        p.set(doc.id, tf);
      }
    }
    this.docCount = docs.length;
    this.avgDocLength = docs.length > 0 ? total / docs.length : 0;
  }

  search(query: string, limit: number): Array<{ id: number; score: number }> {
    const terms = tokenize(query);
    if (terms.length === 0 || this.docCount === 0) return [];

    const scores = new Map<number, number>();

    for (const term of new Set(terms)) {
      const posting = this.postings.get(term);
      if (!posting) continue;

      const df = posting.size;
      // Standard BM25 IDF with the +1 that keeps it non-negative for common terms.
      const idf = Math.log(1 + (this.docCount - df + 0.5) / (df + 0.5));

      for (const [docId, tf] of posting) {
        const len = this.docLengths.get(docId) ?? 0;
        const norm = this.avgDocLength > 0 ? len / this.avgDocLength : 1;
        const contribution = idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * norm)));
        scores.set(docId, (scores.get(docId) ?? 0) + contribution);
      }
    }

    return [...scores.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
