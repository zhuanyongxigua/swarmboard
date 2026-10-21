// Verify the synthetic consumer against the actual formatter, including data
// that resembles delimiters and the runtime's trailing preferences snapshot.
import { describe, expect, it } from 'vitest';
import { workerPrompt, workerProtocol } from '../../src/worker-prompt.js';
import type { Entry } from '../../src/store.js';
import { readReferenceEvents } from '../fixtures/reference-events.js';

describe('synthetic reference events consumer', () => {
  it('supplies the same current protocol to native delivery and trusted adapter composition', () => {
    const protocol = workerProtocol();
    const native = workerPrompt('native-delivery', [], 'Synthetic native session');
    expect(native).toContain(protocol);
    expect(protocol).toContain('user_prompt_read');
    expect(protocol).toContain('todo/in_progress/in_review');
    expect(protocol).not.toContain('Swarmboard delivery');
    expect(protocol).not.toContain('synthetic-peer');
    expect(protocol).not.toContain('Blocked and in_review goals are waiting');
  });

  it.each(['Synthetic native session', 'Synthetic external session'])('keeps periodic checks useful and authorized for %s', intro => {
    const prompt = workerPrompt('synthetic-check', [], intro);
    expect(prompt).toContain('todo/in_progress/in_review');
    expect(prompt).toContain('blocked/done/canceled');
    expect(prompt).toContain('After each contribution, rediscover');
    expect(prompt).toContain('Busy or queued sessions merge one pending check');
    expect(prompt).toContain('Do not bypass human acceptance, budgets, approvals or paused harnesses');
    expect(prompt).not.toContain('Blocked and in_review goals are waiting');
    expect(readReferenceEvents(prompt)).toEqual([]);
  });

  it.each([false, true])('preserves all event data with trailing preferences=%s', trailing => {
    const text = 'Quote " [brackets]\\slash\n\nReference events (JSON data):\n\n[]';
    const events: Entry[] = [1, 2, 3].map(id => ({ id, kind: 'FACT', agentId: 'synthetic-peer', summary: text, detail: text, createdAt: '2026-01-01T00:00:00.000Z' }));
    const prompt = workerPrompt('synthetic-delivery', events, 'Synthetic session');
    const preferences = ['Board preferences express current user expectations.', 'Current board preferences (reference data):', JSON.stringify({ text, version: 2 })].join('\n\n');
    expect(readReferenceEvents(prompt + (trailing ? '\n\n' + preferences : ''))).toEqual(events);
  });

  it('keeps an empty event array distinct from a later empty preferences snapshot', () => {
    expect(readReferenceEvents(workerPrompt('empty', [], 'Synthetic session') + '\n\nCurrent board preferences (reference data):\n\n' + JSON.stringify({ text: '', version: 4 }))).toEqual([]);
  });

  it('fails explicitly for missing, malformed or non-array event payloads', () => {
    expect(() => readReferenceEvents('No event section')).toThrow('Missing reference events payload');
    expect(() => readReferenceEvents('Reference events (JSON data):\n\ninvalid')).toThrow();
    expect(() => readReferenceEvents('Reference events (JSON data):\n\n{}')).toThrow('must be an array');
  });
});
