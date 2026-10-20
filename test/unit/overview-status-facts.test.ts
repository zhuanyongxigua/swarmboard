// Member-status-fact v2 contract: self-registration through the formal
// boundary, honest aggregation (unknown/expired never execute), and overview
// facts that keep known numbers when other groups are unknown.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store.js';
import { overviewFacts, readOverview, writeOverview, type OverviewSource } from '../../src/overview.js';
import { aggregateStatusFacts, registerStatusFact, statusFactInputSchema, statusGroupKey, type StoredStatusFact } from '../../src/overview-status-facts.js';

let store: Store;
beforeEach(() => { store = new Store(); });
afterEach(() => { store.close(); });

const NOW = Date.parse('2026-10-20T03:00:00.000Z');
const input = (over: Record<string, unknown> = {}) => ({
  harness: 'zcode', classification: 'fact', activity: 'turn-settled', modelId: 'GLM-5.3',
  asOf: '2026-10-20T02:59:00.000Z', ttlSeconds: 900, ...over,
});
const source = (statusFacts?: StoredStatusFact[]): OverviewSource => ({
  workers: [{ id: 'w1', enabled: true, status: 'idle' }],
  collaborators: [{ id: 'c1', harness: 'zcode', sessionRef: 'sess_1', enabled: true, revokedAt: null }],
  ...(statusFacts !== undefined ? { statusFacts } : {}),
});
const executing = (memberId: string, over: Record<string, unknown> = {}): StoredStatusFact => ({
  memberId, harness: 'zcode', classification: 'fact', activity: 'executing', modelId: 'GLM-5.3',
  executionEvidence: { kind: 'self-in-turn', at: '2026-10-20T02:59:30.000Z' },
  asOf: '2026-10-20T02:59:00.000Z', observedAt: '2026-10-20T03:00:00.000Z', expiresAt: '2026-10-20T03:10:00.000Z', ...over,
});

describe('status fact input contract (v2)', () => {
  it('rejects unknown classification carrying an activity', () => {
    expect(() => statusFactInputSchema.parse(input({ classification: 'unknown', activity: 'executing' }))).toThrow();
  });
  it('rejects executing without execution evidence', () => {
    expect(() => statusFactInputSchema.parse(input({ activity: 'executing' }))).toThrow();
  });
  it('rejects ttl beyond fifteen minutes, nul bytes and unexpected fields', () => {
    expect(() => statusFactInputSchema.parse(input({ ttlSeconds: 901 }))).toThrow();
    expect(() => statusFactInputSchema.parse(input({ harness: 'a\0b' }))).toThrow();
    expect(() => statusFactInputSchema.parse(input({ memberId: 'someone-else' }))).toThrow();
  });
  it('accepts a valid executing envelope with evidence', () => {
    expect(statusFactInputSchema.parse(input({ activity: 'executing', executionEvidence: { kind: 'self-in-turn', at: '2026-10-20T02:59:30.000Z' } })).activity).toBe('executing');
  });
});

describe('registerStatusFact', () => {
  it('binds the member identity server-side and stamps observed/expiry', () => {
    const stored = registerStatusFact(store, input(), 'member-a', NOW);
    expect(stored.memberId).toBe('member-a');
    expect(stored.observedAt).toBe('2026-10-20T03:00:00.000Z');
    expect(stored.expiresAt).toBe('2026-10-20T03:15:00.000Z');
    expect((stored as Record<string, unknown>).ttlSeconds).toBeUndefined();
  });
  it('upserts per harness/member and reopens durably', () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/overview-status-facts-${Date.now()}.sqlite`;
    const fileStore = new Store(path);
    registerStatusFact(fileStore, input(), 'member-a', NOW);
    registerStatusFact(fileStore, input({ classification: 'unknown', activity: undefined, modelId: null }), 'member-a', NOW + 1000);
    registerStatusFact(fileStore, input({ harness: 'dsh' }), 'member-b', NOW);
    expect(fileStore.readOverviewStatusFacts()).toHaveLength(2);
    fileStore.close();
    const reopened = new Store(path);
    expect(reopened.readOverviewStatusFacts()).toHaveLength(2);
    expect(reopened.readOverviewStatusFacts().find(f => f.memberId === 'member-a')?.classification).toBe('unknown');
    reopened.close();
  });
});

describe('aggregation semantics', () => {
  it('never counts unknown or expired registrations as executing', () => {
    const summary = aggregateStatusFacts([
      executing('a'),
      executing('b', { classification: 'unknown', activity: undefined }),
      executing('c', { expiresAt: '2026-10-20T02:00:00.000Z' }),
      executing('d', { activity: 'turn-settled', executionEvidence: undefined }),
    ], NOW);
    expect(summary.executing).toBe(1);
    expect(summary.groups.zcode).toMatchObject({ membersTotal: 4, executing: 1, unknown: 1, stale: 1, turnSettled: 1 });
  });
  it('keeps known group numbers when another group is fully unknown', () => {
    const summary = aggregateStatusFacts([
      executing('a'),
      executing('b', { harness: 'dsh', classification: 'unknown', activity: undefined, modelId: null }),
    ], NOW);
    expect(summary.groups.zcode.executing).toBe(1);
    expect(summary.groups.dsh).toMatchObject({ executing: 0, unknown: 1 });
  });
  it('counts models per group without inventing unknown ones', () => {
    const summary = aggregateStatusFacts([
      executing('a'), executing('b', { modelId: 'GLM-5.3' }),
      executing('c', { activity: 'turn-settled', executionEvidence: undefined, modelId: null }),
    ], NOW);
    expect(summary.groups.zcode.models).toEqual([{ modelId: 'GLM-5.3', count: 2, executing: 2 }]);
    expect(summary.groups.zcode.modelsUnknown).toBe(1);
  });
  it('changes the fingerprint when a registration changes', () => {
    const before = aggregateStatusFacts([executing('a')], NOW).fingerprint;
    const after = aggregateStatusFacts([executing('a', { activity: 'turn-settled', executionEvidence: undefined })], NOW).fingerprint;
    expect(before).not.toBe(after);
  });
});

describe('overview facts integration', () => {
  it('stays null for external running without any registration channel', () => {
    const facts = overviewFacts(source(), NOW);
    expect(facts.items.find(f => f.id === 'external.running')?.value).toBeNull();
  });
  it('keeps unknown rather than zero when the channel is empty', () => {
    const facts = overviewFacts(source([]), NOW);
    expect(facts.items.find(f => f.id === 'external.running')?.value).toBeNull();
    expect(facts.items.find(f => f.id === 'external.status.registered')?.value).toBe(0);
  });
  it('reports registered executing counts and per-group facts with sanitized ids', () => {
    const facts = overviewFacts(source([
      executing('a', { harness: 'zcode cli/2' }),
      executing('b', { harness: 'zcode cli/2', classification: 'unknown', activity: undefined, modelId: null }),
    ]), NOW);
    const group = 'external.harness.zcode-cli-2';
    expect(facts.items.find(f => f.id === 'external.running')?.value).toBe(1);
    expect(facts.items.find(f => f.id === `${group}.members`)?.value).toBe(2);
    expect(facts.items.find(f => f.id === `${group}.executing`)?.value).toBe(1);
    expect(facts.items.find(f => f.id === `${group}.unknown`)?.value).toBe(1);
    expect(facts.items.find(f => f.id === `${group}.model.GLM-5.3`)?.value).toBe(1);
    expect(statusGroupKey('zcode cli/2')).toBe('zcode-cli-2');
  });
  it('composes organization.total from native and admission evidence', () => {
    expect(overviewFacts(source(), NOW).items.find(f => f.id === 'organization.total')?.value).toBe(2);
    expect(overviewFacts({ workers: source().workers }, NOW).items.find(f => f.id === 'organization.total')?.value).toBeNull();
  });
  it('marks an overview stale when a status fact changes after the write', () => {
    const before = readOverview(store, source([executing('a')]), NOW);
    writeOverview(store, { expectedVersion: 0, factsRevision: before.facts.revision, preferencesVersion: store.readPreferences().version,
      parts: [{ kind: 'fact', factId: 'external.running' }] }, 'author', source([executing('a')]), NOW);
    expect(readOverview(store, source([executing('a')]), NOW).status).toBe('current');
    const changed = readOverview(store, source([executing('a'), executing('b')]), NOW);
    expect(changed.status).toBe('stale');
    expect(changed.reason).toBe('FACTS_CHANGED');
    expect(changed.record?.factSnapshot?.find(f => f.id === 'external.running')?.value).toBe(1);
  });
});
