// Check the real subprocess transport against a model-free JSON-RPC peer.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { CodexSession, UncertainDelivery } from '../../src/codex-session.js';
import type { Worker } from '../../src/worker-store.js';
const sessions: CodexSession[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map(s => s.close())); });
const worker = { id: 'worker', workspacePath: process.cwd(), threadId: null } as Worker;
function session(onApproval?: () => void) {
  const s = new CodexSession({ databasePath: ':memory:', serverEntry: 'unused', binary: resolve('test/fixtures/codex-session.mjs'), requestTimeoutMs: 3000, onApproval });
  sessions.push(s); return s;
}
describe('official App Server session adapter', () => {
  it('resumes a large-history thread with metadata only before submitting the next turn',async()=>{
    const s=session(),id=await s.open({...worker,threadId:'large-history-thread'}),started=vi.fn();
    expect(id).toBe('large-history-thread');await s.run(id,'next',started);expect(started).toHaveBeenCalledWith('turn-1');
    expect(await s.inspect(id,'saved-turn','delivery')).toBe('completed');
  });
  it('handles completion before the turn/start response and reopens the same thread', async () => {
    const s = session(), id = await s.open(worker), started = vi.fn();
    await s.run(id, 'early', started); expect(started).toHaveBeenCalledWith('turn-1');
    expect(await s.open({ ...worker, threadId: id })).toBe(id);
    await s.run(id, 'next', started); expect(started).toHaveBeenLastCalledWith('turn-2');
    expect(await s.inspect(id, 'saved-turn', 'delivery')).toBe('completed');
  });
  it('does not grant a background approval request', async () => {
    const approval = vi.fn(), s = session(approval), id = await s.open(worker);
    await s.run(id, 'approval', () => {}); expect(approval).toHaveBeenCalledOnce();
  });
  it('marks a lost acknowledgement uncertain instead of retrying a possibly accepted turn', async () => {
    const s = session(), id = await s.open(worker);
    await expect(s.run(id, 'timeout', () => {})).rejects.toBeInstanceOf(UncertainDelivery);
  });
  it('surfaces a subprocess disconnect', async () => {
    const s = session(), id = await s.open(worker);
    await expect(s.run(id, 'disconnect', () => {})).rejects.toThrow(/disconnected/);
  });
  it('retains uncertainty when the transport dies after acknowledging a turn', async () => {
    const s = session(), id = await s.open(worker), started = vi.fn();
    await expect(s.run(id, 'disconnect-after-ack', started)).rejects.toBeInstanceOf(UncertainDelivery);
    expect(started).toHaveBeenCalledWith('turn-1');
  });
  it('ignores unrelated completion notifications and tolerates duplicate notifications', async () => {
    const s = session(), id = await s.open(worker);
    await s.run(id, 'duplicate', () => {});
    await expect(s.run(id, 'wrong-completion', () => {})).rejects.toThrow(/failed/);
    await s.run(id, 'next', () => {});
  });
  it.each([
    ['failed-thread', 'failed'], ['interrupted-thread', 'failed'], ['active-thread', 'active'], ['empty-thread', 'unknown'],
  ] as const)('classifies %s without replaying an execution', async (threadId, expected) => {
    expect(await session().inspect(threadId, 'saved-turn', 'delivery')).toBe(expected);
  });
  it('recovers a missing turn acknowledgement by its user-message delivery marker only', async () => {
    const s = session();
    expect(await s.inspect('marker-thread', null, 'delivery-needle')).toBe('completed');
    expect(await s.inspect('assistant-only', null, 'delivery-needle')).toBe('unknown');
    expect(await s.inspect('marker-thread', null, 'different-delivery')).toBe('unknown');
  });
});
