import type { DB } from '../db.js';
import { getEmbedder, type Embedder } from '../indexing/embed.js';
import { retrieve, type RetrievedChunk } from '../retrieve/retrieve.js';
import { getChatModel, type ChatModel, type ChatTurn } from './providers.js';

export interface ChatSource {
  n: number;
  url: string;
  title: string;
  headingPath: string;
}

export type ChatEvent =
  // Retrieval embeds the question before the model is even called, which on a
  // throttled embedding tier is seconds of silence. Say which phase we are in
  // so the UI can show something truthful rather than a frozen caret.
  | { type: 'status'; stage: 'retrieving' | 'generating' }
  | { type: 'token'; text: string }
  | { type: 'sources'; sources: ChatSource[] }
  | { type: 'done'; inputTokens: number; outputTokens: number; model?: string }
  | { type: 'error'; message: string };

function buildSystemPrompt(domain: string, chunks: RetrievedChunk[]): string {
  const excerpts = chunks
    .map((c, i) => {
      const header = [c.url, c.headingPath].filter(Boolean).join(' — ');
      return `[${i + 1}] ${header}\n${c.text}`;
    })
    .join('\n\n');

  return `You answer questions about ${domain} using only the excerpts provided below.

Rules:
- Use only the excerpts. Do not use outside knowledge about this company or any other.
- Answer from what the excerpts DO say. If they answer the question without the
  exact detail asked — the site explains how pricing works without printing a
  number, say — then give what the site does say and cite it. That is a real
  answer, not a refusal. Declining here would be wrong and unhelpful.
- Short or vague questions still deserve an answer. Read "how much" as a
  question about pricing and answer it from the pricing excerpts.
- Decline when the excerpts do not answer what was asked. Sharing a topic is not
  an answer: excerpts describing a bakery's cakes do not say whether it
  delivers. Then say plainly that the site does not cover it, suggest what the
  visitor could ask instead, and cite NO page numbers anywhere in the reply —
  not on the suggestion either. Do not pad a refusal with related facts. A
  citation means the site genuinely says this, so citing a page while declining
  is wrong. A reply that declines contains no [1] or [2].
- Cite the pages you used by their number, like [1] or [2][3], but only when you
  are actually answering from them.
- Be concise. Two or three sentences unless more is genuinely needed.
- Never refer to the material you were given, in any wording. Not "excerpts",
  "context", "chunks", "documents", "the provided information", "the provided
  pages", or "based on the information available". Speak as if you simply know
  this site: say "the site doesn't cover that", never "the text does not mention that".

Excerpts:
${excerpts}`;
}

/**
 * How a declining reply opens. The prompt tells the model to say "the site
 * doesn't cover that" in exactly these words, so the opening is where a
 * refusal announces itself.
 */
const REFUSAL_OPENING = /^\s*the site (?:doesn['’]t|does not|didn['’]t|did not)(?: explicitly| specifically| directly)? (?:cover|say|mention|state|specify|include|list|address|describe)/i;

/** Held back until the opening can be judged; a sentence end decides sooner. */
const OPENING_CHARS = 48;

/**
 * Removes [n] citation markers from a stream of text, including a marker split
 * across two pieces ("[" then "1]").
 */
export class CitationStripper {
  private carry = '';

  push(text: string): string {
    const s = this.carry + text;
    // Trailing whitespace is held too: if the next piece opens with a marker,
    // the space before it goes with it.
    const tail = /\s*(?:\[\d{0,2})?$/.exec(s) as RegExpExecArray;
    this.carry = tail[0];
    return s.slice(0, tail.index).replace(/\s*\[\d{1,2}\]/g, '');
  }

  flush(): string {
    const rest = this.carry.replace(/\s*\[\d{1,2}\]/g, '');
    this.carry = '';
    return rest;
  }
}

/** Pull [1], [2][3] out of the finished text and map back to real pages. */
export function parseCitations(text: string, chunks: RetrievedChunk[]): ChatSource[] {
  const cited = new Set<number>();
  for (const m of text.matchAll(/\[(\d{1,2})\]/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= chunks.length) cited.add(n);
  }

  // One source per page, keeping the lowest citation number for each.
  const byUrl = new Map<string, ChatSource>();
  for (const n of [...cited].sort((a, b) => a - b)) {
    const c = chunks[n - 1] as RetrievedChunk;
    if (!byUrl.has(c.url)) {
      byUrl.set(c.url, { n, url: c.url, title: c.title || c.url, headingPath: c.headingPath });
    }
  }
  return [...byUrl.values()];
}

/**
 * What to offer instead when a question is refused: the session's suggested
 * questions, every one already verified to be answerable.
 *
 * This used to offer page titles. Titles are written for search engines, so a
 * refusal ended "You could ask about FAQ, Web Developer in Pampanga or AI
 * Programmer in Pampanga instead" - two of which the app would itself refuse,
 * the exact failure the suggested questions exist to prevent.
 */
export function refusalSuggestions(db: DB, sessionId: string, question: string): string[] {
  const row = db.prepare('SELECT starters FROM sessions WHERE id = ?')
    .get(sessionId) as { starters: string | null } | undefined;
  if (!row?.starters) return [];
  try {
    const parsed = JSON.parse(row.starters) as unknown;
    if (!Array.isArray(parsed)) return [];
    const asked = question.trim().toLowerCase();
    return parsed
      .map((s) => (s as { text?: unknown }).text)
      .filter((t): t is string => typeof t === 'string' && t.trim().toLowerCase() !== asked)
      .slice(0, 2);
  } catch {
    return [];
  }
}

export function refusalText(suggestions: string[]): string {
  const quoted = suggestions.map((s) => `“${s}”`);
  const hint = quoted.length === 0 ? '' : ` You could ask ${quoted.join(' or ')} instead.`;
  return `The site doesn't cover that.${hint}`;
}

export interface AnswerOptions {
  db: DB;
  sessionId: string;
  domain: string;
  question: string;
  history: ChatTurn[];
  embedder?: Embedder;
  model?: ChatModel;
}

export async function* streamAnswer(opts: AnswerOptions): AsyncGenerator<ChatEvent> {
  const { db, sessionId, domain, question } = opts;
  const embedder = opts.embedder ?? getEmbedder();

  yield { type: 'status', stage: 'retrieving' };

  // A follow-up ("who was it built for?") only makes sense next to the
  // question before it, so retrieval sees that too.
  const previousQuestion = [...opts.history].reverse().find((t) => t.role === 'user')?.content;

  let result;
  try {
    result = await retrieve(db, sessionId, question, embedder, previousQuestion);
  } catch (e) {
    yield { type: 'error', message: (e as Error).message };
    return;
  }

  // Nothing on the site is even close. Refuse here without calling the model:
  // it is deterministic, instant and free. Questions that are close enough to
  // reach the model are refused by the model when the excerpts do not answer
  // them, without citing anything.
  if (result.insufficient) {
    // Phrased like the model's own refusals so the two do not read as coming
    // from different products.
    const message = refusalText(refusalSuggestions(db, sessionId, question));
    for (const word of message.split(/(?<= )/)) {
      yield { type: 'token', text: word };
    }
    yield { type: 'sources', sources: [] };
    yield { type: 'done', inputTokens: 0, outputTokens: 0 };
    return;
  }

  const system = buildSystemPrompt(domain, result.chunks);
  const messages: ChatTurn[] = [
    ...opts.history.slice(-6),
    { role: 'user', content: question },
  ];

  let full = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let answeredBy: string | undefined;

  // A reply that opens by declining is a refusal, and a refusal cites nothing.
  // The prompt says so, and the model still sometimes declines and then
  // appends "[1][2][3]" - a citation asserting the site says something, on a
  // reply saying it does not. With the floor now low enough that absent
  // questions reach the model, that is enforced here rather than trusted.
  // Only a reply beginning "The site" is held back, and only until its
  // opening can be judged; anything else streams from its first token.
  let opening: string | null = '';
  let refusing = false;
  const stripper = new CitationStripper();
  const emit = (text: string): string => (refusing ? stripper.push(text) : text);

  yield { type: 'status', stage: 'generating' };

  try {
    const stream = (opts.model ?? getChatModel()).stream({ system, messages, maxTokens: 600 });

    // The generator yields deltas and returns usage, so drive it by hand to
    // keep hold of the return value.
    for (;;) {
      const next = await stream.next();
      if (next.done) {
        inputTokens = next.value.inputTokens;
        outputTokens = next.value.outputTokens;
        answeredBy = next.value.model;
        break;
      }
      full += next.value;

      if (opening !== null) {
        opening += next.value;
        const head = opening.trimStart().toLowerCase();
        const couldDecline = head.startsWith('the site') || 'the site'.startsWith(head);
        if (couldDecline && !REFUSAL_OPENING.test(opening) && opening.length < OPENING_CHARS && !/[.!?]/.test(opening)) {
          continue;
        }
        refusing = REFUSAL_OPENING.test(opening);
        const held = emit(opening);
        opening = null;
        if (held) yield { type: 'token', text: held };
        continue;
      }

      const text = emit(next.value);
      if (text) yield { type: 'token', text };
    }
  } catch (e) {
    yield { type: 'error', message: (e as Error).message };
    return;
  }

  if (opening) {
    refusing = REFUSAL_OPENING.test(opening);
    const held = emit(opening);
    if (held) yield { type: 'token', text: held };
  }
  const tail = refusing ? stripper.flush() : '';
  if (tail) yield { type: 'token', text: tail };

  yield { type: 'sources', sources: refusing ? [] : parseCitations(full, result.chunks) };
  yield { type: 'done', inputTokens, outputTokens, ...(answeredBy ? { model: answeredBy } : {}) };
}
