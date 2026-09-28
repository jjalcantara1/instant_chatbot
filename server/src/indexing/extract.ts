import * as cheerio from 'cheerio';
import type { CheerioAPI, Cheerio } from 'cheerio';
import type { AnyNode, Element, Text } from 'domhandler';
import { normaliseUrl, sameSite, hasSkippableExtension } from '../crawl/urlnorm.js';

export interface Section {
  /** e.g. "Services > Commercial Fitouts" */
  headingPath: string;
  text: string;
}

export interface Extracted {
  title: string;
  text: string;
  sections: Section[];
  links: string[];
  /** Where the text was read from: the page's <main>, its only <article>, or the whole <body>. */
  container: 'main' | 'article' | 'body';
}

/**
 * Never content: code, media, page-level navigation, forms and overlays.
 * Headers and footers are handled separately, because only the page-level
 * ones are chrome.
 */
const STRIP = [
  'script', 'style', 'noscript', 'template', 'iframe', 'svg', 'canvas', 'nav', 'aside', 'form', 'dialog',
  '[aria-hidden="true"]', '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="search"]',
  '.cookie', '#cookie-banner', '.sr-only',
].join(', ');

/**
 * Elements that flow inline with the text around them. Everything else starts
 * a new line, the way a browser lays it out.
 */
const INLINE = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'button', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', 'ins',
  'kbd', 'label', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var',
]);

/**
 * Two runs of text from different elements, with no whitespace between them in
 * the markup: `<a>Tell us what you need</a><a>See our work</a>`. A browser
 * separates them with layout (flex gaps, inline-block margins) that a crawler
 * never sees, so without a space they fuse into "needSee" - a token that
 * matches nothing and reads as broken.
 */
const ENDS_WORD = /[\p{L}\p{N}.!?:;,)]$/u;
const STARTS_WORD = /^[\p{L}\p{N}(]/u;

export function collapse(s: string): string {
  return s
    .replace(/ /g, ' ')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
}

/** The text of one element on a single line: headings, and the title fallback. */
function inlineText(el: Element): string {
  let out = '';
  let boundary = false;
  const visit = (node: AnyNode): void => {
    if (node.type === 'text') {
      const t = (node as Text).data;
      if (boundary && ENDS_WORD.test(out) && STARTS_WORD.test(t)) out += ' ';
      out += t;
      boundary = false;
      return;
    }
    if (node.type !== 'tag') return;
    if ((node as Element).name === 'br') { out += ' '; return; }
    boundary = true;
    for (const child of (node as Element).children) visit(child);
    boundary = true;
  };
  for (const child of el.children) visit(child);
  return out.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Reads a container the way it renders: every text node exactly once, in
 * document order, with h1-h3 opening sections and block elements breaking
 * lines. Walking text nodes rather than a fixed list of block tags is what
 * picks up text that lives in bare <div>s - card grids, hero copy, contact
 * details - which is most of a modern landing page. It also avoids reading a
 * paragraph twice when it sits inside a list item or a table cell.
 */
class TextWalker {
  readonly sections: Section[] = [];
  /** Every line on the page, headings included, in order. */
  readonly lines: string[] = [];
  private readonly path: [string, string, string] = ['', '', ''];
  private sectionPath = '';
  private body: string[] = [];
  private line = '';
  private boundary = false;

  walk(nodes: AnyNode[]): Section[] {
    for (const node of nodes) this.visit(node);
    this.flushSection();
    return this.sections;
  }

  private visit(node: AnyNode): void {
    if (node.type === 'text') { this.append((node as Text).data); return; }
    if (node.type !== 'tag') return;

    const el = node as Element;
    const tag = el.name.toLowerCase();

    if (tag === 'br') { this.breakLine(); return; }
    if (tag === 'wbr') return;

    if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
      const text = inlineText(el);
      if (!text) return;
      this.flushSection();
      const level = Number(tag[1]) - 1;
      this.path[level] = text;
      for (let i = level + 1; i < this.path.length; i++) this.path[i] = '';
      this.sectionPath = this.path.filter(Boolean).join(' > ');
      this.lines.push(text);
      return;
    }

    // Cells in a row stay on one line, so a pricing table keeps "Starter |
    // $10/month | 3 projects" together instead of scattering it.
    if (tag === 'td' || tag === 'th') {
      if (this.line.trim()) { this.line += ' | '; this.boundary = false; }
      for (const child of el.children) this.visit(child);
      return;
    }

    if (INLINE.has(tag)) {
      this.boundary = true;
      for (const child of el.children) this.visit(child);
      this.boundary = true;
      return;
    }

    this.breakLine();
    for (const child of el.children) this.visit(child);
    this.breakLine();
  }

  private append(raw: string): void {
    if (!raw) return;
    const text = raw.replace(/ /g, ' ');
    if (this.boundary && ENDS_WORD.test(this.line) && STARTS_WORD.test(text)) this.line += ' ';
    this.line += text;
    this.boundary = false;
  }

  private breakLine(): void {
    const text = this.line.replace(/\s+/g, ' ').trim();
    if (text) {
      this.body.push(text);
      this.lines.push(text);
    }
    this.line = '';
    this.boundary = false;
  }

  private flushSection(): void {
    this.breakLine();
    const text = this.body.join('\n').trim();
    if (text) this.sections.push({ headingPath: this.sectionPath, text });
    this.body = [];
  }
}

function extractLinks($: CheerioAPI, baseUrl: string): string[] {
  const out = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const t = href.trim();
    if (!t || t.startsWith('#') || t.startsWith('mailto:') || t.startsWith('tel:') || t.startsWith('javascript:')) return;
    const norm = normaliseUrl(t, baseUrl);
    if (!norm) return;
    if (!sameSite(norm, baseUrl)) return;
    if (hasSkippableExtension(norm)) return;
    out.add(norm);
  });
  return [...out];
}

/**
 * A semantic container is trusted unless it is clearly not where the content
 * is: a stray <main> around one widget on a page whose text lives elsewhere.
 */
function holdsTheContent(container: Cheerio<Element>, bodyChars: number): boolean {
  const chars = collapse(container.text()).length;
  return chars >= 200 || chars * 4 >= bodyChars;
}

function pickContainer($: CheerioAPI): { node: Cheerio<Element>; kind: Extracted['container'] } {
  const body = $('body').first() as Cheerio<Element>;
  const bodyChars = collapse(body.text()).length;

  const main = $('main, [role="main"]').first() as Cheerio<Element>;
  if (main.length > 0 && holdsTheContent(main, bodyChars)) return { node: main, kind: 'main' };

  // One <article> is the page's content. Several is a listing, and picking the
  // first would index one card out of twenty.
  const articles = $('article') as Cheerio<Element>;
  if (articles.length === 1 && holdsTheContent(articles, bodyChars)) return { node: articles, kind: 'article' };

  return { node: body.length > 0 ? body : ($.root() as unknown as Cheerio<Element>), kind: 'body' };
}

/**
 * Main-content extraction, in one parse.
 *
 * This used to be Readability, falling back to a cheerio pass when it came
 * back thin. Readability is built to find the article in a page, and a
 * landing page is not an article: on kleiosoftware.com it kept one block and
 * discarded the services grid, every case study and the contact details, so
 * the default one-page index told visitors that the site did not cover things
 * printed on its own front page. Across 20 pages on 12 sites it kept 66% of
 * the content text; reading the semantic container directly keeps 87%, with
 * no more navigation or footer text leaking in. It is also 5-14x faster, and
 * that matters twice over, because parsing is synchronous: while jsdom worked
 * through a page, every other visitor's stream stalled behind it.
 *
 * Links always come from the whole document, before anything is stripped, so
 * nav links stay available to the crawler even though nav text is not indexed.
 */
export function extract(html: string, url: string): Extracted {
  const $ = cheerio.load(html);
  const links = extractLinks($, url);

  const firstH1 = $('h1').first().get(0);
  const title = collapse($('title').first().text())
    || collapse($('meta[property="og:title"]').attr('content') ?? '')
    || (firstH1 ? inlineText(firstH1) : '');

  $(STRIP).remove();
  // A page-level header or footer is chrome. One inside <main> or <article> is
  // content: an article's title block, or a landing page's hero.
  $('header, footer').filter((_, el) => $(el).closest('main, article, [role="main"]').length === 0).remove();

  const { node, kind } = pickContainer($);
  const walker = new TextWalker();
  const sections = walker.walk(node.get(0)?.children ?? []);

  return { title, text: walker.lines.join('\n'), sections, links, container: kind };
}
