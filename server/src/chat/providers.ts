import Anthropic from '@anthropic-ai/sdk';
import { request, type Dispatcher } from 'undici';
import { config, resolveChat } from '../config.js';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  /** The model that actually answered, when it can differ from the configured one. */
  model?: string;
}

export interface ChatRequest {
  system: string;
  messages: ChatTurn[];
  maxTokens: number;
}

/**
 * The whole chat surface, mirroring the Embedder interface next door: swapping
 * providers means writing one of these and changing nothing else. The generator
 * yields text deltas as they arrive and returns token usage when it finishes.
 */
export interface ChatModel {
  readonly provider: string;
  readonly name: string;
  stream(req: ChatRequest): AsyncGenerator<string, ChatUsage>;
}

class AnthropicChat implements ChatModel {
  readonly provider = 'anthropic';
  private client: Anthropic;

  constructor(apiKey: string, workspaceId: string, readonly name: string) {
    this.client = new Anthropic({
      apiKey,
      // Identity-linked keys reject every request without this header.
      ...(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {}),
    });
  }

  async *stream(req: ChatRequest): AsyncGenerator<string, ChatUsage> {
    const stream = this.client.messages.stream({
      model: this.name,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text;
      }
    }

    const final = await stream.finalMessage();
    return { inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens };
  }
}

/**
 * Start `attempt`, and if it has produced nothing after `delayMs`, start a
 * second copy and settle with whichever responds first. The other is aborted,
 * and a response that arrives after the race was decided is handed to
 * `discard` so its connection is released.
 *
 * "Responds" means the promise settles - for an HTTP call, the headers are
 * back, whatever their status. A fast 429 therefore wins and is reported as
 * usual; hedging is only for silence. An attempt that fails outright before
 * the delay starts the second immediately, so a dropped connection costs one
 * retry rather than an error. The call fails only once every attempt has.
 */
export function hedge<T>(
  attempt: (signal: AbortSignal) => Promise<T>,
  delayMs: number,
  discard: (late: T) => void = () => {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controllers: AbortController[] = [];
    let settled = false;
    let failures = 0;
    let timer: NodeJS.Timeout | undefined;

    const canHedge = (): boolean => delayMs > 0 && controllers.length < 2;

    const launch = (): void => {
      const controller = new AbortController();
      controllers.push(controller);
      attempt(controller.signal).then(
        (value) => {
          if (settled) { discard(value); return; }
          settled = true;
          clearTimeout(timer);
          for (const other of controllers) if (other !== controller) other.abort();
          resolve(value);
        },
        (err: unknown) => {
          failures++;
          if (settled) return;
          if (canHedge()) { clearTimeout(timer); launch(); return; }
          if (failures === controllers.length) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        },
      );
    };

    launch();
    if (canHedge()) {
      timer = setTimeout(() => { if (!settled && canHedge()) launch(); }, delayMs);
      timer.unref?.();
    }
  });
}

interface GeminiChunk {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string };
}

/** Gemini's "try again": overloaded, or a gateway hiccup. */
const TRANSIENT = new Set([500, 502, 503, 504]);

/** Pause before asking an overloaded model a second time. */
export const RETRY_PAUSE_MS = 800;

/** How long the fallback goes first after the primary proved overloaded. */
const BUSY_FOR_MS = 60_000;

class GeminiChat implements ChatModel {
  readonly provider = 'gemini';
  private busyUntil = 0;

  constructor(
    private readonly apiKey: string,
    readonly name: string,
    /** Tried when the primary is overloaded or out of quota. Null: none. */
    private readonly fallback: string | null = null,
  ) {}

  /**
   * Open a streaming response, riding out an overloaded model.
   *
   * Gemini answers "503: This model is currently experiencing high demand"
   * in bursts that last minutes, and while it does, every question failed.
   * So a transient error on the primary model is retried once after a short
   * pause, and if the primary is still overloaded - or has spent its free-tier
   * quota, which is counted per model - the fallback model gets the question.
   * Nothing has been streamed to the visitor yet, so switching is invisible.
   * Anything else (a bad key, a bad request) fails at once: another model
   * would not fix it.
   */
  private async open(body: string): Promise<{ res: Dispatcher.ResponseData; model: string }> {
    const hasFallback = this.fallback !== null && this.fallback !== this.name;
    // A spike lasts minutes, and an overloaded answer still takes a second or
    // three to arrive. Once the primary has proved overloaded, the fallback
    // goes first for a while instead of every question paying for the primary
    // twice before being handed over.
    const primaryBusy = hasFallback && Date.now() < this.busyUntil;
    const models = !hasFallback ? [this.name]
      : primaryBusy ? [this.fallback as string, this.name]
      : [this.name, this.fallback as string];
    let failure = '';

    for (const [m, model] of models.entries()) {
      const url = `${config.geminiBaseUrl}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
      const retry = m === 0 && !primaryBusy;
      for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
        // Most calls start streaming in about a second, but roughly one in
        // twenty sends no headers at all until the timeout. A second request
        // started after CHAT_HEDGE_MS turns that 30-second wait and error into
        // a few seconds' delay, for the cost of an occasional duplicate prompt.
        const res = await hedge(
          (signal) => request(url, {
            method: 'POST',
            headers: { 'x-goog-api-key': this.apiKey, 'content-type': 'application/json' },
            body,
            signal,
            headersTimeout: 30_000,
            bodyTimeout: 120_000,
          }),
          config.chatHedgeMs,
          (late) => { late.body.destroy(); },
        );
        if (res.statusCode < 400) return { res, model };

        failure = `Gemini returned ${res.statusCode}: ${(await res.body.text()).slice(0, 400)}`;
        if (!TRANSIENT.has(res.statusCode) && res.statusCode !== 429) throw new Error(failure);
        if (model === this.name) this.busyUntil = Date.now() + BUSY_FOR_MS;
        // A quota error will not clear in a second; go straight to the fallback.
        if (res.statusCode === 429) break;
        if (retry && attempt === 0) await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS));
      }
    }
    throw new Error(failure);
  }

  async *stream(req: ChatRequest): AsyncGenerator<string, ChatUsage> {
    const body = JSON.stringify({
      // Gemini names the assistant role "model"; everything else maps over.
      contents: req.messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      systemInstruction: { parts: [{ text: req.system }] },
      generationConfig: { maxOutputTokens: req.maxTokens },
    });

    const { res, model } = await this.open(body);

    let usage: ChatUsage = { inputTokens: 0, outputTokens: 0, model };
    let buffer = '';

    // SSE frames can split across network chunks, so hold a partial line back
    // until its newline arrives rather than parsing half a JSON object.
    for await (const piece of res.body) {
      buffer += typeof piece === 'string' ? piece : Buffer.from(piece).toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;

        const payload = line.slice(5).trim();
        if (payload === '' || payload === '[DONE]') continue;

        let chunk: GeminiChunk;
        try {
          chunk = JSON.parse(payload) as GeminiChunk;
        } catch {
          continue; // a keep-alive or a frame we do not need
        }
        if (chunk.error) throw new Error(`Gemini error: ${chunk.error.message ?? 'unknown'}`);

        for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
          if (part.text) yield part.text;
        }
        if (chunk.usageMetadata) {
          usage = {
            inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
            outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
            model,
          };
        }
      }
    }

    return usage;
  }
}

let cached: ChatModel | null = null;

export function getChatModel(): ChatModel {
  if (cached) return cached;
  const { provider, model } = resolveChat();

  if (provider === 'gemini') {
    if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY is not set.');
    cached = new GeminiChat(config.geminiApiKey, model, config.chatFallbackModel || null);
    return cached;
  }

  if (!config.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
  cached = new AnthropicChat(config.anthropicApiKey, config.anthropicWorkspaceId, model);
  return cached;
}

/** Tests and the eval swap in their own model without touching the environment. */
export function setChatModel(model: ChatModel | null): void {
  cached = model;
}
