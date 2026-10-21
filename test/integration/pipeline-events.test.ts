// Verify real durable subscriptions with controlled provider responses. Model
// substitutes prove routing and recovery, not GitLab availability or MR approval.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../../src/store.js';
import { EventRuntime } from '../../src/event-runtime.js';
import { projectRemote } from '../../src/pipeline-events.js';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const sha = 'a'.repeat(40);
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'swarmboard-ci-')), path = join(dir, 'board.sqlite'), board = new Store(path);
  execFileSync('git', ['init', dir], { stdio: 'ignore' }); execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://gitlab.example.invalid/group/project.git']);
  let now = 1000, status = 'running'; const reader = vi.fn(async () => ({ status, sha }));
  const turns: { id: string; prompt: string; thread: string }[] = [];
  // This suite asserts the legacy IDLE_RECOVERY/IDLE_ATTENTION contract.
  const make = () => new EventRuntime(board, { notificationBatchMs: 0, sessionCheckMs: 0, databasePath: path, serverEntry: 'unused', now: () => now, pipelineReader: reader, adapter: w => ({ open: async worker => worker.threadId ?? 'thread-' + worker.id, run: async (thread, prompt) => { turns.push({ id: w.id, prompt, thread }); }, close: async () => {} }) });
  let runtime = make(); runtime.configurePool({ workspacePath: dir }); const goal = board.createTask({ title: 'CI-gated human goal' });
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }), () => board.close(), () => runtime.close());
  const settle = async () => { await runtime.scan(); await vi.waitFor(() => expect(runtime.workers.list().every(w => w.status === 'idle')).toBe(true)); };
  return { dir, board, goal, reader, turns, settle, get runtime() { return runtime; }, tick: (ms=60000) => { now += ms; }, result: (value: string) => { status = value; }, restart: async () => { await runtime.close(); runtime = make(); }, watch: (pipelineId = 100) => runtime.ci.register({ taskId: goal.id, pipelineId, sha }) };
}
describe('durable CI events', () => {
  it('does not hide another stranded goal behind an unrelated running CI subscription',async()=>{
    const f=fixture();await f.settle();f.watch();const other=f.board.createTask({title:'Another actionable goal'});
    await f.settle();await f.settle();f.tick(660000);await f.settle();
    const signal=f.board.board().entries.find(e=>e.summary.startsWith('IDLE_RECOVERY'));
    expect(signal).toBeDefined();expect(JSON.parse(signal!.detail).goalIds).toEqual([other.id]);
    expect(f.runtime.ci.list()[0]!.state).toBe('watching');
  });
  it('announces manual action once and keeps watching until an actual terminal result',async()=>{
    const f=fixture();await f.settle();f.watch();f.result('manual');await f.settle();
    f.tick();await f.settle();expect(f.board.board().entries.filter(e=>e.summary.startsWith('PIPELINE_RESULT'))).toHaveLength(1);
    expect(f.runtime.ci.list()[0]!.state).toBe('watching');f.result('failed');f.tick();await f.settle();
    expect(f.board.board().entries.filter(e=>e.summary.startsWith('PIPELINE_RESULT'))).toHaveLength(2);
    expect(f.runtime.ci.list()[0]).toMatchObject({state:'delivered',lastStatus:'failed'});
    expect(f.board.board().tasks[0]!.status).toBe('todo');
  });
  it('derives one authorized project without persisting origin credentials or accepting arbitrary endpoints', () => {
    const f=fixture();const origin=(url:string)=>execFileSync('git',['-C',f.dir,'remote','set-url','origin',url]);
    for(const url of ['https://user:secret@gitlab.example.invalid/group/project.git','git@gitlab.example.invalid:group/project.git','ssh://git@gitlab.example.invalid:2222/group/project.git']) {
      origin(url);expect(projectRemote(f.dir)).toEqual({host:'gitlab.example.invalid',project:'group/project'});
    }
    for(const url of ['/tmp/local-repo','file:///tmp/local','http://gitlab.example.invalid/group/project','https://gitlab.example.invalid/group/project?token=secret']) {
      origin(url);expect(()=>projectRemote(f.dir)).toThrow(/Origin/);
    }
  });
  it('rejects changed SHA for the same pipeline and ignores a result when stopped during its lookup', async()=>{
    const f=fixture();await f.settle();f.watch();
    expect(()=>f.runtime.ci.register({taskId:f.goal.id,pipelineId:100,sha:'b'.repeat(40)})).toThrow(/different SHA/);
    let release!:(value:{status:string;sha:string})=>void;
    f.reader.mockImplementationOnce(()=>new Promise(r=>{release=r;}));const polling=f.runtime.scan();await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
    f.runtime.controlPool({expectedVersion:f.runtime.workers.pool()!.version,enabled:false});release({status:'success',sha});await polling;
    expect(f.board.board().entries.some(e=>e.summary.startsWith('PIPELINE_RESULT'))).toBe(false);
  });
  it('polls without model turns, then wakes all original peers exactly once when CI finishes after restart', async () => {
    const f = fixture(); await f.settle(); const bindings = f.runtime.workers.list().map(w => [w.id, w.threadId]); f.watch(); f.turns.length = 0;
    await f.settle(); expect(f.turns).toHaveLength(0); f.tick(); await f.settle(); expect(f.turns).toHaveLength(0);
    await f.restart(); f.result('success'); f.tick(); await f.settle();
    expect(f.turns).toHaveLength(3); expect(f.turns.every(t => t.prompt.includes('PIPELINE_RESULT') && t.prompt.includes(sha))).toBe(true);
    f.tick(); await f.settle(); expect(f.turns).toHaveLength(3);
    expect(f.runtime.workers.list().map(w => [w.id, w.threadId])).toEqual(bindings);
    expect(f.board.board().tasks[0]!.status).toBe('todo');
  });
  it('suppresses a superseded in-flight result and rejects old subscriptions', async () => {
    const f = fixture(); await f.settle(); f.watch(); let release!: (value: { status: string; sha: string }) => void;
    f.reader.mockImplementationOnce(() => new Promise(r => { release = r; })); const polling = f.runtime.scan();
    await vi.waitFor(() => expect(release).toBeTypeOf('function')); f.watch(101); release({ status: 'success', sha }); await polling;
    expect(f.board.board().entries.some(e => e.summary.includes('PIPELINE_RESULT'))).toBe(false);
    expect(() => f.watch(99)).toThrow(/newer/);
  });
  it('preserves a persisted outbox signal across restart without duplicating publication', async () => {
    const f = fixture(); await f.settle(); f.watch(); f.result('success');
    const publish = f.board.publishSystemEntryOnce.bind(f.board); let fail = true;
    vi.spyOn(f.board, 'publishSystemEntryOnce').mockImplementation(input => { const result = publish(input); if (fail) { fail = false; throw new Error('Crash after durable event'); } return result; });
    await expect(f.runtime.scan()).rejects.toThrow('Crash after durable event'); await f.restart(); await f.settle();
    expect(f.board.board().entries.filter(e => e.summary.includes('PIPELINE_RESULT'))).toHaveLength(1);
    expect(f.runtime.ci.list()[0]!.state).toBe('delivered');
  });
  it('does not poll paused or completed goals, and reports failures without fabricating success', async () => {
    const f = fixture(); await f.settle(); f.watch(); const pool = f.runtime.workers.pool()!;
    f.runtime.controlPool({ expectedVersion: pool.version, enabled: false }); await f.settle(); expect(f.reader).not.toHaveBeenCalled();
    f.runtime.controlPool({ expectedVersion: pool.version + 1, enabled: true }); f.reader.mockRejectedValue(new Error('Sensitive provider diagnostic must stay private'));
    for (let n = 0; n < 3; n++) { f.tick(); await f.settle(); }
    expect(f.runtime.ci.list()[0]).toMatchObject({ state: 'error', failures: 3 });
    expect(JSON.stringify(f.board.board())).not.toContain('Sensitive provider diagnostic');
    expect(f.board.board().entries.some(e => e.kind === 'FAIL' && e.summary.includes('PIPELINE_ERROR'))).toBe(true);
    f.runtime.ci.register({ taskId: f.goal.id, pipelineId: 101, sha }); f.board.updateTask(f.goal.id, { expectedVersion: 1, status: 'done' });
    f.tick(); await f.settle(); expect(f.runtime.ci.list().find(w => w.pipelineId === 101)!.state).toBe('canceled');
  });
  it('rejects wrong SHA, unrelated tasks and callers outside the organization', async () => {
    const f = fixture(); await f.settle();
    expect(() => f.runtime.ci.register({ taskId: f.goal.id, pipelineId: 100, sha }, 'outsider')).toThrow(/member/);
    expect(() => f.runtime.ci.register({ taskId: 'unknown-goal', pipelineId: 100, sha })).toThrow(/goal/);
    f.watch(); f.reader.mockResolvedValue({ status: 'success', sha: 'b'.repeat(40) });
    for (let n = 0; n < 3; n++) { f.tick(); await f.settle(); }
    expect(f.board.board().entries.some(e => e.summary.includes('PIPELINE_RESULT'))).toBe(false);
  });
});
