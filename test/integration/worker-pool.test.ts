// Verify organization behavior independently of model quality: peers share human
// goals, communicate through context, and stop without polluting human panels.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../../src/store.js';
import { EventRuntime } from '../../src/event-runtime.js';
import type { SessionAdapter } from '../../src/codex-session.js';
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'swarmboard-pool-')); const board = new Store(join(dir, 'board.sqlite'));
  const turns: { worker: string; prompt: string; threadId: string }[] = [], closed: string[] = [], finishes = new Map<string, () => void>();
  let hold = false;
  const runtime = new EventRuntime(board, { databasePath: join(dir, 'board.sqlite'), serverEntry: 'unused', adapter: worker => ({
    open: async w => w.threadId ?? 'thread-' + w.id,
    run: async (threadId, prompt, started) => { turns.push({ worker: worker.id, prompt, threadId }); started('turn-' + turns.length); if (hold) await new Promise<void>(resolve => { finishes.set(worker.id, resolve); }); },
    close: async () => { closed.push(worker.id); },
  } satisfies SessionAdapter) });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => board.close(), () => runtime.close());
  return { dir, board, runtime, turns, closed, finishes, hold: (value: boolean) => { hold = value; } };
}
describe('equal peer organization', () => {
  it('upgrades one authorized legacy binding without undoing a human pause', () => {
    vi.stubEnv('SWARMBOARD_PROJECT_PATH', '');
    try {
      const f = fixture(); const worker = f.runtime.register({ name: 'Legacy', workspacePath: f.dir });
      f.runtime.update({ id: worker.id, expectedVersion: worker.version, enabled: false });
      f.runtime.options.autoPool = true; f.runtime.start();
      expect(f.runtime.status().pool).toMatchObject({ size: 3, enabled: false, memberIds: [], workspacePath: worker.workspacePath });
      expect(f.turns).toHaveLength(0);
    } finally { vi.unstubAllEnvs(); }
  });
  it('rechecks a stop committed while sessions are opening before starting any turn', async () => {
    const f = fixture(); let release!: () => void; const opened = new Promise<void>(r => { release = r; });
    f.runtime.options.adapter = () => ({ open: async w => { await opened; return 'thread-' + w.id; }, run: async () => { throw new Error('Stopped organization must not submit'); }, close: async () => {} });
    const pool = f.runtime.configurePool({ workspacePath: f.dir }); f.board.createTask({ title: 'Goal' });
    await f.runtime.scan(); f.runtime.controlPool({ expectedVersion: pool.version, enabled: false }); release();
    await vi.waitFor(() => expect(f.runtime.workers.list().every(w => w.status === 'idle')).toBe(true));
    await f.runtime.scan(); expect(f.runtime.status().pool?.state).toBe('stopped');
    expect(f.runtime.workers.list().every(w => !w.error && !w.deliveryId)).toBe(true);
  });
  it('automatically supplies three peers for one human goal and forwards peer findings without creating cards', async () => {
    const f = fixture(); f.runtime.configurePool({ workspacePath: f.dir });
    const goal = f.board.createTask({ title: 'Human goal' }); await f.runtime.scan();
    await vi.waitFor(() => expect(f.turns).toHaveLength(3));
    await vi.waitFor(() => expect(f.runtime.workers.list().every(w => w.status === 'idle')).toBe(true));
    const workers = f.runtime.workers.list(); expect(new Set(workers.map(w => w.workspacePath)).size).toBe(3);
    for (const worker of workers) f.board.publishEntry({ agentId: worker.id, taskId: goal.id, kind: 'CLAIM', summary: 'My contribution scope ' + worker.id });
    f.board.publishEntry({ agentId: workers[0]!.id, taskId: goal.id, kind: 'FAIL', summary: 'Counterexample peers must learn' });
    await f.runtime.scan(); await vi.waitFor(() => expect(f.turns).toHaveLength(6));
    expect(f.turns.filter(t => t.worker !== workers[0]!.id).some(t => t.prompt.includes('Counterexample peers must learn'))).toBe(true);
    expect(f.board.board().tasks).toHaveLength(1); expect(f.board.board().tasks[0]).toMatchObject({ id: goal.id, assignee: null, participants: workers.map(w => w.id).sort(), status: 'in_progress' });
    expect(f.board.board().resources).toHaveLength(0);
    expect(f.turns[0]!.prompt).toContain('No coordinator, fixed role');
    expect(f.turns[0]!.prompt).toContain('NEVER create task cards');
  });
  it('bounds concurrency, preserves an explicit stop during active turns and reuses identities after resume', async () => {
    const f = fixture(); const pool = f.runtime.configurePool({ workspacePath: f.dir }); f.hold(true);
    f.board.createTask({ title: 'Goal' }); await f.runtime.scan(); await vi.waitFor(() => expect(f.finishes.size).toBe(3));
    const identities = f.runtime.workers.list().map(w => [w.id, w.threadId]);
    f.runtime.controlPool({ expectedVersion: pool.version, enabled: false });
    await f.runtime.scan(); expect(f.turns).toHaveLength(3);
    f.hold(false); for (const finish of f.finishes.values()) finish();
    await vi.waitFor(() => expect(f.runtime.workers.list().every(w => w.status === 'idle')).toBe(true));
    await f.runtime.scan(); expect(f.runtime.workers.pool()?.state).toBe('stopped'); expect(f.closed).toHaveLength(3);
    f.board.registerAgent({ agentId: 'human-peer', name: 'Human' });
    f.board.publishEntry({ agentId: 'human-peer', kind: 'MESSAGE', summary: 'Resume scope' }); await f.runtime.scan(); expect(f.turns).toHaveLength(3);
    f.runtime.controlPool({ expectedVersion: pool.version + 1, enabled: true }); await f.runtime.scan();
    await vi.waitFor(() => expect(f.turns).toHaveLength(6)); expect(f.runtime.workers.list().map(w => [w.id, w.threadId])).toEqual(identities);
    expect(() => f.runtime.controlPool({ expectedVersion: 1, enabled: false })).toThrow(/Pool changed/);
  });
  it('closes model processes on completion, does not invent work, and wakes again on a new human goal', async () => {
    const f = fixture(); f.runtime.configurePool({ workspacePath: f.dir });
    const goal = f.board.createTask({ title: 'Goal' }); await f.runtime.scan(); await vi.waitFor(() => expect(f.turns).toHaveLength(3));
    await vi.waitFor(() => expect(f.runtime.workers.list().every(w => w.status === 'idle')).toBe(true));
    const ids = f.runtime.workers.list().map(w => w.id);
    f.board.updateTask(goal.id, { expectedVersion: 1, status: 'done' }); await f.runtime.scan();
    expect(f.runtime.workers.pool()?.state).toBe('completed'); expect(f.closed).toHaveLength(3);
    await f.runtime.scan(); expect(f.turns).toHaveLength(3);
    f.board.createTask({ title: 'New human goal' }); await f.runtime.scan(); await vi.waitFor(() => expect(f.turns).toHaveLength(6));
    expect(f.runtime.workers.list().map(w => w.id)).toEqual(ids);
  });
  it('keeps blocked goals waiting and consumes no model turns on repeated empty scans', async () => {
    const f = fixture(); f.runtime.configurePool({ workspacePath: f.dir });
    const goal = f.board.createTask({ title: 'Dependent goal' }); f.board.updateTask(goal.id, { expectedVersion: 1, status: 'blocked' });
    await f.runtime.scan(); await f.runtime.scan(); expect(f.turns).toHaveLength(0); expect(f.runtime.workers.pool()?.state).toBe('waiting');
    expect(f.runtime.workers.list()).toHaveLength(0);
    f.board.updateTask(goal.id, { expectedVersion: 2, status: 'todo' }); await f.runtime.scan(); await vi.waitFor(() => expect(f.turns).toHaveLength(3));
    await vi.waitFor(() => expect(f.runtime.workers.list().every(w => w.status === 'idle')).toBe(true));
    await f.runtime.scan(); await f.runtime.scan(); expect(f.turns).toHaveLength(3);
  });
  it('isolates tracked source code and Git metadata without copying untracked secrets', async () => {
    const f = fixture(); const git = (...args: string[]) => execFileSync('git', ['-C', f.dir, ...args], { stdio: 'ignore' });
    git('init'); writeFileSync(join(f.dir, 'fixture.txt'), 'synthetic'); writeFileSync(join(f.dir, '.env'), 'SYNTHETIC_ONLY=never-copy');
    git('add', 'fixture.txt'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Synthetic fixture');
    expect(() => f.runtime.configurePool({ workspacePath: 'relative' })).toThrow(/absolute project/);
    f.runtime.configurePool({ workspacePath: f.dir }); f.board.createTask({ title: 'Goal' }); await f.runtime.scan();
    await vi.waitFor(() => expect(f.turns).toHaveLength(3));
    for (const worker of f.runtime.workers.list()) {
      expect(existsSync(join(worker.workspacePath, '.git', 'config'))).toBe(true);
      expect(existsSync(join(worker.workspacePath, 'fixture.txt'))).toBe(true); expect(existsSync(join(worker.workspacePath, '.env'))).toBe(false);
    }
    expect(() => f.runtime.configurePool({ workspacePath: f.dir, taskIds: [f.board.board().tasks[0]!.id], expectedVersion: 1 })).toThrow(/bound organization/);
  });
});
