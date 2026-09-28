import type { Section } from './extract.js';

export interface Chunk {
  /** Raw text, shown to the reader and passed to the model as the excerpt. */
  text: string;
  /** What actually gets embedded: title + heading path prepended for topic anchoring. */
  embedText: string;
  headingPath: string;
  /**
   * The heading path of every section whose text is in this chunk, in page
   * order. One entry unless small sections were packed together, in which case
   * `headingPath` is only what they share and these are what they were.
   */
  headings: string[];
  tokens: number;
}

const TARGET = 800;
const OVERLAP = 120;
const MIN_CHUNK = 80;
/** Chunks are only ever compared to each other, so a 4-chars-per-token estimate is fine. */
export const estimateTokens = (s: string): number => Math.max(1, Math.round(s.length / 4));

const segments = (path: string): string[] => path.split(' > ').filter(Boolean);

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

interface Packed extends Section {
  headings: string[];
}

/** One section standing for a run of them: shared path, members' own headings inlined. */
function merge(group: Section[]): Packed {
  const first = group[0] as Section;
  if (group.length === 1) return { headingPath: first.headingPath, text: first.text, headings: [first.headingPath] };

  const paths = group.map((g) => segments(g.headingPath));
  const lead = paths[0] as string[];
  let shared = 0;
  while (shared < lead.length && paths.every((p) => p[shared] === lead[shared])) shared++;

  const text = group.map((g, i) => {
    const own = (paths[i] as string[]).slice(shared).join(' > ');
    return own ? `${own}\n${g.text}` : g.text;
  }).join('\n');

  return { headingPath: lead.slice(0, shared).join(' > '), text, headings: group.map((g) => g.headingPath) };
}

/**
 * Merge runs of small sections under the same parent heading into one.
 *
 * Landing pages are built from cards: a services grid, case-study tiles,
 * process steps, contact details, each one a heading and a line or two. On
 * their own most fall under the 80-character floor below and are dropped, so
 * the page's most specific facts - an email address, "a 15 to 45 minute
 * call", what each service is - never reached the index. Packed together
 * they survive, and a single chunk answers "what services do you offer?".
 *
 * Runs never cross into a different parent: sections belong together when
 * they share every heading level but the page's deepest one, so the cards of
 * one section join their intro but not the next section's.
 */
export function packSections(sections: Section[]): Packed[] {
  const depth = Math.max(0, ...sections.map((s) => segments(s.headingPath).length));
  const parentOf = (path: string): string => segments(path).slice(0, Math.max(0, depth - 1)).join(' > ');

  const out: Packed[] = [];
  let group: Section[] = [];
  let size = 0;
  let parent = '';

  const emit = (): void => {
    if (group.length > 0) out.push(merge(group));
    group = [];
    size = 0;
  };

  for (const s of sections) {
    const text = s.text.trim();
    if (!text) continue;
    if (text.length >= TARGET) {
      emit();
      out.push({ headingPath: s.headingPath, text, headings: [s.headingPath] });
      continue;
    }
    // The member's own heading is inlined when packed, so it counts too.
    const cost = text.length + (segments(s.headingPath).pop()?.length ?? 0) + 2;
    const p = parentOf(s.headingPath);
    if (group.length > 0 && (p !== parent || size + cost > TARGET)) emit();
    if (group.length === 0) parent = p;
    group.push({ headingPath: s.headingPath, text });
    size += cost;
  }
  emit();
  return out;
}

export function chunkPage(
  pageTitle: string,
  sections: Section[],
): Chunk[] {
  const chunks: Chunk[] = [];

  for (const section of packSections(sections)) {
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
        headings: section.headings,
        tokens: estimateTokens(text),
      });
    }
  }

  return chunks;
}
