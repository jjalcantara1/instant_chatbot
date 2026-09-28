import { config } from '../config.js';
import { embedQueries, rankWithVector } from './retrieve.js';
import type { Embedder } from '../indexing/embed.js';
import type { DB } from '../db.js';

/**
 * Suggested opening questions for a session.
 *
 * The rule this module exists to enforce: **a suggestion the app offers must be
 * one the app can answer.** Offering a question and then refusing it is the
 * worst thing this demo can do — the visitor is evaluating retrieval on content
 * they know, and being refused about their own page reads as "it does not
 * work", not "it is being careful".
 *
 * Candidates come from the page's own headings, plus a few generic questions,
 * and every one is run through the same retrieval that will answer it. The bar
 * for suggesting is set higher than the bar for answering: the best chunk has
 * to clear the similarity floor by STARTER_MARGIN, not merely reach it. The
 * floor decides what the model may see; a suggestion should be something the
 * page plainly covers.
 *
 * Page titles are no longer candidates. They are written for search engines,
 * they were measured as the weakest candidates by far, and the one title-based
 * suggestion kleiosoftware.com was offered ("Tell me about Custom Website & AI
 * Development in Pampanga") was the one the model then refused.
 */

export interface Starter {
  text: string;
  /** The page it retrieved from, used to keep the three suggestions varied. */
  url: string;
}

export interface Candidate {
  text: string;
  url: string;
  /** Lower sorts first. Question-shaped headings read best, so they lead. */
  rank: number;
}

/** One stored or pending chunk, as far as suggestion-building cares. */
export interface CandidateRow {
  url: string;
  headingPath: string | null;
  /** Every heading packed into the chunk; falls back to headingPath. */
  headings: string[] | null;
}

/** How many suggestions the UI shows. */
const WANTED = 3;

/**
 * Upper bound on candidates embedded. They all go in one request, so this is a
 * token budget rather than a round-trip budget.
 */
const MAX_CANDIDATES = 24;

/** How far above the similarity floor a suggestion's best chunk must score. */
export const STARTER_MARGIN = 0.1;

const lastSegment = (headingPath: string): string =>
  (headingPath.split('>').pop() ?? headingPath).trim();

/** Headings that describe the furniture rather than the content. */
const JUNK_HEADING = /^(navigation|menu|footer|header|search|breadcrumb|skip to|share|related|tags?|categor|sidebar|cookie|newsletter|subscribe|follow us|contact form)/i;

/**
 * Sentence-ending punctuation with more text after it, which means this is
 * prose rather than a heading. Landing pages are full of it - hero copy like
 * "You imagine it. We build it for you." gets marked up as an h1 and makes a
 * terrible suggestion. A question mark is exempt: a heading that IS a question
 * is the best suggestion there is.
 */
const IS_PROSE = /[.!](\s|\S)/;

/**
 * Calls to action. They are headings, and they are about the page, but
 * "Tell me about Tell us what you're building" is not a question anyone would
 * type. "Get" and "start" alone are deliberately absent: "Getting started" is a
 * real section heading on any documentation site.
 */
const IS_CTA = /^(see|book|contact|call|e-?mail|join|sign\s?up|subscribe|download|request|discover|explore|find out|learn more|let'?s|tell us|talk to|ready to|don'?t miss|why wait|get in touch|say hello|work with us|hire us|start (a|the|your) (conversation|project))\b/i;

function usableHeading(segment: string): boolean {
  if (segment.length < 8 || segment.length > 90) return false;
  if (JUNK_HEADING.test(segment)) return false;
  // Two words minimum, or it is a label and not a subject.
  if (!/\s/.test(segment)) return false;
  if (segment.split(/\s+/).length > 14) return false;

  // A heading that is already a question is the best suggestion there is, and
  // none of the copy rules below should be allowed to throw one away.
  if (segment.endsWith('?')) return true;

  if (IS_CTA.test(segment)) return false;
  // Section headings do not end in a full stop. Marketing copy does, and the
  // hero band of a landing page is full of it.
  if (/[.!]$/.test(segment)) return false;
  return !IS_PROSE.test(segment);
}

/**
 * Questions a visitor actually types, phrased without reference to any
 * particular site.
 *
 * On a landing-page-only index - the default crawl - the headings are often
 * hero copy and calls to action, so heading-derived suggestions can be thin on
 * the ground. These fill the gap. They are guesses about what the page covers,
 * which is exactly why they go through the same verification as everything
 * else: one that the site does not answer is never shown.
 */
const GENERIC_PROBES = [
  'What does this company do?',
  'What services are offered?',
  'How much does it cost?',
  'How do I get in touch?',
  'Who is this for?',
];

/** Candidate questions from chunk rows in page order. Pure, so indexing can call it before anything is stored. */
export function candidatesFromRows(rows: CandidateRow[]): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();

  const add = (text: string, url: string, rank: number): void => {
    const t = text.replace(/\s+/g, ' ').trim();
    const key = t.toLowerCase();
    if (t.length < 8 || seen.has(key)) return;
    seen.add(key);
    out.push({ text: t, url, rank });
  };

  for (const row of rows) {
    const paths = row.headings && row.headings.length > 0 ? row.headings : [row.headingPath ?? ''];
    for (const path of paths) {
      const segment = path ? lastSegment(path) : '';
      if (!segment || !usableHeading(segment)) continue;
      // A heading that is already a question is the best possible suggestion:
      // it is phrased the way a visitor would ask, and the site answers it.
      if (segment.endsWith('?')) add(segment, row.url, 0);
      else add(`Tell me about ${segment}`, row.url, 1);
    }
  }

  // Generic questions, verified like everything else. They carry a landing
  // page, where the headings are slogans rather than subjects.
  const home = rows[0]?.url;
  if (home !== undefined) {
    for (const probe of GENERIC_PROBES) add(probe, home, 2);
  }

  return out.sort((a, b) => a.rank - b.rank).slice(0, MAX_CANDIDATES);
}

/** The session's stored chunks, in page order, as candidate rows. */
export function storedCandidateRows(db: DB, sessionId: string): CandidateRow[] {
  const rows = db.prepare(`
    SELECT p.url AS url, c.heading_path AS headingPath, c.headings AS headings
    FROM chunks c JOIN pages p ON p.id = c.page_id
    WHERE c.session_id = ?
    ORDER BY p.id, c.id
  `).all(sessionId) as Array<{ url: string; headingPath: string | null; headings: string | null }>;

  return rows.map((r) => ({ url: r.url, headingPath: r.headingPath, headings: parseHeadings(r.headings) }));
}

function parseHeadings(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((h): h is string => typeof h === 'string') : null;
  } catch {
    return null;
  }
}

export function buildCandidates(db: DB, sessionId: string): Candidate[] {
  return candidatesFromRows(storedCandidateRows(db, sessionId));
}

/**
 * Keep the candidates the session can answer, and pick up to three that are
 * spread out: every page first, then every section, then whatever is left.
 * Three suggestions about three cards of the same services grid tell a visitor
 * less than one about services, one about past work and one about the process.
 */
export function chooseStarters(
  db: DB,
  sessionId: string,
  candidates: Candidate[],
  vectors: Array<Float32Array | undefined>,
): Starter[] {
  const bar = config.minCosine + STARTER_MARGIN;

  const passing: Array<{ candidate: Candidate; cites: string[]; section: string }> = [];
  candidates.forEach((candidate, i) => {
    const vector = vectors[i];
    if (!vector) return;
    const result = rankWithVector(db, sessionId, candidate.text, vector);
    if (result.insufficient) return;
    const top = [...result.chunks].sort((a, b) => b.cosine - a.cosine)[0];
    if (!top || top.cosine < bar) return;
    passing.push({
      candidate,
      cites: result.chunks.map((c) => c.url),
      section: `${top.url}#${top.headingPath}`,
    });
  });

  const chosen: Starter[] = [];
  const taken = new Set<Candidate>();
  const usedPages = new Set<string>();
  const usedSections = new Set<string>();
  const take = (p: (typeof passing)[number], url: string): void => {
    chosen.push({ text: p.candidate.text, url });
    taken.add(p.candidate);
    usedPages.add(url);
    usedSections.add(p.section);
  };

  for (const p of passing) {
    if (chosen.length >= WANTED) break;
    const fresh = p.cites.find((u) => !usedPages.has(u));
    if (fresh !== undefined) take(p, fresh);
  }
  for (const p of passing) {
    if (chosen.length >= WANTED) break;
    if (taken.has(p.candidate) || usedSections.has(p.section)) continue;
    take(p, p.cites[0] ?? p.candidate.url);
  }
  for (const p of passing) {
    if (chosen.length >= WANTED) break;
    if (taken.has(p.candidate)) continue;
    take(p, p.cites[0] ?? p.candidate.url);
  }

  return chosen;
}

/**
 * Build suggestions from what the session holds and keep only answerable ones.
 *
 * Costs at most one embedding request regardless of how many candidates there
 * are - fewer, when the generic probes are already in the query cache - and
 * the checking itself is arithmetic over vectors the session already holds.
 */
export async function generateStarters(
  db: DB,
  sessionId: string,
  embedder: Embedder,
): Promise<Starter[]> {
  const candidates = buildCandidates(db, sessionId);
  if (candidates.length === 0) return [];
  const vectors = await embedQueries(embedder, candidates.map((c) => c.text));
  return chooseStarters(db, sessionId, candidates, vectors);
}
