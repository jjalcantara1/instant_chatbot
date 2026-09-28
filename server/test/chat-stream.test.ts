import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { toBlob, type Embedder, type EmbedResult } from '../src/indexing/embed.js';
import { invalidateSession } from '../src/retrieve/retrieve.js';
import { CitationStripper, streamAnswer } from '../src/chat/chat.js';
import type { ChatModel } from '../src/chat/providers.js';

/**
 * A refusal cites nothing: a citation asserts the site says something, and a
 * refusal says it does not. The prompt asks for that, and the model still
 * sometimes declines and then appends "[1][2][3]". So it is enforced on the
 * stream: a reply that opens by declining loses its citations, and everything
 * else streams untouched from its first token.
 */

const SID = 'chat-stream-session-01';
let db: DB;

const embedder: Embedder = {
  name: 'fixed',
  dims: 2,
  embed: (texts: string[]): Promise<EmbedResult> =>
    Promise.resolve({ vectors: texts.map(() => new Float32Array([1, 0])), tokens: 1 }),
};

/** A chat model that replies with exactly these pieces, in this order. */
function replying(...pieces: string[]): ChatModel {
  return {
    provider: 'test',
    name: 'scripted',
    async *stream() {
      for (const p of pieces) yield p;
      return { inputTokens: 10, outputTokens: 5 };
    },
  };
}

async function answer(model: ChatModel): Promise<{ tokens: string[]; text: string; sources: number }> {
  const tokens: string[] = [];
  let sources = -1;
  for await (const e of streamAnswer({
    db, sessionId: SID, domain: 'acme.test', question: 'anything', history: [], embedder, model,
  })) {
    if (e.type === 'token') tokens.push(e.text);
    else if (e.type === 'sources') sources = e.sources.length;
  }
  return { tokens, text: tokens.join(''), sources };
}

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare(
    `INSERT INTO sessions (id, origin_url, domain, status, created_at, expires_at)
     VALUES (?, 'https://acme.test', 'acme.test', 'ready', ?, ?)`,
  ).run(SID, Date.now(), Date.now() + 86_400_000);
  const pageId = Number(db.prepare(
    `INSERT INTO pages (session_id, url, title, status, char_count)
     VALUES (?, 'https://acme.test/', 'Home', 'ok', 900)`,
  ).run(SID).lastInsertRowid);
  db.prepare(
    `INSERT INTO chunks (session_id, page_id, heading_path, text, tokens, embedding)
     VALUES (?, ?, 'About', 'Acme is based in Springfield and builds websites.', 10, ?)`,
  ).run(SID, pageId, toBlob(new Float32Array([1, 0])));
  invalidateSession(SID);
});

describe('refusals from the model', () => {
  it('carry no citations, whatever the model appended', async () => {
    const r = await answer(replying('The site does not cover', ' refunds [1][2]', '[3]. You could ask about pricing.'));
    expect(r.text).toBe('The site does not cover refunds. You could ask about pricing.');
    expect(r.sources).toBe(0);
  });

  it('lose a citation marker split across two pieces', async () => {
    const r = await answer(replying("The site doesn't cover that [", '1] at all.'));
    expect(r.text).toBe("The site doesn't cover that at all.");
    expect(r.sources).toBe(0);
  });

  it('are recognised when the model pads the refusal with a related fact', async () => {
    const r = await answer(replying(
      'The site does not explicitly state whether it ships abroad, ',
      'though it does mention building websites [1].',
    ));
    expect(r.text).not.toMatch(/\[\d\]/);
    expect(r.sources).toBe(0);
  });
});

describe('answers from the model', () => {
  it('keep their citations and stream from the first piece', async () => {
    const r = await answer(replying('Acme is based ', 'in Springfield [1].'));
    expect(r.tokens[0]).toBe('Acme is based ');
    expect(r.text).toBe('Acme is based in Springfield [1].');
    expect(r.sources).toBe(1);
  });

  it('are not mistaken for refusals because they begin "The site"', async () => {
    const r = await answer(replying('The site ', 'lists three plans [1].'));
    expect(r.text).toBe('The site lists three plans [1].');
    expect(r.sources).toBe(1);
  });
});

describe('CitationStripper', () => {
  it('strips markers however the stream is cut', () => {
    const text = 'Not covered [12] here [3].';
    for (let cut = 0; cut <= text.length; cut++) {
      const s = new CitationStripper();
      const out = s.push(text.slice(0, cut)) + s.push(text.slice(cut)) + s.flush();
      expect(out, `cut at ${cut}`).toBe('Not covered here.');
    }
  });
});
