import { describe, expect, it } from 'vitest';
import { overviewFacts, readOverview, writeOverview, type OverviewSource } from '../../src/overview.js';
import type { StoredStatusFact } from '../../src/overview-status-facts.js';
import { Store } from '../../src/store.js';

const now = Date.parse('2026-10-21T00:00:00Z');
const row = (memberId: string, harness = 'arbitrary-a'): StoredStatusFact => ({
  memberId, harness, classification: 'fact', activity: 'turn-settled', modelId: null,
  asOf: new Date(now).toISOString(), observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
});
const admission = (id: string, harness = 'arbitrary-a', sessionRef = `session-${id}`) => ({ id, harness, sessionRef, enabled: true, revokedAt: null });
const base = (): OverviewSource => ({
  workers: [{ id: 'native', enabled: true, status: 'idle' }],
  collaborators: [admission('a'), admission('b', 'another-harness'), admission('historic')],
  statusFacts: [row('a'), row('b', 'another-harness')],
});
const total = (source: OverviewSource, at = now) => overviewFacts(source, at).items.find(f => f.id === 'organization.observed-members')?.value;

describe('observed organization membership', () => {
  it('counts reported participants rather than historical admissions across arbitrary harnesses', () => {
    expect(total(base())).toBe(3);
    expect(overviewFacts(base(), now).items.find(f => f.id === 'organization.total')?.value).toBe(4);
  });
  it('excludes revoked reports and deduplicates native identities and external session bindings', () => {
    const source = base();
    source.collaborators!.push(admission('alias', 'arbitrary-a', 'session-a'), admission('native'), { ...admission('revoked'), revokedAt: new Date(now).toISOString() });
    source.statusFacts!.push(row('alias'), row('native'), row('revoked'));
    expect(total(source)).toBe(3);
    expect(total({ workers: source.workers, collaborators: [admission('native')], statusFacts: [row('native')] })).toBe(1);
  });
  it('does not turn unknown, expired or unreported external coverage into a complete total', () => {
    expect(total({ ...base(), statusFacts: [] })).toBeNull();
    expect(total({ ...base(), statusFacts: undefined })).toBeNull();
    expect(total({ ...base(), statusFacts: [row('a'), { ...row('b'), classification: 'unknown', activity: undefined }] })).toBeNull();
    expect(total(base(), now + 60_000)).toBeNull();
    expect(total({ collaborators: [], statusFacts: [] })).toBeNull();
  });
  it('reports a native-only total when the external admission and status channels explicitly contain no members', () => {
    expect(total({ ...base(), collaborators: [], statusFacts: [] })).toBe(1);
    expect(total({ ...base(), collaborators: [], statusFacts: undefined })).toBe(1);
  });
  it('changes the facts revision when current membership expires', () => {
    expect(overviewFacts(base(), now).revision).not.toBe(overviewFacts(base(), now + 60_000).revision);
  });
  it('persists an observed-total reference and preserves its historical snapshot after expiry', () => {
    const store = new Store();
    try {
      const current = readOverview(store, base(), now);
      writeOverview(store, { expectedVersion: 0, factsRevision: current.facts.revision,
        preferencesVersion: 0, parts: [{ kind: 'fact', factId: 'organization.observed-members' }] }, 'author', base(), now);
      const expired = readOverview(store, base(), now + 60_000);
      expect(expired.status).toBe('stale');
      expect(expired.facts.items.find(f => f.id === 'organization.observed-members')?.value).toBeNull();
      expect(expired.record?.factSnapshot?.find(f => f.id === 'organization.observed-members')?.value).toBe(3);
    } finally { store.close(); }
  });
});
