// Exercise both persisted prompt fields at asynchronous preparation boundaries;
// adapter barriers never start a model or replay an uncertain delivery.
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { EventRuntime } from '../../src/event-runtime.js';
import type { SessionInstructions } from '../../src/harness/contract.js';

const barrier = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const snapshot = (instructions: SessionInstructions) => JSON.parse(instructions.revision);
function setup(opened: (count: number) => Promise<void> = async () => {}, run: () => Promise<void> = async () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-settings-runtime-')), path = join(dir, 'board.sqlite');
  const store = new Store(path), prepared: SessionInstructions[] = [], applied: SessionInstructions[] = [];
  let current: SessionInstructions;
  const runtime = new EventRuntime(store, { databasePath: path, serverEntry: 'unused', notificationBatchMs: 0, debounceMs: 60000,
    wakePolicy: 'reference-quiet', adapter: () => ({
      open: async (_worker, instructions) => { current = instructions!; prepared.push(current); await opened(prepared.length); return 'retained-thread'; },
      run: async () => { applied.push(current); await run(); }, close: async () => {},
    }) });
  const goal = store.createTask({ title: 'Synthetic settings continuation' });
  const pool = runtime.configurePool({ workspacePath: dir, size: 1, taskIds: [goal.id] });
  const member = runtime.workers.register({ name: 'Synthetic settings member', workspacePath: dir });
  store.registerAgent({ agentId: member.id, name: member.name });
  runtime.workers.savePool({ ...pool, memberIds: [member.id] });
  runtime.workers.save({ ...member, poolId: pool.id, cursor: store.board().cursor });
  const user = (text: string) => store.writeUserPrompt({ text, source: 'human-input', expectedVersion: store.readUserPrompt().version });
  const system = (text: string) => store.writePreferences({ text, source: 'human-input', expectedVersion: store.readPreferences().version });
  const idle = () => vi.waitFor(() => expect(runtime.workers.get(member.id).status).toBe('idle'));
  const finish = async () => { await runtime.close(); store.close(); rmSync(dir, { recursive: true, force: true }); };
  return { store, runtime, goal, member, prepared, applied, user, system, idle, finish };
}
describe('dual prompt runtime snapshots', () => {
  it('wakes on the independent user field and delivers its clear without losing the system field', async () => {
    const b = setup();
    try {
      b.system('Synthetic system'); b.user('Synthetic user');
      await b.runtime.scan(); await b.idle();
      expect(snapshot(b.applied[0]!)).toMatchObject({ text: 'Synthetic system', version: 1, userPrompt: { text: 'Synthetic user', version: 1 } });
      b.user(''); await b.runtime.scan(); await b.idle();
      expect(b.applied).toHaveLength(2);
      expect(snapshot(b.applied[1]!)).toMatchObject({ text: 'Synthetic system', version: 1, userPrompt: { text: '', version: 2 } });
      expect(b.applied[1]!.text).not.toContain('Synthetic user');
      expect(b.runtime.workers.get(b.member.id).threadId).toBe('retained-thread');
    } finally { await b.finish(); }
  });
  it('reprepares either changed field during open and submits one latest coherent snapshot', async () => {
    const first = barrier(), second = barrier();
    const b = setup(async count => { if (count === 1) await first.promise; if (count === 2) await second.promise; });
    try {
      b.system('Old system'); b.user('Old user'); await b.runtime.scan();
      b.user('New user'); first.release(); await vi.waitFor(() => expect(b.prepared).toHaveLength(2));
      b.system(''); second.release(); await b.idle();
      expect(b.prepared).toHaveLength(3); expect(b.applied).toHaveLength(1);
      expect(snapshot(b.applied[0]!)).toMatchObject({ text: '', version: 2, userPrompt: { text: 'New user', version: 2 } });
    } finally { first.release(); second.release(); await b.finish(); }
  });
  it('keeps active work running and adopts only the newest queued user value after completion', async () => {
    const running = barrier(); let runs = 0;
    const b = setup(undefined, async () => { if (++runs === 1) await running.promise; });
    try {
      b.system('Keep system'); b.user('First user'); await b.runtime.scan(); await vi.waitFor(() => expect(b.applied).toHaveLength(1));
      b.user('Intermediate user'); b.user(''); await b.runtime.scan(); expect(b.applied).toHaveLength(1);
      running.release(); await b.idle(); await b.runtime.scan(); await b.idle();
      expect(b.applied).toHaveLength(2);
      expect(snapshot(b.applied[1]!)).toMatchObject({ text: 'Keep system', userPrompt: { text: '', version: 3 } });
    } finally { running.release(); await b.finish(); }
  });
  it('fails before submission on continuous user edits while retaining the original queue and thread', async () => {
    let changes = 0;
    const b = setup(async () => { b.user(`Changed user ${++changes}`); });
    try {
      const cursor = b.runtime.workers.get(b.member.id).cursor;
      b.user('Initial user'); await b.runtime.scan();
      await vi.waitFor(() => expect(b.runtime.workers.get(b.member.id).status).toBe('error'));
      expect(changes).toBe(3); expect(b.applied).toHaveLength(0);
      expect(b.runtime.workers.get(b.member.id)).toMatchObject({ threadId: 'retained-thread', cursor, deliveryPhase: 'opening' });
    } finally { await b.finish(); }
  });
  it('does not replay unresolved work for a user prompt update', async () => {
    const b = setup();
    try {
      const member = b.runtime.workers.get(b.member.id);
      b.runtime.workers.save({ ...member, status: 'uncertain', threadId: 'retained-thread', deliveryPhase: 'running', deliveryId: 'unresolved', turnId: 'unknown-turn', deliveryCursor: member.cursor });
      b.user('Queued after unknown'); await b.runtime.scan();
      expect(b.applied).toHaveLength(0);
      expect(b.runtime.workers.get(member.id)).toMatchObject({ status: 'uncertain', cursor: member.cursor, deliveryId: 'unresolved', turnId: 'unknown-turn' });
    } finally { await b.finish(); }
  });
});
