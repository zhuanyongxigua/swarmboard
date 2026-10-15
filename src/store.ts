import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
const text = z.string().trim().min(1).max(500);
const longText = z.string().max(20000);
const optionalText = longText.default('');
const id = z.string().trim().min(1).max(128);
export const taskStatuses = ['todo', 'in_progress', 'in_review', 'done', 'blocked', 'canceled'] as const;
export const entryKinds = ['OBSERVED', 'FACT', 'FAIL', 'CLAIM', 'PATCH_SUMMARY', 'MESSAGE'] as const;
const taskFields = { title: text, description: optionalText, acceptanceCriteria: optionalText };
// Retain the legacy kind column/API field without requiring resource classification.
const legacyResourceKind = z.string().trim().max(500);
const resourceFields = { name: text, kind: legacyResourceKind.default(''), description: optionalText, capabilities: z.array(text).max(50).default([]), accessNotes: optionalText };
export const schemas = {
  taskCreate: z.object({ ...taskFields, agentId: id.optional() }).strict(),
  taskUpdate: z.object({ expectedVersion: z.number().int().positive(), title: text.optional(), description: longText.optional(), acceptanceCriteria: longText.optional(), status: z.enum(taskStatuses).optional(), agentId: id.optional() }).strict(),
  resourceCreate: z.object({ ...resourceFields, agentId: id.optional() }).strict(),
  resourceUpdate: z.object({ expectedVersion: z.number().int().positive(), name: text.optional(), kind: legacyResourceKind.optional(), description: longText.optional(), capabilities: z.array(text).max(50).optional(), accessNotes: longText.optional(), agentId: id.optional() }).strict(),
  agent: z.object({ name: text, agentId: id.optional() }).strict(),
  claim: z.object({ agentId: id, expectedVersion: z.number().int().positive() }).strict(),
  taskRelease: z.object({ agentId: id, expectedVersion: z.number().int().positive(), status: z.enum(['todo', 'blocked']).default('todo') }).strict(),
  entry: z.object({ agentId: id, kind: z.enum(entryKinds), summary: text, detail: optionalText, taskId: id.optional(), resourceId: id.optional(), recipientId: id.optional() }).strict(),
  context: z.object({ after: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(200).default(50), kind: z.enum(entryKinds).optional(), agentId: id.optional(), taskId: id.optional(), resourceId: id.optional() }).strict(),
  usage: z.object({ resourceId: id, agentId: id, purpose: text, scope: optionalText, sharing: optionalText, taskId: id.optional() }).strict(),
  usageUpdate: z.object({ agentId: id, expectedVersion: z.number().int().positive(), purpose: text.optional(), scope: longText.optional(), sharing: longText.optional() }).strict(),
  release: z.object({ agentId: id, expectedVersion: z.number().int().positive() }).strict(),
};
export interface Task { id: string; title: string; description: string; acceptanceCriteria: string; status: typeof taskStatuses[number]; assignee: string | null; version: number; createdAt: string; updatedAt: string }
export interface Resource { id: string; name: string; kind: string; description: string; capabilities: string[]; accessNotes: string; version: number; createdAt: string; updatedAt: string }
export interface Agent { id: string; name: string; lastSeenAt: string }
export interface Entry { id: number; kind: typeof entryKinds[number]; agentId: string; summary: string; detail: string; taskId?: string; resourceId?: string; recipientId?: string; createdAt: string }
export interface Usage { id: string; resourceId: string; agentId: string; purpose: string; scope: string; sharing: string; taskId?: string; active: boolean; version: number; createdAt: string; updatedAt: string }
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError('VALIDATION_ERROR', result.error.issues.map(i => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
  return result.data;
}

/** SQLite is the shared authority; every state change and its event commit together. */
export class Store {
  readonly db: DatabaseSync;
  constructor(dbPath = ':memory:') {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    try {
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 250;');
      // WAL activation can return BUSY immediately when several new clients open a fresh file.
      // Retry only lock contention, with at most 20 attempts and a short startup-only wait.
      const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
      for (let attempt = 0; ; attempt++) {
        try { this.db.exec('PRAGMA journal_mode = WAL;'); break; }
        catch (error) {
          const locked = error instanceof Error && 'errcode' in error && typeof error.errcode === 'number'
            && [5, 6].includes(error.errcode & 0xff);
          if (!locked || attempt >= 19) throw error;
          Atomics.wait(waitBuffer, 0, 0, 25);
        }
      }
      this.db.exec('PRAGMA busy_timeout = 5000;');
      // Separate desktop MCP processes must inspect and apply migrations under the same write lock.
      this.transaction(() => {
        const version = Number((this.db.prepare('PRAGMA user_version').get() as {user_version: number}).user_version);
        if (version > 2) throw new AppError('SCHEMA_TOO_NEW', 'Database schema is newer than this server', 500);
        if (version === 0) this.db.exec(`
          CREATE TABLE agents(id TEXT PRIMARY KEY, name TEXT NOT NULL, lastSeenAt TEXT NOT NULL);
          CREATE TABLE tasks(id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, acceptanceCriteria TEXT NOT NULL, status TEXT NOT NULL, assignee TEXT REFERENCES agents(id), version INTEGER NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
          CREATE TABLE resources(id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, description TEXT NOT NULL, capabilities TEXT NOT NULL, accessNotes TEXT NOT NULL, version INTEGER NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
          CREATE TABLE usages(id TEXT PRIMARY KEY, resourceId TEXT NOT NULL REFERENCES resources(id), agentId TEXT NOT NULL REFERENCES agents(id), purpose TEXT NOT NULL, scope TEXT NOT NULL, sharing TEXT NOT NULL, taskId TEXT REFERENCES tasks(id), active INTEGER NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
          CREATE TABLE entries(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, agentId TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT NOT NULL, taskId TEXT REFERENCES tasks(id), resourceId TEXT REFERENCES resources(id), recipientId TEXT REFERENCES agents(id), createdAt TEXT NOT NULL);
          CREATE INDEX entries_scope ON entries(taskId, resourceId, id);
          CREATE INDEX usages_resource ON usages(resourceId, active);
          CREATE TRIGGER entries_no_update BEFORE UPDATE ON entries BEGIN SELECT RAISE(ABORT, 'entries are append-only'); END;
          CREATE TRIGGER entries_no_delete BEFORE DELETE ON entries BEGIN SELECT RAISE(ABORT, 'entries are append-only'); END;
          PRAGMA user_version = 1;
        `);
        if (version < 2) this.db.exec('ALTER TABLE usages ADD COLUMN version INTEGER NOT NULL DEFAULT 1; PRAGMA user_version = 2;');
      });
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private get<T>(table: 'tasks'|'resources'|'agents'|'usages', entityId: string): T {
    parse(id, entityId);
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(entityId);
    if (!row) throw new AppError('NOT_FOUND', `${table} item not found`, 404);
    return this.decode(table, row) as T;
  }
  private decode(table: string, row: Record<string, unknown>) {
    const result = { ...row };
    if (table === 'resources') result.capabilities = JSON.parse(String(result.capabilities));
    if (table === 'usages') result.active = Boolean(result.active);
    for (const key of ['taskId', 'resourceId', 'recipientId']) if (result[key] === null) delete result[key];
    return result;
  }
  private list<T>(table: 'tasks'|'resources'|'agents'|'usages'): T[] {
    return this.db.prepare(`SELECT * FROM ${table} ORDER BY ${table === 'agents' ? 'lastSeenAt' : 'createdAt'} DESC, id`).all().map(row => this.decode(table, row) as T);
  }
  private append(input: Omit<Entry, 'id'|'createdAt'>): Entry {
    const now = new Date().toISOString();
    const result = this.db.prepare('INSERT INTO entries(kind,agentId,summary,detail,taskId,resourceId,recipientId,createdAt) VALUES(?,?,?,?,?,?,?,?)').run(input.kind,input.agentId,input.summary,input.detail,input.taskId ?? null,input.resourceId ?? null,input.recipientId ?? null,now);
    return { ...input, id: Number(result.lastInsertRowid), createdAt: now };
  }
  private agent(agentId: string) { return this.get<Agent>('agents', agentId); }
  private checkVersion(actual: number, expected: number) { if (actual !== expected) throw new AppError('VERSION_CONFLICT', 'State changed; read the latest version before retrying', 409); }
  private touch(agentId: string) { this.db.prepare('UPDATE agents SET lastSeenAt = ? WHERE id = ?').run(new Date().toISOString(), agentId); }
  board() {
    return this.transaction(() => ({ tasks: this.list<Task>('tasks'), resources: this.list<Resource>('resources'), usages: this.list<Usage>('usages'), agents: this.list<Agent>('agents'), entries: this.db.prepare('SELECT * FROM (SELECT * FROM entries ORDER BY id DESC LIMIT 100) ORDER BY id').all().map(row => this.decode('entries', row) as unknown as Entry), cursor: Number((this.db.prepare('SELECT COALESCE(MAX(id),0) AS cursor FROM entries').get() as {cursor:number}).cursor) }));
  }
  createTask(input: unknown): Task {
    const { agentId, ...data } = parse(schemas.taskCreate, input);
    return this.transaction(() => {
      if (agentId) this.agent(agentId);
      const now = new Date().toISOString(); const task: Task = { ...data, id: randomUUID(), status: 'todo', assignee: null, version: 1, createdAt: now, updatedAt: now };
      this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?)').run(task.id,task.title,task.description,task.acceptanceCriteria,task.status,null,1,now,now);
      this.append({kind:'OBSERVED',agentId:agentId ?? 'human',summary:`Task created: ${task.title}`,detail:'',taskId:task.id});
      if (agentId) this.touch(agentId); return task;
    });
  }
  updateTask(taskId: string, input: unknown): Task {
    const data = parse(schemas.taskUpdate,input);
    return this.transaction(() => {
      const before = this.get<Task>('tasks', taskId); this.checkVersion(before.version, data.expectedVersion);
      if (data.agentId) { this.agent(data.agentId); if (before.assignee !== data.agentId) throw new AppError('NOT_OWNER','Only the task owner may update this task as an agent',403); }
      const { expectedVersion: _version, agentId, ...patch } = data; void _version;
      for (const key of Object.keys(patch) as (keyof typeof patch)[]) if (patch[key] === undefined) delete patch[key];
      if (!Object.keys(patch).length) throw new AppError('VALIDATION_ERROR','Provide at least one task field');
      const next = { ...before, ...patch, assignee: patch.status === 'todo' ? null : before.assignee, version: before.version + 1, updatedAt: new Date().toISOString() };
      this.db.prepare('UPDATE tasks SET title=?,description=?,acceptanceCriteria=?,status=?,assignee=?,version=?,updatedAt=? WHERE id=?').run(next.title,next.description,next.acceptanceCriteria,next.status,next.assignee,next.version,next.updatedAt,taskId);
      this.append({kind:'OBSERVED',agentId:agentId ?? 'human',summary:`Task updated: ${next.title} (${next.status})`,detail:JSON.stringify(patch),taskId});
      if (agentId) this.touch(agentId); return next;
    });
  }
  createResource(input: unknown): Resource {
    const { agentId, ...data } = parse(schemas.resourceCreate,input);
    return this.transaction(() => {
      if (agentId) this.agent(agentId);
      const now = new Date().toISOString(); const resource = { ...data, id: randomUUID(), version: 1, createdAt: now, updatedAt: now };
      this.db.prepare('INSERT INTO resources VALUES(?,?,?,?,?,?,?,?,?)').run(resource.id,resource.name,resource.kind,resource.description,JSON.stringify(resource.capabilities),resource.accessNotes,1,now,now);
      this.append({kind:'OBSERVED',agentId:agentId ?? 'human',summary:`Resource added: ${resource.name}`,detail:'',resourceId:resource.id});
      if (agentId) this.touch(agentId); return resource;
    });
  }
  updateResource(resourceId: string,input: unknown): Resource {
    const data = parse(schemas.resourceUpdate,input);
    return this.transaction(() => {
      const before = this.get<Resource>('resources',resourceId); this.checkVersion(before.version,data.expectedVersion);
      const {expectedVersion: _version,agentId,...patch} = data; void _version;
      if (agentId) this.agent(agentId);
      for (const key of Object.keys(patch) as (keyof typeof patch)[]) if (patch[key] === undefined) delete patch[key];
      if (!Object.keys(patch).length) throw new AppError('VALIDATION_ERROR','Provide at least one resource field');
      const next = {...before,...patch,version:before.version+1,updatedAt:new Date().toISOString()};
      this.db.prepare('UPDATE resources SET name=?,kind=?,description=?,capabilities=?,accessNotes=?,version=?,updatedAt=? WHERE id=?').run(next.name,next.kind,next.description,JSON.stringify(next.capabilities),next.accessNotes,next.version,next.updatedAt,resourceId);
      this.append({kind:'OBSERVED',agentId:agentId ?? 'human',summary:`Resource updated: ${next.name}`,detail:JSON.stringify(patch),resourceId}); if (agentId) this.touch(agentId); return next;
    });
  }
  registerAgent(input: unknown): Agent {
    const data = parse(schemas.agent,input);
    return this.transaction(() => {
      const agentId = data.agentId ?? randomUUID();
      if (agentId === 'human') throw new AppError('VALIDATION_ERROR','The human identity is reserved');
      if (this.db.prepare('SELECT id FROM agents WHERE id=?').get(agentId)) throw new AppError('AGENT_EXISTS','Agent identity already exists; use heartbeat to resume it',409);
      const agent = {id:agentId,name:data.name,lastSeenAt:new Date().toISOString()};
      this.db.prepare('INSERT INTO agents VALUES(?,?,?)').run(agent.id,agent.name,agent.lastSeenAt);
      this.append({kind:'OBSERVED',agentId:agent.id,summary:`Agent joined: ${agent.name}`,detail:''}); return agent;
    });
  }
  heartbeat(agentId: string): Agent { this.agent(agentId); this.touch(agentId); return this.get<Agent>('agents',agentId); }
  claimTask(taskId: string,input: unknown): Task {
    const data = parse(schemas.claim,input);
    return this.transaction(() => {
      this.agent(data.agentId); const task = this.get<Task>('tasks',taskId); this.checkVersion(task.version,data.expectedVersion);
      if (task.assignee || !['todo','blocked'].includes(task.status)) throw new AppError('TASK_UNAVAILABLE','Task is already claimed or is not available for claiming',409);
      const next: Task = {...task,assignee:data.agentId,status:'in_progress',version:task.version+1,updatedAt:new Date().toISOString()};
      this.db.prepare('UPDATE tasks SET assignee=?,status=?,version=?,updatedAt=? WHERE id=?').run(next.assignee,next.status,next.version,next.updatedAt,taskId);
      this.append({kind:'CLAIM',agentId:data.agentId,summary:`Task claimed: ${task.title}`,detail:'',taskId}); this.touch(data.agentId); return next;
    });
  }
  releaseTask(taskId: string, input: unknown): Task {
    const data = parse(schemas.taskRelease, input);
    return this.transaction(() => {
      this.agent(data.agentId);
      const before = this.get<Task>('tasks', taskId);
      this.checkVersion(before.version, data.expectedVersion);
      if (before.assignee !== data.agentId) throw new AppError('NOT_OWNER', 'Only the task owner may release this task', 403);
      if (['done', 'canceled'].includes(before.status)) throw new AppError('TASK_UNAVAILABLE', 'Completed or canceled tasks cannot be returned to the queue', 409);
      const next: Task = { ...before, assignee: null, status: data.status, version: before.version + 1, updatedAt: new Date().toISOString() };
      this.db.prepare('UPDATE tasks SET assignee=NULL,status=?,version=?,updatedAt=? WHERE id=?').run(next.status, next.version, next.updatedAt, taskId);
      this.append({ kind: 'OBSERVED', agentId: data.agentId, summary: `Task released: ${before.title} (${next.status})`, detail: '', taskId });
      this.touch(data.agentId);
      return next;
    });
  }
  publishEntry(input: unknown): Entry {
    const data = parse(schemas.entry,input);
    return this.transaction(() => {
      this.agent(data.agentId); if (data.taskId) this.get('tasks',data.taskId); if (data.resourceId) this.get('resources',data.resourceId); if (data.recipientId) this.agent(data.recipientId);
      const entry = this.append(data); this.touch(data.agentId); return entry;
    });
  }
  readEntries(input: unknown = {}) {
    const query = parse(schemas.context,input);
    return this.transaction(() => {
    const clauses = ['id > ?']; const values: (string|number)[] = [query.after];
    for (const key of ['kind','agentId','taskId','resourceId'] as const) if (query[key] !== undefined) {clauses.push(`${key} = ?`);values.push(query[key]);}
    const rows = this.db.prepare(`SELECT * FROM entries WHERE ${clauses.join(' AND ')} ORDER BY id LIMIT ?`).all(...values,query.limit+1);
    const hasMore = rows.length > query.limit; const items = rows.slice(0,query.limit).map(row => this.decode('entries',row) as unknown as Entry);
    const max = Number((this.db.prepare('SELECT COALESCE(MAX(id),0) AS cursor FROM entries').get() as {cursor:number}).cursor);
    return {items,cursor:hasMore ? items[items.length-1]!.id : Math.max(query.after,max),hasMore};
    });
  }
  declareUsage(input: unknown): Usage {
    const data = parse(schemas.usage,input);
    return this.transaction(() => {
      this.agent(data.agentId); this.get('resources',data.resourceId); if (data.taskId) this.get('tasks',data.taskId);
      const now = new Date().toISOString(); const usage: Usage = {...data,id:randomUUID(),active:true,version:1,createdAt:now,updatedAt:now};
      this.db.prepare('INSERT INTO usages(id,resourceId,agentId,purpose,scope,sharing,taskId,active,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?)').run(usage.id,usage.resourceId,usage.agentId,usage.purpose,usage.scope,usage.sharing,usage.taskId ?? null,1,now,now);
      this.append({kind:'CLAIM',agentId:data.agentId,summary:`Resource use declared: ${data.purpose}`,detail:JSON.stringify({scope:data.scope,sharing:data.sharing}),resourceId:data.resourceId,...(data.taskId ? {taskId:data.taskId} : {})}); this.touch(data.agentId); return usage;
    });
  }
  updateUsage(usageId: string,input: unknown): Usage {
    const data = parse(schemas.usageUpdate,input);
    return this.transaction(() => {
      const before = this.get<Usage>('usages',usageId); this.agent(data.agentId);
      if (before.agentId !== data.agentId) throw new AppError('NOT_OWNER','Only the declaration owner may change resource use',403);
      this.checkVersion(before.version, data.expectedVersion);
      if (!before.active) throw new AppError('USAGE_RELEASED','Resource use declaration has been released',409);
      const {agentId,expectedVersion: _version,...patch} = data; void _version;
      for (const key of Object.keys(patch) as (keyof typeof patch)[]) if (patch[key] === undefined) delete patch[key];
      if (!Object.keys(patch).length) throw new AppError('VALIDATION_ERROR','Provide at least one usage field');
      const next = {...before,...patch,version:before.version+1,updatedAt:new Date().toISOString()};
      this.db.prepare('UPDATE usages SET purpose=?,scope=?,sharing=?,version=?,updatedAt=? WHERE id=?').run(next.purpose,next.scope,next.sharing,next.version,next.updatedAt,usageId);
      this.append({kind:'OBSERVED',agentId,summary:`Resource use updated: ${next.purpose}`,detail:JSON.stringify(patch),resourceId:next.resourceId,...(next.taskId ? {taskId:next.taskId} : {})}); this.touch(agentId); return next;
    });
  }
  releaseUsage(usageId: string,input: unknown): Usage {
    const data = parse(schemas.release,input);
    return this.transaction(() => {
      this.agent(data.agentId); const before = this.get<Usage>('usages',usageId);
      if (before.agentId !== data.agentId) throw new AppError('NOT_OWNER','Only the declaration owner may release resource use',403);
      this.checkVersion(before.version, data.expectedVersion);
      if (!before.active) return before;
      const next = {...before,active:false,version:before.version+1,updatedAt:new Date().toISOString()};
      this.db.prepare('UPDATE usages SET active=0,version=?,updatedAt=? WHERE id=?').run(next.version,next.updatedAt,usageId);
      this.append({kind:'OBSERVED',agentId:data.agentId,summary:`Resource use released: ${before.purpose}`,detail:'',resourceId:before.resourceId,...(before.taskId ? {taskId:before.taskId} : {})}); this.touch(data.agentId); return next;
    });
  }
}
