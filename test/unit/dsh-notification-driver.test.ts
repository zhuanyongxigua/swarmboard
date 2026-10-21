// Synthetic fault tests for the vendor-isolated turn driver (no model, no timer, no fs).
import { describe, expect, it } from 'vitest';
import { driveOnce, intentKey, isAddressable, type PendingCheck } from '../../src/harness/dsh/notification-driver.js';

const check = (over: Partial<PendingCheck> = {}): PendingCheck => ({ memberId: 'm1', sessionRef: 's1', dueAt: 300_000, goalIds: ['g1'], ...over });

function ports(options: { current?: boolean; busy?: boolean; outcome?: { status: 'accepted' | 'unknown' | 'rejected'; detail?: string }; confirmFails?: boolean; throwOnSubmit?: boolean } = {}) {
  const journal = new Map<string, { key: string; state: string; check: PendingCheck }>();
  const calls = { confirm: 0, release: [] as string[], submit: 0 };
  return {
    journal,
    calls,
    ports: {
      pending: {
        list: async () => [check()],
        confirm: async () => { calls.confirm += 1; if (options.confirmFails) throw new Error('journal write failed'); },
        release: async (_check: PendingCheck, reason: string) => { calls.release.push(reason); },
      },
      session: {
        isCurrent: async () => options.current ?? true,
        isBusy: async () => options.busy ?? false,
        submit: async () => {
          calls.submit += 1;
          if (options.throwOnSubmit) throw new Error('socket closed');
          return options.outcome ?? { status: 'accepted' as const };
        },
      },
      journal: {
        get: async (key: string) => journal.get(key),
        put: async (intent: { key: string; state: string; check: PendingCheck }) => { journal.set(intent.key, intent); },
        del: async (key: string) => { journal.delete(key); },
      },
    },
  };
}

describe('driveOnce', () => {
  it('confirms a check the session accepted', async () => {
    const f = ports();
    const result = await driveOnce(f.ports);
    expect(result.submitted).toEqual([intentKey(check())]);
    expect(f.calls.confirm).toBe(1);
    expect(f.journal.size).toBe(0);
  });

  it('drops a check addressed to a session that is no longer current', async () => {
    const f = ports({ current: false });
    const result = await driveOnce(f.ports);
    expect(result.skipped).toEqual([intentKey(check())]);
    expect(f.calls.submit).toBe(0);
    expect(f.calls.release).toEqual(['stale-session']);
  });

  it('leaves a busy session alone and keeps the check pending', async () => {
    const f = ports({ busy: true });
    const result = await driveOnce(f.ports);
    expect(result.merged).toEqual([intentKey(check())]);
    expect(f.calls.submit).toBe(0);
    expect(f.calls.confirm).toBe(0);
  });

  it('never replays an inconclusive submission', async () => {
    const f = ports({ outcome: { status: 'unknown', detail: 'no acknowledgement' } });
    expect((await driveOnce(f.ports)).unknown).toEqual([intentKey(check())]);
    expect(f.journal.get(intentKey(check()))?.state).toBe('unknown');
    await driveOnce(f.ports);
    expect(f.calls.submit).toBe(1);
  });

  it('treats a throwing submit as inconclusive and does not retry it', async () => {
    const f = ports({ throwOnSubmit: true });
    expect((await driveOnce(f.ports)).unknown).toEqual([intentKey(check())]);
    await driveOnce(f.ports);
    expect(f.calls.submit).toBe(1);
  });

  it('retries only the receipt when the journal could not record an authoritative accept', async () => {
    const f = ports({ confirmFails: true });
    expect((await driveOnce(f.ports)).receiptPending).toEqual([intentKey(check())]);
    expect(f.journal.get(intentKey(check()))?.state).toBe('acceptedUnacked');
    await driveOnce(f.ports);
    expect(f.calls.submit).toBe(1);
  });

  it('releases a rejected check', async () => {
    const f = ports({ outcome: { status: 'rejected', detail: 'policy' } });
    const result = await driveOnce(f.ports);
    expect(result.rejected).toEqual([intentKey(check())]);
    expect(f.calls.release).toEqual(['rejected']);
    expect(f.journal.size).toBe(0);
  });

  it('turns an interrupted attempt into unknown instead of replaying it', async () => {
    const f = ports();
    const key = intentKey(check());
    f.journal.set(key, { key, state: 'submitting', check: check() });
    const result = await driveOnce(f.ports);
    expect(result.unknown).toEqual([key]);
    expect(f.calls.submit).toBe(0);
    expect(f.journal.get(key)?.state).toBe('unknown');
  });

  it('releases a check with no scoped goal instead of spending a model turn', async () => {
    const f = ports();
    const result = await driveOnce({ ...f.ports, pending: { ...f.ports.pending, list: async () => [check({ goalIds: [] })] } });
    expect(result.skipped).toEqual([intentKey(check())]);
    expect(f.calls.submit).toBe(0);
    expect(f.calls.release).toEqual(['scope-empty']);
  });

  it('rejects an unusable dueAt before submitting', async () => {
    expect(isAddressable({ dueAt: Number.NaN, goalIds: ['g'] })).toBe(false);
    expect(isAddressable({ dueAt: -1, goalIds: ['g'] })).toBe(false);
    expect(isAddressable({ dueAt: 0, goalIds: ['g'] })).toBe(true);
    expect(isAddressable({ dueAt: 1, goalIds: [] })).toBe(false);
  });

  it('does not submit when the binding is revoked while the durable intent is written', async () => {
    let current = true;
    const journal = new Map<string, { key: string; state: string; check: PendingCheck }>();
    const calls = { submit: 0, release: [] as string[] };
    const result = await driveOnce({
      pending: {
        list: async () => [check()],
        confirm: async () => {},
        release: async (_check: PendingCheck, reason: string) => { calls.release.push(reason); },
      },
      session: {
        isCurrent: async () => current,
        isBusy: async () => false,
        submit: async () => { calls.submit += 1; return { status: 'completed' as const, turnId: 't1' }; },
        settlement: async () => ({ settled: true as const }),
      },
      journal: {
        get: async (key: string) => journal.get(key),
        put: async (intent: { key: string; state: string; check: PendingCheck }) => { journal.set(intent.key, intent); current = false; },
        del: async (key: string) => { journal.delete(key); },
      },
    });
    expect(calls.submit).toBe(0);
    expect(calls.release).toEqual(['stale-session']);
    expect(result.skipped).toEqual([intentKey(check())]);
    expect(journal.size).toBe(0);
  });

  it('never widens a receipt retry to entries merged after the submission', async () => {
    const journal = new Map<string, any>();
    const echoes: number[][] = [];
    let attempts = 0;
    let listed = { ...check(), delivery: { sequence: 7, entryIds: [1, 2] } };
    const result = await driveOnce({
      pending: {
        list: async () => [listed],
        confirm: async (delivery: { sequence: number; entryIds: readonly number[] }) => {
          attempts += 1; echoes.push([...delivery.entryIds]);
          if (attempts === 1) throw new Error('STALE_DELIVERY_VIEW');
        },
        release: async () => {},
      },
      session: {
        isCurrent: async () => true, isBusy: async () => false,
        submit: async () => ({ status: 'completed' as const, turnId: 't1' }),
        settlement: async () => ({ settled: true as const }),
      },
      journal: {
        get: async (key: string) => journal.get(key),
        put: async (intent: any) => { journal.set(intent.key, intent); },
        del: async (key: string) => { journal.delete(key); },
      },
    });
    expect(result.receiptPending).toEqual([intentKey(check())]);
    listed = { ...check(), delivery: { sequence: 7, entryIds: [1, 2, 99] } };
    const retried = await driveOnce({
      pending: { list: async () => [listed], confirm: async (delivery: { entryIds: readonly number[] }) => { echoes.push([...delivery.entryIds]); }, release: async () => {} },
      session: { isCurrent: async () => true, isBusy: async () => false, submit: async () => ({ status: 'completed' as const, turnId: 't1' }), settlement: async () => ({ settled: true as const }) },
      journal: { get: async (key: string) => journal.get(key), put: async (intent: any) => { journal.set(intent.key, intent); }, del: async (key: string) => { journal.delete(key); } },
    });
    expect(echoes[0]).toEqual([1, 2]);
    expect(echoes[1]).toEqual([1, 2]);
    expect(retried.receiptsConfirmed).toEqual([intentKey(check())]);
  });
});
