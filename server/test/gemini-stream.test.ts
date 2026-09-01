import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The risky part of the Gemini client is SSE reassembly: frames do not arrive
 * aligned to network chunks. This serves a real stream whose JSON objects are
 * deliberately split mid-token across writes, so a parser that assumed one
 * chunk equals one frame would fail here.
 */
let server: Server;
let port = 0;
let lastBody: Record<string, unknown> = {};

const frames = (...objs: unknown[]): string =>
  objs.map((o) => `data: ${JSON.stringify(o)}\n\n`).join('');

function textFrame(t: string): unknown {
  return { candidates: [{ content: { parts: [{ text: t }] } }] };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      lastBody = JSON.parse(raw) as Record<string, unknown>;
      // Keyed off the body, not the URL: the base URL is read at import time,
      // so a test cannot redirect it after the fact.
      if (raw.includes('FORCE_429')) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"quota"}}');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const payload = frames(
        textFrame('Hello '),
        textFrame('from '),
        textFrame('the site.'),
        { usageMetadata: { promptTokenCount: 123, candidatesTokenCount: 45 } },
      );
      // Split at an awkward offset so a frame straddles two writes.
      const cut = Math.floor(payload.length / 2) + 3;
      res.write(payload.slice(0, cut));
      res.write(payload.slice(cut));
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  process.env['GEMINI_BASE_URL'] = `http://127.0.0.1:${port}`;
  process.env['GEMINI_API_KEY'] = 'test-key';
  process.env['CHAT_PROVIDER'] = 'gemini';
});

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

async function collect(model: { stream: (r: never) => AsyncGenerator<string, { inputTokens: number; outputTokens: number }> }, req: unknown) {
  const it = model.stream(req as never);
  let text = '';
  for (;;) {
    const n = await it.next();
    if (n.done) return { text, usage: n.value };
    text += n.value;
  }
}

describe('gemini streaming client', () => {
  it('reassembles SSE frames split across network chunks', async () => {
    const { getChatModel, setChatModel } = await import('../src/chat/providers.js');
    setChatModel(null);
    const model = getChatModel();
    expect(model.provider).toBe('gemini');

    const { text, usage } = await collect(model, {
      system: 'be brief', messages: [{ role: 'user', content: 'hi' }], maxTokens: 600,
    });

    expect(text).toBe('Hello from the site.');
    expect(usage).toEqual({ inputTokens: 123, outputTokens: 45 });
  });

  it('sends the system prompt and maps assistant to the model role', async () => {
    const { getChatModel, setChatModel } = await import('../src/chat/providers.js');
    setChatModel(null);
    await collect(getChatModel(), {
      system: 'SYSTEM TEXT',
      messages: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
      ],
      maxTokens: 600,
    });

    const si = lastBody['systemInstruction'] as { parts: Array<{ text: string }> };
    expect(si.parts[0]?.text).toBe('SYSTEM TEXT');
    const contents = lastBody['contents'] as Array<{ role: string }>;
    expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
    expect((lastBody['generationConfig'] as { maxOutputTokens: number }).maxOutputTokens).toBe(600);
  });

  it('surfaces a non-200 as an error rather than an empty answer', async () => {
    const { getChatModel, setChatModel } = await import('../src/chat/providers.js');
    setChatModel(null);
    await expect(
      collect(getChatModel(), {
        system: 'FORCE_429', messages: [{ role: 'user', content: 'q' }], maxTokens: 10,
      }),
    ).rejects.toThrow(/429/);
  });
});
