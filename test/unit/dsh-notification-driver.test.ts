// Synthetic fault tests for the vendor-isolated turn driver (no model, no timer, no fs).
import { describe, expect, it } from 'vitest';
import {
  driveOnce, intentKey, isAddressable,
  type DriveResult, type Intent, type PendingCheck, type SubmitOutcome,
} from '../../src/harness/dsh/notification-driver.js';

const check = (over: Partial<PendingCheck> = {}): PendingCheck => ({
  memberId: 'm1', sessionRef: 's1', dueAt: 300_000, goalIds: ['g1'],
  delivery: { sequence: 7, entryIds: [1, 2] }, ...over,
});

type Options = {
  current?: boolean | (() => boolean);
  busy?: boolean;
  outcome?: SubmitOutcome;
  settled?: boolean;
  confirmFails?: boolean;
  throwOnSubmit?: boolean;
  onIntentWrite?: () => void;
};

function harness(options: Options = {}) {
  const journal = new Map<string, Intent>();
  const calls = { confirm: [] as number[][], release: [] as string[], submit: 0, settlement: 0 };
  const current = () => (typeof options.current === 'function' ? options.current() : options.current ?? true);
  let listed: PendingCheck[] = [check()];
  const ports = {
    pending: {
      list: async () => listed,
      confirm: async (delivery: { sequence: number; entryIds: readonly number[] }) => {
        calls.confirm.push([...delivery.entryIds]);
        if (options.confirmFails) throw new Error('STALE_DELIVERY_VIEW');
      },
      release: async (_c: PendingCheck, reason: string) => { calls.release.push(reason); },
    },
    session: {
      isCurrent: async () => current(),
      isBusy: async () => options.busy ?? false,
      submit: async (): Promise<SubmitOutcome> => {
        calls.submit += 1;
        if (options.throwOnSubmit) throw new Error('socket closed');
        return options.outcome ?? { status: 'completed', turnId: 't1' };
      },
      settlement: async () => { calls.settlement += 1; return { settled: options.settled ?? true }; },
    },
    journal: {
      get: async (key: string) => journal.get(key),
      put: async (intent: Intent) => { journal.set(intent.key, intent); options.onIntentWrite?.(); },
      del: async (key: string) => { journal.delete(key); },
    },
  };
  return { ports, journal, calls, setListed: (next: PendingCheck[]) => { listed = next; } };
}

describe('driveOnce', () => {
  it('settles a completed turn with the delivery snapshot', async () => {
    const f = harness();
    const result: DriveResult = await driveOnce(f.ports);
    expect(result.submitted).toEqual([intentKey(check())]);
    expect(f.calls.confirm).toEqual([[1, 2]]);
    expect(f.journal.size).toBe(0);
  });

  it('treats an enqueued prompt as pending work, never as completion', async () => {
    const f = harness({ outcome: { status: 'enqueued' } });
    const result = await driveOnce(f.ports);
    expect(result.awaitingCompletion).toEqual([intentKey(check())]);
    expect(f.calls.confirm).toEqual([]);
    expect(f.journal.get(intentKey(check()))?.state).toBe('enqueued');
  });

  it('settles later once the host reports authoritative completion', async () => {
    const f = harness({ outcome: { status: 'enqueued' } });
    await driveOnce(f.ports);
    const second = await driveOnce(f.ports);
    expect(second.receiptsConfirmed).toEqual([intentKey(check())]);
    expect(f.calls.submit).toBe(1);
    expect(f.calls.confirm).toEqual([[1, 2]]);
  });

  it('keeps waiting while the delivery is not settled', async () => {
    const f = harness({ outcome: { status: 'enqueued' }, settled: false });
    await driveOnce(f.ports);
    const second = await driveOnce(f.ports);
    expect(second.awaitingCompletion).toEqual([intentKey(check())]);
    expect(f.calls.confirm).toEqual([]);
  });

  it('retries only the receipt when settlement succeeded but the receipt failed', async () => {
    const f = harness({ confirmFails: true });
    const first = await driveOnce(f.ports);
    expect(first.receiptPending).toEqual([intentKey(check())]);
    expect(f.journal.get(intentKey(check()))?.state).toBe('completedUnacked');
    await driveOnce(f.ports);
    expect(f.calls.submit).toBe(1);
    expect(f.calls.settlement).toBe(0);
  });

  it('never widens a receipt retry to entries merged after the submission', async () => {
    const f = harness({ confirmFails: true });
    await driveOnce(f.ports);
    f.setListed([check({ delivery: { sequence: 7, entryIds: [1, 2, 99] } })]);
    await driveOnce(f.ports);
    expect(f.calls.confirm[0]).toEqual([1, 2]);
    expect(f.calls.confirm.at(-1)).toEqual([1, 2]);
  });

  it('drops a check addressed to a session that is no longer current', async () => {
    const f = harness({ current: false });
    const result = await driveOnce(f.ports);
    expect(result.skipped).toEqual([intentKey(check())]);
    expect(f.calls.submit).toBe(0);
    expect(f.calls.release).toEqual(['stale-session']);
  });

  it('leaves a busy session alone and keeps the check pending', async () => {
    const f = harness({ busy: true });
    const result = await driveOnce(f.ports);
    expect(result.merged).toEqual([intentKey(check())]);
    expect(f.calls.submit).toBe(0);
    expect(f.journal.size).toBe(0);
  });

  it('re-checks the binding after the durable intent is written', async () => {
    let allowed = true;
    const f = harness({ current: () => allowed, onIntentWrite: () => { allowed = false; } });
    const result = await driveOnce(f.ports);
    expect(f.calls.submit).toBe(0);
    expect(f.calls.release).toEqual(['stale-session']);
    expect(result.skipped).toEqual([intentKey(check())]);
    expect(f.journal.size).toBe(0);
  });

  it('never replays an inconclusive submission', async () => {
    const f = harness({ outcome: { status: 'unknown' } });
    await driveOnce(f.ports);
    await driveOnce(f.ports);
    expect(f.calls.submit).toBe(1);
  });

  it('treats a throwing submit as inconclusive and does not retry it', async () => {
    const f = harness({ throwOnSubmit: true });
    await driveOnce(f.ports);
    await driveOnce(f.ports);
    expect(f.calls.submit).toBe(1);
  });

  it('releases a rejected check', async () => {
    const f = harness({ outcome: { status: 'rejected' } });
    const result = await driveOnce(f.ports);
    expect(result.rejected).toEqual([intentKey(check())]);
    expect(f.calls.release).toEqual(['rejected']);
    expect(f.journal.size).toBe(0);
  });

  it('never submits a check without a scoped goal or a usable dueAt', async () => {
    const f = harness();
    f.setListed([check({ goalIds: [] })]);
    const result = await driveOnce(f.ports);
    expect(result.skipped).toEqual([intentKey(check())]);
    expect(f.calls.submit).toBe(0);
    expect(f.calls.release).toEqual(['scope-empty']);
    expect(isAddressable({ dueAt: -1, goalIds: ['g'] })).toBe(false);
    expect(isAddressable({ dueAt: 0, goalIds: ['g'] })).toBe(true);
  });
});
