import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import type { DB } from '../db.js';
import { getEmbedder, type Embedder } from '../indexing/embed.js';
import { retrieve, type RetrievedChunk } from '../retrieve/retrieve.js';

export interface ChatSource {
  n: number;
  url: string;
  title: string;
  headingPath: string;
}

export type ChatEvent =
  | { type: 'token'; text: string }
  | { type: 'sources'; sources: ChatSource[] }
  | { type: 'done'; inputTokens: number; outputTokens: number }
  | { type: 'error'; message: string };

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    if (!config.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
    client = new Anthropic({ apiKey: config.anthropicApiKey });
  }
  return client;
}

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
- If the excerpts do not contain the answer, say so plainly and suggest what the visitor could ask instead. Do not guess or infer.
- Cite the pages you used by their number, like [1] or [2][3].
- Be concise. Two or three sentences unless more is genuinely needed.
- Never mention "excerpts", "context", "chunks", or "the documents". Speak as if you simply know this site.

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

function suggestionsFrom(db: DB, sessionId: string): string[] {
  const rows = db.prepare(
    `SELECT title FROM pages WHERE session_id = ? AND status = 'ok' AND title IS NOT NULL
     ORDER BY char_count DESC LIMIT 4`,
  ).all(sessionId) as Array<{ title: string }>;
  return rows.map((r) => r.title).filter(Boolean);
}

export interface AnswerOptions {
  db: DB;
  sessionId: string;
  domain: string;
  question: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  embedder?: Embedder;
}

export async function* streamAnswer(opts: AnswerOptions): AsyncGenerator<ChatEvent> {
  const { db, sessionId, domain, question } = opts;
  const embedder = opts.embedder ?? getEmbedder();

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
    const hint = titles.length > 0
      ? ` You could ask about ${titles.slice(0, 3).map((t) => `"${t}"`).join(', ')}.`
      : '';
    const message = `I could not find anything about that on ${domain}.${hint}`;
    for (const word of message.split(/(?<= )/)) {
      yield { type: 'token', text: word };
    }
    yield { type: 'sources', sources: [] };
    yield { type: 'done', inputTokens: 0, outputTokens: 0 };
    return;
  }

  const system = buildSystemPrompt(domain, result.chunks);
  const messages: Anthropic.MessageParam[] = [
    ...opts.history.slice(-6).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: question },
  ];

  let full = '';
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    const stream = getClient().messages.stream({
      model: config.chatModel,
      max_tokens: 600,
      system,
      messages,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        full += event.delta.text;
        yield { type: 'token', text: event.delta.text };
      }
    }

    const final = await stream.finalMessage();
    inputTokens = final.usage.input_tokens;
    outputTokens = final.usage.output_tokens;
  } catch (e) {
    yield { type: 'error', message: (e as Error).message };
    return;
  }

  yield { type: 'sources', sources: parseCitations(full, result.chunks) };
  yield { type: 'done', inputTokens, outputTokens };
}
