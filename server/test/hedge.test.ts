import { describe, it, expect } from 'vitest';
import { hedge } from '../src/chat/providers.js';

/**
 * About one chat request in twenty never returned headers until the 30-second
 * timeout. Hedging starts a second copy after a short wait and keeps whichever
 * answers first, so a hang costs a few seconds instead of an error.
 */

interface Call {
  signal: AbortSignal;
  resolve: (v: string) => void;
  reject: (e: Error) => void;
}

/** An attempt function whose calls the test settles by hand. */
function controllable(): { attempt: (signal: AbortSignal) => Promise<string>; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    attempt: (signal) => new Promise<string>((resolve, reject) => {
      calls.push({ signal, resolve, reject });
    }),
  };
}

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('hedge', () => {
  it('makes one call when the first answers in time', async () => {
    const { attempt, calls } = controllable();
    const p = hedge(attempt, 50);
    calls[0]?.resolve('first');
    expect(await p).toBe('first');
    await tick(80);
    expect(calls).toHaveLength(1);
  });

  it('starts a second call after the delay and keeps whichever answers first', async () => {
    const { attempt, calls } = controllable();
    const discarded: string[] = [];
    const p = hedge(attempt, 20, (late) => discarded.push(late));

    await tick(40);
    expect(calls).toHaveLength(2);

    calls[1]?.resolve('second');
    expect(await p).toBe('second');
    // The loser is cancelled, and anything it still returns is released.
    expect(calls[0]?.signal.aborted).toBe(true);
    calls[0]?.resolve('first, late');
    await tick(0);
    expect(discarded).toEqual(['first, late']);
  });

  it('retries at once when the first call fails outright', async () => {
    const { attempt, calls } = controllable();
    const p = hedge(attempt, 10_000);
    calls[0]?.reject(new Error('socket hang up'));
    await tick(0);
    expect(calls).toHaveLength(2);
    calls[1]?.resolve('recovered');
    expect(await p).toBe('recovered');
  });

  it('fails only once every call has failed', async () => {
    const { attempt, calls } = controllable();
    const p = hedge(attempt, 20);
    await tick(40);
    calls[0]?.reject(new Error('one'));
    await tick(0);
    let settled = false;
    void p.catch(() => {}).finally(() => { settled = true; });
    await tick(0);
    expect(settled).toBe(false);
    calls[1]?.reject(new Error('two'));
    await expect(p).rejects.toThrow('two');
  });

  it('does not hedge when the delay is zero', async () => {
    const { attempt, calls } = controllable();
    const p = hedge(attempt, 0);
    await tick(30);
    expect(calls).toHaveLength(1);
    calls[0]?.reject(new Error('down'));
    await expect(p).rejects.toThrow('down');
  });
});
