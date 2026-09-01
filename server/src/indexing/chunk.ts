import type { Section } from './extract.js';

export interface Chunk {
  /** Raw text, shown to the reader and passed to the model as the excerpt. */
  text: string;
  /** What actually gets embedded: title + heading path prepended for topic anchoring. */
  embedText: string;
  headingPath: string;
  tokens: number;
}

const TARGET = 800;
const OVERLAP = 120;
const MIN_CHUNK = 80;
/** Chunks are only ever compared to each other, so a 4-chars-per-token estimate is fine. */
export const estimateTokens = (s: string): number => Math.max(1, Math.round(s.length / 4));

/** Sentence-ending positions, so a chunk never breaks mid-sentence. */
function sentenceEnds(text: string): number[] {
  const ends: number[] = [];
  const re = /[.!?…]["')\]]*\s|\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) ends.push(m.index + m[0].length);
  if (ends.length === 0 || (ends[ends.length - 1] as number) < text.length) ends.push(text.length);
  return ends;
}

/** Split one section body into overlapping, sentence-aligned windows. */
function splitBody(body: string): string[] {
  const text = body.trim();
  if (text.length <= TARGET) return text.length > 0 ? [text] : [];

  const ends = sentenceEnds(text);
  const out: string[] = [];
  let start = 0;

  while (start < text.length) {
    const hardEnd = start + TARGET;
    if (hardEnd >= text.length) {
      const tail = text.slice(start).trim();
      if (tail) out.push(tail);
      break;
    }

    // Last sentence boundary at or before the target length.
    let cut = -1;
    for (const e of ends) {
      if (e > start && e <= hardEnd) cut = e;
      else if (e > hardEnd) break;
    }
    // A single sentence longer than the window: fall back to a word boundary.
    if (cut <= start) {
      const slice = text.slice(start, hardEnd);
      const space = slice.lastIndexOf(' ');
      cut = space > 0 ? start + space + 1 : hardEnd;
    }

    const piece = text.slice(start, cut).trim();
    if (piece) out.push(piece);

    // Step back for the overlap, but land on a sentence start. Stepping back a
    // fixed number of characters lands mid-word ("e overall accuracy hides..."),
    // which reads as broken and gives the embedder a garbled opening token.
    const overlapFrom = cut - OVERLAP;
    let next = cut;
    if (overlapFrom > start) {
      const sentenceStart = ends.find((e) => e >= overlapFrom && e < cut);
      if (sentenceStart !== undefined) {
        next = sentenceStart;
      } else {
        const space = text.indexOf(' ', overlapFrom);
        if (space !== -1 && space + 1 < cut) next = space + 1;
      }
    }
    start = Math.max(start + 1, next);
    if (out.length > 500) break; // pathological input guard
  }

  return out;
}

export function chunkPage(
  pageTitle: string,
  sections: Section[],
): Chunk[] {
  const chunks: Chunk[] = [];

  for (const section of sections) {
    for (const piece of splitBody(section.text)) {
      const text = piece.trim();
      if (text.length < MIN_CHUNK) continue;

      // The topic anchor. On a small corpus this materially improves retrieval,
      // because a short chunk otherwise carries no clue what page it is from.
      const header = [pageTitle, section.headingPath].filter(Boolean).join(' — ');
      const embedText = header ? `${header}\n\n${text}` : text;

      chunks.push({
        text,
        embedText,
        headingPath: section.headingPath,
        tokens: estimateTokens(text),
      });
    }
  }

  return chunks;
}
