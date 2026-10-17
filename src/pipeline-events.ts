// Turn bounded GitLab CLI reads into durable, SHA-bound organization events.
// Model workers subscribe and stop; they never poll or receive credentials.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError, parse, type Entry, type Store } from './store.js';
import type { WorkerStore } from './worker-store.js';
const exec = promisify(execFile);
export const pipelineSchema = z.object({ taskId: z.string().min(1).max(128), pipelineId: z.number().int().positive(), sha: z.string().regex(/^[a-f0-9]{40}$/), retry: z.boolean().default(false) }).strict();
const resultSchema = z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/), status: z.enum(['created','waiting_for_resource','preparing','pending','running','success','failed','canceled','skipped','manual','scheduled']) });
export interface PipelineWatch {
  id: string; poolId: string; taskId: string; pipelineId: number; sha: string;
  host: string; project: string; generation: number; state: 'watching' | 'delivered' | 'error' | 'canceled';
  nextPollAt: number; failures: number; error: string; lastStatus: string; announcedStatus: string;
  pending: Omit<Entry, 'id' | 'createdAt'> | null; finishAfterPublish: boolean;
}
export type PipelineReader = (watch: PipelineWatch) => Promise<{ sha: string; status: string }>;
export function projectRemote(workspacePath: string) {
  let remote: string;
  try { remote = execFileSync('git', ['-C', workspacePath, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'], timeout: 5000 }).trim(); }
  catch { throw new AppError('CI_PROJECT_UNBOUND', 'Bind the authorized project to a GitLab origin before subscribing'); }
  const scp = /^(?:[^@/:]+@)?([a-zA-Z0-9.-]+):([^/].*)$/.exec(remote);
  let url: URL;
  try { url = new URL(scp && !remote.includes('://') ? 'ssh://' + scp[1] + '/' + scp[2] : remote); }
  catch { throw new AppError('CI_PROJECT_UNBOUND', 'Origin must be an HTTPS or SSH GitLab project'); }
  const project = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
  if (!['https:','ssh:'].includes(url.protocol) || url.search || url.hash || !/^[a-zA-Z0-9.-]+(?::[0-9]+)?$/.test(url.host) || !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(project)) throw new AppError('CI_PROJECT_UNBOUND', 'Origin must identify one authorized GitLab project');
  return { host: url.protocol === 'ssh:' ? url.hostname : url.host, project };
}
export const readGitLabPipeline: PipelineReader = async watch => {
  const binary = ['/opt/homebrew/bin/glab','/usr/local/bin/glab'].find(path => existsSync(path)) ?? 'glab';
  const { stdout } = await exec(binary, ['api', '--hostname', watch.host, `projects/${encodeURIComponent(watch.project)}/pipelines/${watch.pipelineId}`], { timeout: 15000, maxBuffer: 262144, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return resultSchema.parse(JSON.parse(stdout));
};
export class PipelineEvents {
  constructor(private board: Store, private workers: WorkerStore, private reader: PipelineReader = readGitLabPipeline, private now = Date.now, private mayPublish = () => true) {
    workers.db.exec('CREATE TABLE IF NOT EXISTS pipeline_watches(id TEXT PRIMARY KEY,data TEXT NOT NULL)');
  }
  list(): PipelineWatch[] { return this.workers.db.prepare('SELECT data FROM pipeline_watches ORDER BY id').all().map(r => JSON.parse(String(r.data)) as PipelineWatch); }
  private save(watch: PipelineWatch) { this.workers.db.prepare('INSERT INTO pipeline_watches VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(watch.id, JSON.stringify(watch)); return watch; }
  private replace(before: PipelineWatch, after: PipelineWatch) {
    return this.workers.db.prepare('UPDATE pipeline_watches SET data=? WHERE id=? AND data=?').run(JSON.stringify(after), before.id, JSON.stringify(before)).changes === 1;
  }
  register(input: unknown, workerId?: string) {
    const data = parse(pipelineSchema, input), pool = this.workers.pool();
    if (!pool?.enabled) throw new AppError('POOL_STOPPED', 'The organization is stopped', 409);
    if (workerId && (!pool.memberIds.includes(workerId) || !this.workers.get(workerId).enabled)) throw new AppError('NOT_MEMBER', 'Only an enabled organization member may subscribe', 403);
    const task = this.board.taskStates().find(t => t.id === data.taskId);
    if (!task || pool.taskIds.length && !pool.taskIds.includes(task.id) || ['done','canceled'].includes(task.status)) throw new AppError('INVALID_GOAL', 'Subscribe only to an unfinished bound human goal');
    const remote = projectRemote(pool.workspacePath);
    return this.workers.transaction(() => {
      const current = this.workers.pool();
      if (!current?.enabled || current.id !== pool.id || current.workspacePath !== pool.workspacePath) throw new AppError('POOL_STOPPED', 'The organization changed or stopped', 409);
      const watches = this.list().filter(w => w.poolId === pool.id && w.taskId === task.id);
      if (watches.some(w => w.pipelineId > data.pipelineId)) throw new AppError('STALE_PIPELINE', 'A newer pipeline is already subscribed', 409);
      if (watches.some(w => w.pipelineId === data.pipelineId && w.sha !== data.sha)) throw new AppError('PIPELINE_SHA_CONFLICT', 'This pipeline is already bound to a different SHA', 409);
      const id = createHash('sha256').update(JSON.stringify([pool.id, task.id, data.pipelineId, data.sha])).digest('hex');
      const existing = watches.find(w => w.id === id);
      if (existing && !data.retry) return existing;
      for (const old of watches) if (old.id !== id && old.state === 'watching') this.save({ ...old, state: 'canceled', pending: null });
      return this.save({ id, poolId: pool.id, taskId: task.id, pipelineId: data.pipelineId, sha: data.sha, ...remote,
        generation: (existing?.generation ?? 0) + 1, state: 'watching', nextPollAt: this.now(), failures: 0, error: '', lastStatus: '', announcedStatus: '', pending: null, finishAfterPublish: false });
    });
  }
  hasPending() { return this.list().some(w => w.state === 'watching'); }
  async poll(now: number) {
    const pool = this.workers.pool(); if (!pool?.enabled) return;
    const goals = this.board.taskStates();
    for (const w of this.list().filter(w => w.state === 'watching')) if (w.poolId !== pool.id || !goals.some(t => t.id === w.taskId && !['done','canceled'].includes(t.status))) this.replace(w,{ ...w, state: 'canceled', pending: null });
    const due = this.list().filter(w => w.state === 'watching' && (w.pending || w.nextPollAt <= now)).sort((a,b) => a.nextPollAt - b.nextPollAt).slice(0,4);
    await Promise.all(due.map(w => this.pollOne(w, now)));
  }
  private async pollOne(watch: PipelineWatch, now: number) {
    let value = watch;
    if (!value.pending) {
      let result: { sha: string; status: string } | undefined;
      try { result = resultSchema.parse(await this.reader(watch)); if (result.sha !== watch.sha) throw new Error('Wrong pipeline commit'); }
      catch { result = undefined; /* Provider stderr may contain credentials or private payloads; never persist it. */ }
      if (!this.mayPublish()) return;
      const current = this.list().find(w => w.id === watch.id)!;
      const pool = this.workers.pool();
      if (!pool?.enabled || current.state !== 'watching' || current.generation !== watch.generation) return;
      if (!this.board.taskStates().some(t => t.id === watch.taskId && !['done','canceled'].includes(t.status))) { this.replace(current,{ ...current, state: 'canceled' }); return; }
      if (!result) {
        value = { ...current, failures: current.failures + 1, error: 'GitLab lookup failed or returned a different SHA; verify CLI authentication, network and pipeline identity', nextPollAt: now + 60000 };
        if (value.failures < 3) { this.replace(current,value); return; }
      } else {
        value = { ...current, lastStatus: result.status, failures: 0, error: '', nextPollAt: now + 30000 };
        const terminal = ['success','failed','canceled','skipped'].includes(result.status);
        if (!terminal && (result.status !== 'manual' || current.announcedStatus === 'manual')) { this.replace(current,value); return; }
        value.finishAfterPublish = terminal;
      }
      const failedLookup = !result;
      value.pending = { agentId: 'runtime-ci-' + watch.poolId, taskId: watch.taskId, kind: failedLookup ? 'FAIL' : 'OBSERVED',
        summary: failedLookup ? 'PIPELINE_ERROR: durable subscription needs attention' : `PIPELINE_RESULT: ${watch.pipelineId} ${value.lastStatus}`,
        detail: JSON.stringify({ signalId: `${watch.id}:${watch.generation}:${failedLookup ? 'error' : value.lastStatus}`, pipelineId: watch.pipelineId, sha: watch.sha, status: failedLookup ? 'lookup_error' : value.lastStatus,
          url: `https://${watch.host}/${watch.project}/-/pipelines/${watch.pipelineId}`, evidenceBoundary: 'Pipeline status is not MR approval, review acceptance or authorization to merge.' }) };
      if (!this.replace(current,value)) return;
    }
    this.workers.transaction(() => {
      const current = this.list().find(w => w.id === watch.id)!, pool = this.workers.pool();
      if (!this.mayPublish() || !pool?.enabled || current.state !== 'watching' || current.generation !== watch.generation) return;
      if (!this.board.taskStates().some(t => t.id === watch.taskId && !['done','canceled'].includes(t.status))) { this.save({ ...current, state: 'canceled', pending: null }); return; }
      const signal = current.pending!;
      if (!this.board.db.prepare('SELECT id FROM agents WHERE id=?').get(signal.agentId)) this.board.registerAgent({ agentId: signal.agentId, name: 'Swarmboard CI events' });
      this.board.publishSystemEntryOnce(signal);
      this.save({ ...current, pending: null, announcedStatus: current.lastStatus, state: current.failures >= 3 ? 'error' : current.finishAfterPublish ? 'delivered' : 'watching' });
    });
  }
}
