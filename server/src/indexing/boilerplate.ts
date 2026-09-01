/**
 * Nav text, cookie notices and footers survive extraction on plenty of sites.
 * A line that shows up on most pages carries no page-specific information, so
 * it is noise in every chunk it lands in and actively hurts retrieval.
 *
 * Computed across the whole crawl, so it has to run after crawling and before
 * chunking.
 */

const THRESHOLD = 0.6;
/** Below this many pages the frequency statistic is meaningless. */
const MIN_PAGES = 4;
/** Long lines that repeat are usually real shared content (a mission statement). */
const MAX_BOILERPLATE_LINE = 200;

export function findBoilerplateLines(pageTexts: string[]): Set<string> {
  const out = new Set<string>();
  if (pageTexts.length < MIN_PAGES) return out;

  const counts = new Map<string, number>();
  for (const text of pageTexts) {
    // Count each distinct line once per page, not once per occurrence.
    const lines = new Set(
      text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0),
    );
    for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  }

  const limit = pageTexts.length * THRESHOLD;
  for (const [line, count] of counts) {
    if (count > limit && line.length <= MAX_BOILERPLATE_LINE) out.add(line);
  }
  return out;
}

export function stripBoilerplate(text: string, boilerplate: Set<string>): string {
  if (boilerplate.size === 0) return text;
  return text
    .split('\n')
    .filter((l) => !boilerplate.has(l.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
