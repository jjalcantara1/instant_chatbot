import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The local embedder, with transformers.js mocked: the suite never downloads a
 * model. What matters is how the model is called - once, lazily, single
 * threaded, into a writable cache, with the right prefix per kind, in small
 * batches, one call at a time.
 */

const state = vi.hoisted(() => ({
  loads: 0,
  failNextLoad: false,
  calls: [] as string[][],
  active: 0,
  maxActive: 0,
  pipelineArgs: [] as unknown[],
  env: { cacheDir: '' },
}));

vi.mock('@huggingface/transformers', () => ({
  env: state.env,
  pipeline: vi.fn(async (...args: unknown[]) => {
    state.loads++;
    state.pipelineArgs = args;
    if (state.failNextLoad) {
      state.failNextLoad = false;
      throw new Error('download failed');
    }
    return async (texts: string[]) => {
      state.active++;
      state.maxActive = Math.max(state.maxActive, state.active);
      state.calls.push(texts);
      await new Promise((r) => setTimeout(r, 5));
      state.active--;
      // Row j encodes its text's length, so order and prefixing are visible.
      const d = 3;
      const data = new Float32Array(texts.length * d);
      texts.forEach((t, j) => { data[j * d] = t.length; data[j * d + 1] = j; });
      return { data, dims: [texts.length, d] };
    };
  }),
}));

const { LocalEmbedder, LOCAL_MODELS, DEFAULT_LOCAL_MODEL } = await import('../src/indexing/embed.js');
const spec = LOCAL_MODELS[DEFAULT_LOCAL_MODEL] as NonNullable<(typeof LOCAL_MODELS)[string]>;

beforeEach(() => {
  state.loads = 0;
  state.failNextLoad = false;
  state.calls = [];
  state.active = 0;
  state.maxActive = 0;
});

describe('LocalEmbedder', () => {
  it('loads nothing until it is used, then loads once, single threaded, into the cache it was given', async () => {
    const e = new LocalEmbedder(DEFAULT_LOCAL_MODEL, spec, '/srv/data/models');
    expect(state.loads).toBe(0);

    await e.embed(['one'], 'document');
    await e.embed(['two'], 'document');
    expect(state.loads).toBe(1);
    expect(state.env.cacheDir).toBe('/srv/data/models');
    expect(state.pipelineArgs).toEqual([
      'feature-extraction',
      DEFAULT_LOCAL_MODEL,
      { dtype: 'q8', session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 } },
    ]);
  });

  it('prefixes questions with the retrieval instruction, and documents with nothing', async () => {
    const e = new LocalEmbedder(DEFAULT_LOCAL_MODEL, spec, '/tmp/m');
    await e.embed(['where are you based?'], 'query');
    await e.embed(['We are based in Springfield.'], 'document');
    expect(state.calls[0]).toEqual([`${spec.queryPrefix}where are you based?`]);
    expect(state.calls[1]).toEqual(['We are based in Springfield.']);
  });

  it('embeds in batches of eight and returns one vector per text, in order', async () => {
    const e = new LocalEmbedder(DEFAULT_LOCAL_MODEL, spec, '/tmp/m');
    const texts = Array.from({ length: 20 }, (_, i) => 'x'.repeat(i + 1));
    const { vectors } = await e.embed(texts, 'document');
    expect(state.calls.map((c) => c.length)).toEqual([8, 8, 4]);
    expect(vectors).toHaveLength(20);
    expect(vectors.map((v) => v[0])).toEqual(texts.map((t) => t.length));
    expect(vectors[0]).toHaveLength(3);
  });

  it('runs one inference at a time, however many callers there are', async () => {
    const e = new LocalEmbedder(DEFAULT_LOCAL_MODEL, spec, '/tmp/m');
    await Promise.all([
      e.embed(['a', 'b'], 'document'),
      e.embed(['c'], 'query'),
      e.embed(['d', 'e', 'f'], 'document'),
    ]);
    expect(state.maxActive).toBe(1);
    expect(state.calls).toHaveLength(3);
  });

  it('tries the download again after a failure instead of failing forever', async () => {
    const e = new LocalEmbedder(DEFAULT_LOCAL_MODEL, spec, '/tmp/m');
    state.failNextLoad = true;
    await expect(e.embed(['one'], 'document')).rejects.toThrow('download failed');
    const { vectors } = await e.embed(['one'], 'document');
    expect(vectors).toHaveLength(1);
    expect(state.loads).toBe(2);
  });

  it('costs nothing for an empty list', async () => {
    const e = new LocalEmbedder(DEFAULT_LOCAL_MODEL, spec, '/tmp/m');
    expect(await e.embed([], 'document')).toEqual({ vectors: [], tokens: 0 });
    expect(state.loads).toBe(0);
  });
});
