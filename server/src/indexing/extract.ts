import * as cheerio from 'cheerio';
import type { CheerioAPI, Cheerio } from 'cheerio';
import type { Element } from 'domhandler';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
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
  method: 'readability' | 'fallback';
}

const STRIP = 'script, style, nav, header, footer, aside, noscript, iframe, form, svg, template, [aria-hidden="true"], [role="navigation"], [role="banner"], [role="contentinfo"], .cookie, #cookie-banner, .sr-only';

const BLOCK_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, dd, dt, blockquote, pre, td, th, figcaption';

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

/** Walk block elements in document order, tracking the h1-h3 heading path. */
function walkSections($: CheerioAPI, root: Cheerio<Element>): Section[] {
  const sections: Section[] = [];
  const path: string[] = ['', '', '']; // h1, h2, h3
  let buffer: string[] = [];
  let bufferPath = '';

  const currentPath = (): string => path.filter(Boolean).join(' > ');

  const flush = (): void => {
    const text = collapse(buffer.join('\n'));
    if (text.length > 0) sections.push({ headingPath: bufferPath, text });
    buffer = [];
  };

  bufferPath = currentPath();

  root.find(BLOCK_SELECTOR).each((_, el) => {
    const node = $(el);
    const tag = (el.tagName || '').toLowerCase();
    const text = collapse(node.text());
    if (!text) return;

    if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
      flush();
      const level = Number(tag[1]) - 1;
      path[level] = text;
      for (let i = level + 1; i < path.length; i++) path[i] = '';
      bufferPath = currentPath();
      return;
    }

    if (tag === 'h4' || tag === 'h5' || tag === 'h6') {
      buffer.push(text);
      return;
    }

    buffer.push(text);
  });

  flush();
  return sections;
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
 * Main-content extraction. Readability first; if it comes back thin, fall back
 * to stripping chrome off the raw DOM. Links always come from the raw document
 * so nav links stay available to the crawler even when Readability drops them.
 */
export function extract(html: string, url: string): Extracted {
  const $raw = cheerio.load(html);
  const links = extractLinks($raw, url);

  const rawTitle = collapse($raw('title').first().text())
    || collapse($raw('meta[property="og:title"]').attr('content') ?? '')
    || collapse($raw('h1').first().text());

  // Readability mutates the DOM it is given, so hand it its own copy.
  // jsdom parsing is synchronous and superlinear; on a multi-megabyte page it
  // stalls every crawl worker at once. Past this size the cheerio path only.
  const READABILITY_MAX_HTML = 800_000;

  let readabilityHtml: string | null = null;
  let readabilityTitle = '';
  try {
    if (html.length > READABILITY_MAX_HTML) throw new Error('too large for readability');
    const virtualConsole = new VirtualConsole(); // swallow page JS/CSS parse noise
    virtualConsole.on('error', () => {});
    virtualConsole.on('jsdomError', () => {});
    const dom = new JSDOM(html, { url, virtualConsole });
    const article = new Readability(dom.window.document, { charThreshold: 200 }).parse();
    if (article) {
      readabilityHtml = article.content ?? null;
      readabilityTitle = collapse(article.title ?? '');
    }
    dom.window.close();
  } catch { /* fall through to the cheerio path */ }

  if (readabilityHtml) {
    const $r = cheerio.load(readabilityHtml);
    const body = $r('body');
    const text = collapse(body.text());
    if (text.length >= 200) {
      return {
        title: readabilityTitle || rawTitle,
        text,
        sections: walkSections($r, body as Cheerio<Element>),
        links,
        method: 'readability',
      };
    }
  }

  // Fallback: strip chrome, then take the most specific container available.
  const $f = cheerio.load(html);
  $f(STRIP).remove();
  let container = $f('main').first();
  if (container.length === 0) container = $f('article').first();
  if (container.length === 0) container = $f('body').first();
  if (container.length === 0) container = $f.root() as unknown as Cheerio<Element>;

  const text = collapse(container.text());
  return {
    title: rawTitle,
    text,
    sections: walkSections($f, container as Cheerio<Element>),
    links,
    method: 'fallback',
  };
}
