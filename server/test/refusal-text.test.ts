import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { refusalSuggestions, refusalText } from '../src/chat/chat.js';

/**
 * A refusal is the moment the visitor is judging whether this thing
 * understands their site, so what it suggests instead has to be something the
 * app will actually answer. It used to read page titles back ("You could ask
 * about FAQ, Web Developer in Pampanga or AI Programmer in Pampanga") - SEO
 * copy, two of which the app itself refused. It now offers the session's
 * suggested questions, each already verified to be answerable.
 */

const SID = 'refusal-session-000001';
let db: DB;

function withStarters(starters: string | null): void {
  db.prepare(
    `INSERT INTO sessions (id, origin_url, domain, status, created_at, expires_at, starters)
     VALUES (?, 'https://acme.test', 'acme.test', 'ready', ?, ?, ?)`,
  ).run(SID, Date.now(), Date.now() + 86_400_000, starters);
}

beforeEach(() => { db = openDb(':memory:'); });

describe('refusal suggestions', () => {
  it('offers verified suggested questions, quoted, at most two', () => {
    withStarters(JSON.stringify([
      { text: 'What does this company do?', url: 'https://acme.test/' },
      { text: 'Tell me about Kitchen Fitouts', url: 'https://acme.test/' },
      { text: 'How do I get in touch?', url: 'https://acme.test/' },
    ]));
    const text = refusalText(refusalSuggestions(db, SID, 'do you sell helicopters?'));
    expect(text).toBe("The site doesn't cover that. You could ask “What does this company do?” or “Tell me about Kitchen Fitouts” instead.");
  });

  it('never suggests the question that was just refused', () => {
    withStarters(JSON.stringify([
      { text: 'How much does it cost?', url: 'https://acme.test/' },
      { text: 'How do I get in touch?', url: 'https://acme.test/' },
    ]));
    expect(refusalSuggestions(db, SID, '  how much does it cost? ')).toEqual(['How do I get in touch?']);
  });

  it('says nothing more than the refusal when there is nothing verified to offer', () => {
    withStarters(null); // still being verified
    expect(refusalText(refusalSuggestions(db, SID, 'x'))).toBe("The site doesn't cover that.");

    db = openDb(':memory:');
    withStarters('[]'); // verified, none survived
    expect(refusalSuggestions(db, SID, 'x')).toEqual([]);

    db = openDb(':memory:');
    withStarters('not json');
    expect(refusalSuggestions(db, SID, 'x')).toEqual([]);
  });

  it('never carries a citation marker', () => {
    // A citation asserts the site says something. A refusal says it does not.
    expect(refusalText(['Tell me about pricing', 'How do I get in touch?'])).not.toMatch(/\[\d+\]/);
    expect(refusalText([])).not.toMatch(/\[\d+\]/);
  });
});
