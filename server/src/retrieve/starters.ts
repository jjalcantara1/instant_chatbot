import { rankWithVector } from './retrieve.js';
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
 * The suggestions used to be built in the browser from page titles, which fails
 * two ways. Titles are written for search engines, so trimming the brand tail
 * off "FAQ: Custom Websites & AI Models in Pampanga | Kleio" leaves the bare
 * token "FAQ", which carries almost no meaning to embed. And a title is not
 * what retrieval is judged against — chunk text is. Measured against
 * voyage-3-lite, title-derived questions cleared the 0.35 floor by as little as
 * 0.029, while questions built from heading paths cleared it by 0.10 or more.
 *
 * Margin is not a guarantee, though: a question can score 0.73 and still be
 * refused because only ONE chunk cleared the floor and `minChunksForAnswer` is
 * 2. So candidates are generated generously and then run through the very same
 * gate that will answer them, and only survivors are ever shown.
 */

export interface Starter {
  text: string;
  /** The page it retrieved from, used to keep the three suggestions varied. */
  url: string;
}

interface Candidate {
  text: string;
  url: string;
  /** Lower sorts first. Question-shaped headings read best, so they lead. */
  rank: number;
}

/** How many suggestions the UI shows. */
const WANTED = 3;

/**
 * Upper bound on candidates embedded. They all go in one request, so this is a
 * token budget rather than a round-trip budget.
 */
const MAX_CANDIDATES = 24;

const lastSegment = (headingPath: string): string =>
  (headingPath.split('>').pop() ?? headingPath).trim();

/**
 * Page titles are written for search engines. Strip the brand tail, but only
 * drop the part after a colon when what precedes it can stand on its own —
 * otherwise "FAQ: Custom Websites & AI Models" becomes "FAQ".
 */
export function titleSubject(title: string): string {
  const head = title.split(/\s+[|–—·]\s+/)[0]?.trim() ?? title.trim();
  const kept = head.length >= 3 ? head : title.trim();
  const lead = (kept.split(/:\s+/)[0] ?? kept).trim();
  return lead.length >= 14 ? lead : kept;
}

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
 * type. "Get" and "start" are deliberately absent: "Getting started" is a real
 * section heading on any documentation site.
 */
const IS_CTA = /^(see|book|contact|call|e-?mail|join|sign\s?up|subscribe|download|request|discover|explore|find out|learn more|let'?s|tell us|talk to|ready to|don'?t miss|why wait)\b/i;

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
 * On a landing-page-only index - the default crawl - the headings are hero
 * copy and calls to action, so heading-derived suggestions are thin on the
 * ground. These fill the gap and read far better than "Tell me about
 * <marketing slogan>". They are guesses about what the page covers, which is
 * exactly why they go through the same verification as everything else: one
 * that the site does not answer is never shown.
 */
const GENERIC_PROBES = [
  'What does this company do?',
  'What services are offered?',
  'How much does it cost?',
  'How do I get in touch?',
  'Who is this for?',
];

export function buildCandidates(db: DB, sessionId: string): Candidate[] {
  const rows = db.prepare(`
    SELECT DISTINCT p.url AS url, p.title AS title, c.heading_path AS headingPath
    FROM chunks c JOIN pages p ON p.id = c.page_id
    WHERE c.session_id = ?
    ORDER BY p.id, c.id
  `).all(sessionId) as Array<{ url: string; title: string | null; headingPath: string | null }>;

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
    const segment = row.headingPath ? lastSegment(row.headingPath) : '';
    if (!segment || !usableHeading(segment)) continue;
    // A heading that is already a question is the best possible suggestion:
    // it is phrased the way a visitor would ask, and the site answers it.
    if (segment.endsWith('?')) add(segment, row.url, 0);
    else add(`Tell me about ${segment}`, row.url, 1);
  }

  // Generic questions, verified like everything else. They carry a landing
  // page, where the headings are slogans rather than subjects.
  const home = rows[0]?.url;
  if (home !== undefined) {
    for (const probe of GENERIC_PROBES) add(probe, home, 2);
  }

  // Titles are the last resort, for a site with no usable headings at all.
  for (const row of rows) {
    if (row.title) add(`Tell me about ${titleSubject(row.title)}`, row.url, 3);
  }

  return out.sort((a, b) => a.rank - b.rank).slice(0, MAX_CANDIDATES);
}

/**
 * Build suggestions and keep only those that clear the retrieval gate.
 *
 * Costs exactly one embedding request regardless of how many candidates there
 * are: they are embedded together and then ranked in memory against vectors the
 * session already holds. That matters on a rate-limited key, where round trips
 * are the scarce resource.
 */
export async function generateStarters(
  db: DB,
  sessionId: string,
  embedder: Embedder,
): Promise<Starter[]> {
  const candidates = buildCandidates(db, sessionId);
  if (candidates.length === 0) return [];

  const { vectors } = await embedder.embed(candidates.map((c) => c.text), 'query');

  // Rank every candidate first, keeping only the ones the gate would answer.
  const passing: Array<{ candidate: Candidate; cites: string[] }> = [];
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i] as Candidate;
    const vector = vectors[i];
    if (!vector) continue;

    const result = rankWithVector(db, sessionId, candidate.text, vector);
    if (result.insufficient) continue;
    passing.push({ candidate, cites: result.chunks.map((c) => c.url) });
  }

  // Spread across pages where there are pages to spread across, but never at
  // the cost of showing fewer suggestions. A landing-page-only index - the
  // default crawl - has exactly one page, and starving it down to a single
  // suggestion would punish the common case.
  const chosen: Starter[] = [];
  const usedPages = new Set<string>();
  const taken = new Set<Candidate>();

  for (const { candidate, cites } of passing) {
    if (chosen.length >= WANTED) break;
    const fresh = cites.find((u) => !usedPages.has(u));
    if (fresh === undefined) continue;
    usedPages.add(fresh);
    taken.add(candidate);
    chosen.push({ text: candidate.text, url: fresh });
  }

  for (const { candidate, cites } of passing) {
    if (chosen.length >= WANTED) break;
    if (taken.has(candidate)) continue;
    chosen.push({ text: candidate.text, url: cites[0] ?? candidate.url });
  }

  return chosen;
}
