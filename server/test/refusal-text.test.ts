import { describe, it, expect } from 'vitest';
import { cleanTitle } from '../src/chat/chat.js';

/**
 * Titles are SEO copy. A refusal that reads them back verbatim sounds like a
 * machine reciting metadata, which is exactly the moment the visitor is judging
 * whether this thing understands their site.
 */
describe('cleanTitle', () => {
  it('drops the repeated brand tail', () => {
    expect(cleanTitle('FAQ: Custom Websites & AI Models in Pampanga | Kleio')).toBe('FAQ');
    expect(cleanTitle('Our Work: Websites, AI Tools & Research Projects | Kleio')).toBe('Our Work');
  });

  it('handles dash and middot separators', () => {
    expect(cleanTitle('Pricing – Acme')).toBe('Pricing');
    expect(cleanTitle('Contact · Acme')).toBe('Contact');
  });

  it('leaves a plain title alone', () => {
    expect(cleanTitle('About us')).toBe('About us');
  });

  it('keeps the title when the lead segment is too short to be meaningful', () => {
    expect(cleanTitle('Go | Acme Corporation')).toBe('Go | Acme Corporation');
  });

  it('never returns an empty string for a non-empty title', () => {
    for (const t of ['A | B', 'X: Y', 'Home', 'Book a Free Discovery Call | Kleio, Pampanga']) {
      expect(cleanTitle(t).length).toBeGreaterThan(0);
    }
  });
});
