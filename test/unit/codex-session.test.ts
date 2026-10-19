// Check the real subprocess transport against a model-free JSON-RPC peer.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { CodexSession, UncertainDelivery } from '../../src/codex-session.js';
import type { Worker } from '../../src/worker-store.js';
const sessions: CodexSession[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map(s => s.close())); });
const worker = { id: 'worker', workspacePath: process.cwd(), threadId: null } as Worker;
function session(onApproval?: () => void, requestTimeoutMs = 3000, openTimeoutMs = 3000) {
  const s = new CodexSession({ databasePath: ':memory:', serverEntry: 'unused', binary: resolve('test/fixtures/codex-session.mjs'), requestTimeoutMs, openTimeoutMs, onApproval });
  sessions.push(s); return s;
}
describe('official App Server session adapter', () => {
  it('reports a confirmed binding before instruction preparation fails, without submitting a model turn', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'swarmboard-instruction-failure-'));
    const log = resolve(dir, 'requests.jsonl');
    vi.stubEnv('SWARMBOARD_TEST_PROTOCOL_LOG', log);
    try {
      const s = session(), opened = vi.fn();
      await expect(s.open(worker, { revision: 'synthetic:1', text: 'reject-instruction' }, opened)).rejects.toThrow('490');
      expect(opened).toHaveBeenCalledExactlyOnceWith('persistent-thread');
      const requests = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(requests.filter(r => r.method === 'turn/start')).toEqual([]);
      await expect(s.open({ ...worker, threadId: 'persistent-thread' }, { revision: 'synthetic:2', text: 'Current.' }, () => { throw new Error('Owner changed'); })).rejects.toThrow('Owner changed');
      expect(readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(r => r.method === 'thread/inject_items')).toHaveLength(1);
    } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('requires explicit clear text and keeps active or uncertain turns out of instruction refresh', async () => {
    const s = session(undefined, 500), initial = { revision: 'synthetic:1', text: 'Synthetic instruction.' };
    await expect(s.open(worker, { revision: '', text: initial.text })).rejects.toThrow(/revision/);
    await expect(s.open(worker, { revision: 'synthetic:2', text: '' })).rejects.toThrow(/explicit text/);
    const id = await s.open(worker, initial);
    await expect(s.open({ ...worker, threadId: id })).rejects.toThrow(/clear preferences explicitly/);
    const pending = s.run(id, 'timeout', () => {});
    await expect(s.open({ ...worker, threadId: id }, { revision: 'synthetic:2', text: 'Changed.' })).rejects.toThrow(/turn may be active/);
    await expect(pending).rejects.toBeInstanceOf(UncertainDelivery);
    await expect(s.open({ ...worker, threadId: id }, initial)).rejects.toThrow(/uncertain delivery/);
    await expect(s.run(id, 'Must not replay.', () => {})).rejects.toThrow(/uncertain delivery/);
  });
  it('separates current developer-role snapshots from user input across loaded updates, clear and fresh resume', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'swarmboard-instruction-protocol-'));
    const log = resolve(dir, 'requests.jsonl');
    vi.stubEnv('SWARMBOARD_TEST_PROTOCOL_LOG', log);
    try {
      const s = session(), initial = { revision: 'board-a:1', text: 'Synthetic developer instruction A.' };
      const id = await s.open(worker, initial);
      await s.run(id, 'Ordinary event A.', () => {});
      await s.open({ ...worker, threadId: id }, initial);
      await s.run(id, 'Ordinary event B.', () => {});
      await s.open({ ...worker, threadId: id }, { revision: 'board-a:2', text: 'Synthetic developer instruction B.' });
      await s.run(id, 'Ordinary event C.', () => {});
      await s.open({ ...worker, threadId: id }, { revision: 'board-a:3', text: 'Current personal preferences are cleared. Earlier preference versions no longer apply.' });
      await s.run(id, 'Ordinary event D.', () => {});
      await s.close();
      await session().open({ ...worker, threadId: id }, { revision: 'board-b:1', text: 'Different board current instruction.' });
      const requests = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const opens = requests.filter(r => r.method === 'thread/start' || r.method === 'thread/resume');
      const injected = requests.filter(r => r.method === 'thread/inject_items');
      expect(injected.map(r => r.params.items)).toEqual([initial.text, initial.text, 'Synthetic developer instruction B.', 'Current personal preferences are cleared. Earlier preference versions no longer apply.', 'Different board current instruction.'].map(text => [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] }]));
      expect(injected.every(r => r.params.threadId === id)).toBe(true);
      expect(opens.every(r => !Object.hasOwn(r.params, 'baseInstructions') && !Object.hasOwn(r.params, 'developerInstructions') && r.params.approvalPolicy === 'on-request' && r.params.sandbox === 'workspace-write')).toBe(true);
      expect(opens.slice(1).every(r => r.params.threadId === id && r.params.excludeTurns === true)).toBe(true);
      expect(opens[0].pid).toBe(opens[1].pid);
      expect(opens[2].pid).toBe(opens[1].pid);
      expect(opens[3].pid).toBe(opens[2].pid);
      expect(opens[4].pid).not.toBe(opens[3].pid);
      expect(requests.filter(r => r.method === 'turn/start').map(r => r.params.input)).toEqual(['A', 'B', 'C', 'D'].map(v => [{ type: 'text', text: `Ordinary event ${v}.` }]));
    } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('allows bounded slow MCP startup without extending the turn submission timeout', async () => {
    const s = session(undefined, 500, 2500), started = vi.fn();
    const id = await s.open({ ...worker, threadId: 'delayed-resume-thread' });
    expect(id).toBe('delayed-resume-thread');
    await expect(s.run(id, 'timeout', started)).rejects.toBeInstanceOf(UncertainDelivery);
    expect(started).not.toHaveBeenCalled();
  });
  it('requires the worker coordination MCP when resuming a bound peer', async () => {
    expect(await session().open({ ...worker, threadId: 'required-worker-thread' })).toBe('required-worker-thread');
  });
  it('separates an existing-thread resume timeout from an ambiguous model submission', async () => {
    const s = session();
    try { await s.open({ ...worker, threadId: 'resume-timeout-thread' }); expect.fail('Expected timeout'); }
    catch (error) { expect(error).not.toBeInstanceOf(UncertainDelivery); expect(String(error)).toMatch(/thread\/resume timed out/); }
  });
  it('explains an active writer conflict without exposing arbitrary server errors', async () => {
    await expect(session().open({ ...worker, threadId: 'locked-thread' })).rejects.toThrow(/active writer/);
    try { await session().open({ ...worker, threadId: 'private-error-thread' }); expect.fail('Expected rejection'); }
    catch (error) { expect(String(error)).toContain('-32603'); expect(String(error)).not.toContain('private-token-value'); }
  });
  it('keeps uncertainty when a newly created session identity was never acknowledged', async () => {
    await expect(session().open({ ...worker, workspacePath: process.cwd() + '/new-thread-timeout' })).rejects.toBeInstanceOf(UncertainDelivery);
  });
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
