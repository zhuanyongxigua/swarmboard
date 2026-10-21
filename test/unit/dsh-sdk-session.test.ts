import { describe, expect, it, vi } from 'vitest';
import { createDshSdkSessionPort, type DshSdkSessionAgent, type DshSdkBatch, type DshSdkEvent, type DshSdkUserMessage } from '../../src/harness/dsh/sdk-session.js';

function fixture(identity: Partial<Pick<DshSdkBatch, 'adapterId' | 'memberId' | 'sessionRef'>> = {}) {
  const batch: DshSdkBatch = { adapterId: 'synthetic-adapter', memberId: 'synthetic-member', sessionRef: 'synthetic-session',
    delivery: { sequence: 1, entryIds: [11, 12] }, entries: [{ id: 11, kind: 'MESSAGE', summary: 'one' }, { id: 12, kind: 'FACT', summary: 'two' }], ...identity };
  const events: DshSdkEvent[] = [];
  const send = vi.fn((message: DshSdkUserMessage<string>) => {
    events.push({ seq: events.length, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [message] } });
  });
  const agent: DshSdkSessionAgent<string> = { id: batch.sessionRef, status: 'idle', inbox: { hasPending: false },
    session: { id: batch.sessionRef, header: { cwd: '/synthetic/workspace' }, events }, send };
  let current = agent; let authorized = true;
  const flush = vi.fn(async () => true);
  const options = { adapterId: batch.adapterId, memberId: batch.memberId, sessionRef: batch.sessionRef, cwd: '/synthetic/workspace',
    getAgent: () => current, messageId: (id: string) => id, isAuthorized: () => authorized, flush };
  const make = () => createDshSdkSessionPort(options);
  const append = (type: string, data: unknown) => events.push({ seq: events.length, type, data });
  const complete = (message = send.mock.calls[0][0], reason = 'completed') => {
    append('turn/start', { turn: 7 }); append('user/message', message); append('turn/end', { turn: 7, reason: { kind: reason } });
  };
  return { batch, events, send, agent, flush, options, make, append, complete,
    revoke: () => { authorized = false; }, replace: () => { current = { ...agent }; } };
}

describe('official DSH SDK session port', () => {
  it.each([
    { name: 'omitted adapter versus literal native', left: { adapterId: undefined }, right: { adapterId: 'native' } },
    { name: 'delimiter-bearing identity fields', left: { memberId: 'member|part', sessionRef: 'session' },
      right: { memberId: 'member', sessionRef: 'part|session' } },
  ])('keeps message IDs and completion tokens distinct for $name', async ({ left, right }) => {
    const a = fixture(left); const b = fixture(right);
    const first = await a.make().submit(a.batch, 'same text');
    const second = await b.make().submit(b.batch, 'same text');
    expect(first.status).toBe('enqueued'); expect(second.status).toBe('enqueued');
    expect(a.send.mock.calls[0][0].id).not.toBe(b.send.mock.calls[0][0].id);
    a.complete(); b.complete();
    expect(await a.make().settlement(a.batch, first.detail!)).toEqual({ settled: true });
    expect(await b.make().settlement(b.batch, second.detail!)).toEqual({ settled: true });
    expect(await a.make().settlement(a.batch, second.detail!)).toEqual({ settled: false });
    expect(await b.make().settlement(b.batch, first.detail!)).toEqual({ settled: false });
  });

  it('queues one whole batch as an identified plugin user message and flushes, without claiming completion', async () => {
    const f = fixture(); const port = f.make();
    expect(f.send).not.toHaveBeenCalled();
    const result = await port.submit(f.batch, 'entire delivery');
    expect(result.status).toBe('enqueued'); expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'entire delivery' }],
      source: { kind: 'plugin', plugin: 'swarmboard', form: 'relay' } }), 'next-turn', true);
    expect(f.flush).toHaveBeenCalledWith(f.agent);
    expect(await port.settlement(f.batch, result.detail!)).toEqual({ settled: false });
  });

  it('settles only after this message enters a turn that completes, including after helper reconstruction', async () => {
    const f = fixture(); const result = await f.make().submit(f.batch, 'whole snapshot'); f.complete();
    expect(await f.make().settlement(f.batch, result.detail!)).toEqual({ settled: true });
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.flush).toHaveBeenCalledTimes(2);
  });

  it('does not credit idle, an old completed turn, or another message', async () => {
    const f = fixture(); f.append('turn/start', { turn: 1 }); f.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    const port = f.make(); const result = await port.submit(f.batch, 'batch');
    f.complete({ ...f.send.mock.calls[0][0], id: 'other-message' });
    expect(await port.settlement(f.batch, result.detail!)).toEqual({ settled: false });
  });

  it.each(['aborted', 'error', 'interrupted', 'blocked', 'max-tokens'])('does not claim %s is a successful completion', async reason => {
    const f = fixture(); const port = f.make(); const result = await port.submit(f.batch, 'batch'); f.complete(undefined, reason);
    expect(await port.settlement(f.batch, result.detail!)).toEqual({ settled: false });
  });

  it('rechecks authorization after caller-provided message branding immediately before irreversible send', async () => {
    const f = fixture(); f.options.messageId = id => { f.revoke(); return id; };
    expect((await f.make().submit(f.batch, 'batch')).status).toBe('rejected');
    expect(f.send).not.toHaveBeenCalled();
  });

  it('rejects wrong session/cwd/member/adapter and malformed snapshots without SDK submission', async () => {
    const f = fixture(); const port = f.make();
    for (const batch of [{ ...f.batch, sessionRef: 'foreign' }, { ...f.batch, memberId: 'foreign' },
      { ...f.batch, adapterId: 'foreign' }, { ...f.batch, delivery: { sequence: 1, entryIds: [11] } }]) {
      expect((await port.submit(batch, 'batch')).status).toBe('rejected');
    }
    Object.defineProperty(f.agent.session.header, 'cwd', { value: '/other' });
    expect(await port.isCurrent(f.batch)).toBe(false); expect(f.send).not.toHaveBeenCalled();
  });

  it('retains uncertainty on send/flush errors and does not confirm or retry', async () => {
    const f = fixture(); f.flush.mockRejectedValueOnce(new Error('disk failure'));
    expect((await f.make().submit(f.batch, 'batch')).status).toBe('unknown');
    expect(f.send).toHaveBeenCalledTimes(1);
    const g = fixture(); g.send.mockImplementationOnce(() => { throw new Error('lost after append'); });
    expect((await g.make().submit(g.batch, 'batch')).status).toBe('unknown'); expect(g.send).toHaveBeenCalledTimes(1);
  });

  it('does not claim durable enqueue or completion when the SDK has no durability listener', async () => {
    const f = fixture(); f.flush.mockResolvedValueOnce(false);
    const port = f.make(); const result = await port.submit(f.batch, 'batch');
    expect(result.status).toBe('unknown'); f.complete(); f.flush.mockResolvedValueOnce(false);
    expect(await port.settlement(f.batch, result.detail!)).toEqual({ settled: false });
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('does not resend a durably queued identified message after reconstruction', async () => {
    const f = fixture(); const first = await f.make().submit(f.batch, 'same');
    const second = await f.make().submit(f.batch, 'same');
    expect(second).toEqual(first); expect(f.send).toHaveBeenCalledTimes(1);
    expect((await f.make().submit(f.batch, 'different')).status).toBe('unknown');
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('does not apply a receipt token to a grown or different batch, or mismatched input evidence', async () => {
    const f = fixture(); const port = f.make(); const result = await port.submit(f.batch, 'original');
    f.complete({ ...f.send.mock.calls[0][0], content: [{ type: 'text', text: 'other' }] });
    expect(await port.settlement(f.batch, result.detail!)).toEqual({ settled: false });
    expect(await port.settlement({ ...f.batch, delivery: { sequence: 2, entryIds: [11, 12] } }, result.detail!)).toEqual({ settled: false });
    expect(await port.settlement(f.batch, 'null')).toEqual({ settled: false });
  });

  it('reports pending SDK inbox as busy and refuses settlement after binding replacement or failed flush', async () => {
    const f = fixture(); const port = f.make();
    f.agent.inbox.hasPending = true; expect(await port.isBusy(f.batch)).toBe(true); f.agent.inbox.hasPending = false;
    const result = await port.submit(f.batch, 'batch'); f.complete(); f.flush.mockRejectedValueOnce(new Error('disk'));
    expect(await port.settlement(f.batch, result.detail!)).toEqual({ settled: false });
    f.replace();
    // The replacement has no independently established binding for this port.
    expect(await port.settlement(f.batch, result.detail!)).toEqual({ settled: false });
  });

  it('revalidates the host lease after the completion durability checkpoint', async () => {
    const f = fixture(); const port = f.make(); const result = await port.submit(f.batch, 'batch'); f.complete();
    f.flush.mockImplementationOnce(async () => { f.revoke(); return true; });
    expect(await port.settlement(f.batch, result.detail!)).toEqual({ settled: false });
    expect(f.send).toHaveBeenCalledTimes(1);
  });
});
