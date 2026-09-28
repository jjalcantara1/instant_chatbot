import { describe, it, expect } from 'vitest';
import { extract } from '../src/indexing/extract.js';

/**
 * Extraction decides what the index can ever know. The default index is one
 * landing page, and a landing page is built from cards, heroes and contact
 * blocks in bare <div>s - the shape Readability, which looks for an article,
 * used to discard.
 */

const page = (body: string, head = '<title>Acme Studio | Acme</title>'): string =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

const all = (html: string): string => extract(html, 'https://acme.test/').sections.map((s) => s.text).join('\n');

describe('extract', () => {
  it('keeps a card grid of bare divs, and drops navigation and the page footer', () => {
    const html = page(`
      <header><nav><a href="/about">About us</a><a href="/work">Our work</a></nav></header>
      <main>
        <h1>We build websites</h1>
        <section>
          <h2>What we do</h2>
          <div class="grid">
            <div class="card"><h3>Portfolio Websites</h3><div>A site that turns visitors into clients.</div></div>
            <div class="card"><h3>Custom AI Models</h3><div>Your own AI, trained on your data.</div></div>
          </div>
        </section>
        <section><h2>Contact</h2><div>hello@acme.test</div></section>
      </main>
      <footer><div>© Acme Studio. All rights reserved.</div></footer>
    `);
    const ex = extract(html, 'https://acme.test/');
    const text = ex.sections.map((s) => s.text).join('\n');

    expect(ex.container).toBe('main');
    expect(text).toContain('A site that turns visitors into clients.');
    expect(text).toContain('Your own AI, trained on your data.');
    expect(text).toContain('hello@acme.test');
    expect(text).not.toContain('About us');
    expect(text).not.toContain('All rights reserved');
    expect(ex.sections.map((s) => s.headingPath)).toContain('We build websites > What we do > Custom AI Models');
    // Nav text is not indexed, but the crawler still needs its links.
    expect(ex.links).toEqual(expect.arrayContaining(['https://acme.test/about', 'https://acme.test/work']));
  });

  it('keeps a header that belongs to the content', () => {
    const html = page(`
      <header><div>Site banner</div></header>
      <main><article><header><h1>How pricing works</h1><p>Posted in March</p></header>
      <p>Every project gets a fixed quote after a free call.</p></article></main>
    `);
    const ex = extract(html, 'https://acme.test/');
    expect(ex.sections[0]?.headingPath).toBe('How pricing works');
    expect(all(html)).toContain('Posted in March');
    expect(all(html)).not.toContain('Site banner');
  });

  it('does not fuse adjacent inline elements into one word', () => {
    const html = page('<main><p><a href="/a">Tell us what you need</a><a href="/b">See our work</a></p><p><span>01</span><span>Website</span><span>2026</span></p></main>');
    const text = all(html);
    expect(text).toContain('Tell us what you need See our work');
    expect(text).toContain('01 Website 2026');
  });

  it('leaves ordinary inline markup alone', () => {
    const text = all(page('<main><p>Hello <b>world</b>! Prices from $<span>10</span>/month.</p></main>'));
    expect(text).toBe('Hello world! Prices from $10/month.');
  });

  it('reads a heading split by a line break as one line', () => {
    const ex = extract(page('<main><h1>You imagine it.<br>We build it for you.</h1><p>Custom websites and AI tools.</p></main>'), 'https://acme.test/');
    expect(ex.sections[0]?.headingPath).toBe('You imagine it. We build it for you.');
  });

  it('keeps a table row on one line', () => {
    const text = all(page(`<main><table>
      <tr><th>Plan</th><th>Price</th></tr>
      <tr><td>Starter</td><td>$10/month</td></tr>
    </table></main>`));
    expect(text).toContain('Plan | Price');
    expect(text).toContain('Starter | $10/month');
  });

  it('reads a paragraph inside a list item once, not twice', () => {
    const text = all(page('<main><ul><li><p>Discovery call, free of charge.</p></li></ul></main>'));
    expect(text.match(/Discovery call/g)).toHaveLength(1);
  });

  it('reads a single article, but the whole body of a listing', () => {
    const one = extract(page('<article><h1>One post</h1><p>Body of the only article on the page, long enough to count.</p></article>'), 'https://acme.test/');
    expect(one.container).toBe('article');

    const listing = extract(page(`
      <article><h2>First post</h2><p>Summary of the first post.</p></article>
      <article><h2>Second post</h2><p>Summary of the second post.</p></article>
    `), 'https://acme.test/');
    expect(listing.container).toBe('body');
    expect(listing.sections.map((s) => s.text).join('\n')).toContain('Summary of the second post.');
  });

  it('ignores a <main> that is clearly not where the content is', () => {
    const html = page(`
      <main><div>Menu</div></main>
      <div id="content"><h1>About the studio</h1><p>${'We design and build custom websites for small businesses. '.repeat(6)}</p></div>
    `);
    const ex = extract(html, 'https://acme.test/');
    expect(ex.container).toBe('body');
    expect(ex.sections.map((s) => s.text).join('\n')).toContain('custom websites for small businesses');
  });

  it('takes the title from <title>, then og:title, then the first h1', () => {
    expect(extract(page('<main><p>x</p></main>'), 'https://acme.test/').title).toBe('Acme Studio | Acme');
    expect(extract(page('<main><h1>Big<br>Heading</h1></main>', ''), 'https://acme.test/').title).toBe('Big Heading');
  });
});
