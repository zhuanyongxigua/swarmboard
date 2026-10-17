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
  it('widens a running selected-goal organization and catches up excluded goals in every original session', async () => {
    const f=fixture(); const first=f.board.createTask({title:'First goal'});
    const pool=f.runtime.configurePool({workspacePath:f.dir,taskIds:[first.id]});
    await f.runtime.scan(); await vi.waitFor(()=>expect(f.turns).toHaveLength(3));
    await vi.waitFor(()=>expect(f.runtime.workers.list().every(w=>w.status==='idle')).toBe(true));
    const bindings=f.runtime.workers.list().map(w=>[w.id,w.threadId]);
    const missed=f.board.createTask({title:'Previously excluded goal'});await f.runtime.scan();
    expect(f.turns).toHaveLength(3);expect(f.runtime.workers.list().every(w=>w.cursor>=f.board.board().cursor)).toBe(true);
    const staleWorkers=f.runtime.workers.list();
    f.runtime.configurePool({workspacePath:f.dir,taskIds:[],expectedVersion:pool.version});
    const late=f.board.createTask({title:'Created during the subscription transition'});
    // Simulate the late checkpoint of a scan that read the old subscription.
    for(const worker of staleWorkers)f.runtime.workers.save({...worker,cursor:f.board.board().cursor});
    await f.runtime.scan();await vi.waitFor(()=>expect(f.turns).toHaveLength(6));
    await vi.waitFor(()=>expect(f.runtime.workers.list().every(w=>w.status==='idle')).toBe(true));
    for(const [id] of bindings)for(const goal of [missed,late])expect(f.turns.filter(t=>t.worker===id).at(-1)?.prompt).toContain(goal.id);
    expect(f.runtime.workers.list().map(w=>[w.id,w.threadId])).toEqual(bindings);
    expect(f.runtime.workers.list().every(w=>w.taskIds.length===0)).toBe(true);
    expect(f.board.board().tasks).toHaveLength(3);expect(f.board.board().resources).toHaveLength(0);
    const count=f.board.board().entries.filter(e=>e.summary==='BOARD_SCOPE_EXPANDED').length;
    await f.runtime.scan();expect(f.board.board().entries.filter(e=>e.summary==='BOARD_SCOPE_EXPANDED')).toHaveLength(count);
    expect(()=>f.runtime.configurePool({workspacePath:f.dir,taskIds:[first.id],expectedVersion:pool.version+1})).toThrow(/bound organization/);
  });
  it('delivers new goals to idle peers while a busy peer keeps both goals queued without a human-goal barrier', async () => {
    const f=fixture(); f.runtime.configurePool({workspacePath:f.dir}); const first=f.board.createTask({title:'Goal A'});
    f.hold(true);await f.runtime.scan();await vi.waitFor(()=>expect(f.finishes.size).toBe(3));
    const workers=f.runtime.workers.list();const busy=workers[0]!;const bindings=workers.map(w=>[w.id,w.threadId]);
    f.hold(false);for(const w of workers.slice(1))f.finishes.get(w.id)!();
    await vi.waitFor(()=>expect(f.runtime.workers.get(workers[1]!.id).status).toBe('idle'));
    const second=f.board.createTask({title:'Goal B'});const third=f.board.createTask({title:'Goal C'});
    await f.runtime.scan();await vi.waitFor(()=>expect(f.turns).toHaveLength(5));
    expect(f.runtime.workers.get(busy.id).status).toBe('running');
    for(const w of workers.slice(1)){const prompt=f.turns.filter(t=>t.worker===w.id).at(-1)!.prompt;expect(prompt).toContain(second.id);expect(prompt).toContain(third.id);}
    // One peer may join several unfinished goals; each goal may have several peers.
    for(const w of workers)for(const goal of [first,second,third])f.board.publishEntry({agentId:w.id,taskId:goal.id,kind:'CLAIM',summary:'Independently chosen scope'});
    expect(f.board.board().tasks.every(t=>t.participants.length===3&&t.status==='in_progress')).toBe(true);
    f.finishes.get(busy.id)!();await vi.waitFor(()=>expect(f.runtime.workers.get(busy.id).status).toBe('idle'));
    await f.runtime.scan();await vi.waitFor(()=>expect(f.turns.filter(t=>t.worker===busy.id)).toHaveLength(2));
    const prompt=f.turns.filter(t=>t.worker===busy.id).at(-1)!.prompt;expect(prompt).toContain(second.id);expect(prompt).toContain(third.id);
    await vi.waitFor(()=>expect(f.runtime.workers.list().every(w=>w.status==='idle')).toBe(true));
    expect(f.runtime.workers.list().map(w=>[w.id,w.threadId])).toEqual(bindings);
    f.board.updateTask(first.id,{expectedVersion:f.board.board().tasks.find(t=>t.id===first.id)!.version,status:'done'});await f.runtime.scan();expect(f.runtime.workers.pool()?.state).toBe('active');
    for(const goal of [second,third])f.board.updateTask(goal.id,{expectedVersion:f.board.board().tasks.find(t=>t.id===goal.id)!.version,status:'done'});
    await vi.waitFor(()=>expect(f.runtime.workers.list().every(w=>w.status==='idle')).toBe(true));await f.runtime.scan();expect(f.runtime.workers.pool()?.state).toBe('completed');
    const count=f.turns.length;await f.runtime.scan();expect(f.turns).toHaveLength(count);expect(f.board.board().tasks).toHaveLength(3);expect(f.board.board().resources).toHaveLength(0);
  });

  it('preserves explicit selected subscriptions on omitted fields and a human pause when widening', async () => {
    const f=fixture();const goal=f.board.createTask({title:'Selected'});let pool=f.runtime.configurePool({workspacePath:f.dir,taskIds:[goal.id]});
    await f.runtime.scan();await vi.waitFor(()=>expect(f.runtime.workers.list().every(w=>w.status==='idle')).toBe(true));
    pool=f.runtime.configurePool({workspacePath:f.dir,size:4,expectedVersion:pool.version});expect(pool.taskIds).toEqual([goal.id]);
    pool=f.runtime.controlPool({expectedVersion:pool.version,enabled:false});
    const missed=f.board.createTask({title:'Excluded before widening'});await f.runtime.scan();const count=f.turns.length;
    const stale=pool;pool=f.runtime.configurePool({workspacePath:f.dir,size:4,taskIds:[],expectedVersion:pool.version});
    f.runtime.workers.checkpointPool(stale);expect(f.runtime.workers.pool()?.scopeRefresh).toEqual(pool.scopeRefresh);
    await f.runtime.scan();expect(f.turns).toHaveLength(count);expect(f.runtime.workers.pool()?.enabled).toBe(false);
    expect(f.board.board().entries.some(e=>e.summary==='BOARD_SCOPE_EXPANDED')).toBe(false);
    expect(()=>f.runtime.configurePool({workspacePath:f.dir,taskIds:[],expectedVersion:stale.version})).toThrow(/Pool changed/);
    f.runtime.controlPool({expectedVersion:pool.version,enabled:true});await f.runtime.scan();
    await vi.waitFor(()=>expect(f.turns.length).toBeGreaterThan(count));
    expect(f.board.board().entries.some(e=>e.summary==='BOARD_SCOPE_EXPANDED'&&e.taskId===missed.id)).toBe(true);
  });
  it('recovers a persisted scope refresh after publication fails without duplicating its board signal', async () => {
    const f=fixture();const goal=f.board.createTask({title:'Selected'});const pool=f.runtime.configurePool({workspacePath:f.dir,taskIds:[goal.id]});
    await f.runtime.scan();await vi.waitFor(()=>expect(f.runtime.workers.list().every(w=>w.status==='idle')).toBe(true));
    const missed=f.board.createTask({title:'Excluded'});await f.runtime.scan();
    f.runtime.configurePool({workspacePath:f.dir,taskIds:[],expectedVersion:pool.version});
    const publish=f.board.publishSystemEntryOnce.bind(f.board);
    const fault=vi.spyOn(f.board,'publishSystemEntryOnce').mockImplementationOnce(input=>{publish(input);throw new Error('Publication acknowledgement lost');});
    await expect(f.runtime.scan()).rejects.toThrow('Publication acknowledgement lost');expect(f.runtime.workers.pool()?.scopeRefresh).toBeDefined();fault.mockRestore();
    const bindings=f.runtime.workers.list().map(w=>[w.id,w.threadId]);
    cleanups.pop(); await f.runtime.close();
    const restored=new EventRuntime(f.board,{databasePath:join(f.dir,'board.sqlite'),serverEntry:'unused',adapter:w=>({open:async()=>w.threadId!,run:async()=>{},close:async()=>{}})});
    cleanups.push(()=>restored.close());await restored.scan();
    await vi.waitFor(()=>expect(restored.workers.list().every(w=>w.status==='idle')).toBe(true));
    expect(restored.workers.pool()?.scopeRefresh).toBeUndefined();
    expect(f.board.board().entries.filter(e=>e.summary==='BOARD_SCOPE_EXPANDED'&&e.taskId===missed.id)).toHaveLength(1);
    expect(restored.workers.list().map(w=>[w.id,w.threadId])).toEqual(bindings);
  });
  it('reports actual execution while peers handle an update to a waiting goal',async()=>{
    const f=fixture();f.runtime.configurePool({workspacePath:f.dir});f.hold(true);const goal=f.board.createTask({title:'Goal'});
    await f.runtime.scan();await vi.waitFor(()=>expect(f.finishes.size).toBe(3));
    f.board.updateTask(goal.id,{expectedVersion:1,status:'blocked'});await f.runtime.scan();
    expect(f.runtime.status()).toMatchObject({pool:{state:'waiting'},activity:{running:3,state:'running'}});
    f.hold(false);for(const finish of f.finishes.values())finish();await vi.waitFor(()=>expect(f.runtime.workers.list().every(w=>w.status==='idle')).toBe(true));
    await f.runtime.scan();await vi.waitFor(()=>expect(f.runtime.workers.list().every(w=>w.status==='idle')).toBe(true));await f.runtime.scan();
    expect(f.runtime.status().activity).toMatchObject({running:0,state:'waiting'});
  });
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
