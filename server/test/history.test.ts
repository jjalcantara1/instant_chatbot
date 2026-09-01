import { describe, it, expect } from 'vitest';
import { pairedHistory } from '../src/http/routes.js';

type Turn = { role: 'user' | 'assistant'; content: string };
const u = (c: string): Turn => ({ role: 'user', content: c });
const a = (c: string): Turn => ({ role: 'assistant', content: c });

/**
 * A failed answer stores the question with no reply. Replaying that orphan puts
 * two questions in front of the model and it answers the stale one — observed
 * live: "how much" was answered as if it were the previous question.
 */
describe('pairedHistory', () => {
  it('keeps complete exchanges', () => {
    expect(pairedHistory([u('q1'), a('a1'), u('q2'), a('a2')]))
      .toEqual([u('q1'), a('a1'), u('q2'), a('a2')]);
  });

  it('drops a question whose answer failed', () => {
    expect(pairedHistory([u('q1'), a('a1'), u('failed'), u('q2'), a('a2')]))
      .toEqual([u('q1'), a('a1'), u('q2'), a('a2')]);
  });

  it('drops several consecutive orphans', () => {
    expect(pairedHistory([u('x'), u('y'), u('z'), a('only')]))
      .toEqual([u('z'), a('only')]);
  });

  it('drops a trailing unanswered question', () => {
    expect(pairedHistory([u('q1'), a('a1'), u('pending')]))
      .toEqual([u('q1'), a('a1')]);
  });

  it('never emits two turns of the same role in a row', () => {
    const out = pairedHistory([u('a'), u('b'), a('c'), u('d'), a('e'), u('f')]);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]?.role).not.toBe(out[i - 1]?.role);
    }
    expect(out[0]?.role).toBe('user');
  });

  it('handles an empty history', () => {
    expect(pairedHistory([])).toEqual([]);
  });
});
