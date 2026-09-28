import { describe, it, expect } from 'vitest';
import { chunkPage, packSections } from '../src/indexing/chunk.js';

/**
 * Cards, process steps and contact details are each a heading and a line. On
 * their own they fall under the 80-character floor and used to vanish, taking
 * a page's most specific facts with them. Packed with their siblings they
 * survive, and one chunk answers "what do you offer?".
 */

const grid = [
  { headingPath: 'Studio > What we do', text: 'Five things we do really well.' },
  { headingPath: 'Studio > What we do > Portfolio Websites', text: 'A site that turns visitors into clients.' },
  { headingPath: 'Studio > What we do > Custom Websites', text: 'Fast, custom-built sites and web apps.' },
  { headingPath: 'Studio > What we do > Custom AI Models', text: 'Your own AI, trained on your data.' },
];

describe('packSections', () => {
  it('packs a section with its cards, inlining each card heading', () => {
    const packed = packSections(grid);
    expect(packed).toHaveLength(1);
    expect(packed[0]?.headingPath).toBe('Studio > What we do');
    expect(packed[0]?.text).toBe([
      'Five things we do really well.',
      'Portfolio Websites', 'A site that turns visitors into clients.',
      'Custom Websites', 'Fast, custom-built sites and web apps.',
      'Custom AI Models', 'Your own AI, trained on your data.',
    ].join('\n'));
    expect(packed[0]?.headings).toEqual(grid.map((g) => g.headingPath));
  });

  it('never packs across into a different section', () => {
    const packed = packSections([
      ...grid,
      { headingPath: 'Studio > Contact', text: 'Every message comes straight to us.' },
      { headingPath: 'Studio > Contact > Email', text: 'hello@acme.test' },
    ]);
    expect(packed.map((p) => p.headingPath)).toEqual(['Studio > What we do', 'Studio > Contact']);
    expect(packed[1]?.text).toContain('hello@acme.test');
  });

  it('starts a new chunk when the next card would overflow the target size', () => {
    const cards = Array.from({ length: 6 }, (_, i) => ({
      headingPath: `Studio > Work > Project ${i}`,
      text: `Project ${i} was a long engagement. `.repeat(6).trim(),
    }));
    const packed = packSections(cards);
    expect(packed.length).toBeGreaterThan(1);
    for (const p of packed) expect(p.text.length).toBeLessThanOrEqual(800);
    expect(packed.flatMap((p) => p.headings)).toEqual(cards.map((c) => c.headingPath));
  });

  it('leaves a long section on its own', () => {
    const long = { headingPath: 'Studio > Story', text: 'We started small and stayed small on purpose. '.repeat(30).trim() };
    const packed = packSections([grid[1] as (typeof grid)[number], long]);
    expect(packed.map((p) => p.headingPath)).toEqual(['Studio > What we do > Portfolio Websites', 'Studio > Story']);
  });
});

describe('chunkPage', () => {
  it('keeps a one-line fact that used to fall under the size floor', () => {
    const chunks = chunkPage('Acme Studio', [
      { headingPath: 'Studio > Contact', text: 'Every message comes straight to us.' },
      { headingPath: 'Studio > Contact > Email', text: 'hello@acme.test' },
      { headingPath: 'Studio > Contact > Call', text: 'A quick 15 to 45 minute chat.' },
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain('hello@acme.test');
    expect(chunks[0]?.text).toContain('15 to 45 minute');
    expect(chunks[0]?.embedText.startsWith('Acme Studio — Studio > Contact\n\n')).toBe(true);
  });

  it('records the headings in every chunk of a split section', () => {
    const long = { headingPath: 'Studio > Story', text: 'We started small and stayed small on purpose. '.repeat(40).trim() };
    const chunks = chunkPage('Acme Studio', [long]);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.headings).toEqual(['Studio > Story']);
  });

  it('still drops a lone scrap of text', () => {
    expect(chunkPage('Acme Studio', [{ headingPath: 'Footer', text: 'See all work' }])).toEqual([]);
  });
});
