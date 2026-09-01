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
  | { type: 'done'; inputTokens: number; outputTokens: number }
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
- Answer from what the excerpts DO say. If they cover the subject but not the
  exact detail asked — the site explains how pricing works without printing a
  number, say — then give what the site does say and cite it. That is a real
  answer, not a refusal. Declining here would be wrong and unhelpful.
- Short or vague questions still deserve an answer. Read "how much" as a
  question about pricing and answer it from the pricing excerpts.
- Only decline when the excerpts do not address the subject at all. Then say
  plainly that the site does not cover it, suggest what the visitor could ask
  instead, and cite NO page numbers anywhere in the reply — not on the
  suggestion either. A citation means the site genuinely says this, so citing a
  page while declining is wrong. A reply that declines contains no [1] or [2].
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
 * Page titles are written for search engines: "FAQ: Custom Websites & AI Models
 * in Pampanga | Kleio". Read back verbatim in a refusal that sounds like a
 * machine reciting metadata, so keep the leading segment and drop the brand
 * tail that every page repeats.
 */
export function cleanTitle(title: string): string {
  const head = title.split(/\s+[|–—·]\s+/)[0]?.trim() ?? title.trim();
  const kept = head.length >= 3 ? head : title.trim();
  // "FAQ: Custom Websites & AI Models in Pampanga" -> "FAQ". The half before
  // the colon is the page's actual name; the rest is written for search.
  // 3 characters, so a real name like "FAQ" survives.
  const lead = (kept.split(/:\s+/)[0] ?? kept).trim();
  return lead.length >= 3 ? lead : kept;
}

function suggestionsFrom(db: DB, sessionId: string): string[] {
  const rows = db.prepare(
    `SELECT title FROM pages WHERE session_id = ? AND status = 'ok' AND title IS NOT NULL
     ORDER BY char_count DESC LIMIT 8`,
  ).all(sessionId) as Array<{ title: string }>;

  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const t = cleanTitle(r.title ?? '');
    const key = t.toLowerCase();
    if (t && !seen.has(key)) { seen.add(key); out.push(t); }
  }
  return out;
}

function listPhrase(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1] as string}`;
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

  let result;
  try {
    result = await retrieve(db, sessionId, question, embedder);
  } catch (e) {
    yield { type: 'error', message: (e as Error).message };
    return;
  }

  // Nothing relevant enough survived the floor. Refuse here rather than handing
  // the model a weak hand and hoping the prompt holds. This is deterministic,
  // costs nothing, and is the reason an off-site question cannot be answered
  // fluently and wrongly.
  if (result.insufficient) {
    const titles = suggestionsFrom(db, sessionId);
    // Phrased like the model's own refusals so the two do not read as coming
    // from different products.
    const hint = titles.length > 0
      ? ` You could ask about ${listPhrase(titles.slice(0, 3))} instead.`
      : '';
    const message = `The site doesn't cover that.${hint}`;
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
        break;
      }
      full += next.value;
      yield { type: 'token', text: next.value };
    }
  } catch (e) {
    yield { type: 'error', message: (e as Error).message };
    return;
  }

  yield { type: 'sources', sources: parseCitations(full, result.chunks) };
  yield { type: 'done', inputTokens, outputTokens };
}
