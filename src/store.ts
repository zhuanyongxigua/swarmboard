import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { automationSchemas, buildSetupPrompt, canonicalWorkspace, defaultAutomationConfig, type AutomationConfig } from './automation.js';
import type { OverviewRecord } from './overview.js';
import type { StoredStatusFact } from './overview-status-facts.js';

export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
const text = z.string().trim().min(1).max(500);
const longText = z.string().max(20000);
const optionalText = longText.default('');
const id = z.string().trim().min(1).max(128);
export const taskStatuses = ['todo', 'in_progress', 'in_review', 'done', 'blocked', 'canceled'] as const;
export const entryKinds = ['OBSERVED', 'FACT', 'FAIL', 'CLAIM', 'PATCH_SUMMARY', 'MESSAGE'] as const;
export const preferenceSources = ['human-input', 'main-chat-relay'] as const;
const progressInput = z.object({
  percent: z.number().min(0).max(100).nullable(), state: z.enum(['active', 'waiting', 'unknown']),
  phase: z.string().trim().max(200), verified: z.string().max(4000), remaining: z.string().max(4000),
}).strict().refine(value => value.state === 'unknown' ? value.percent === null : value.percent !== null && !!value.phase.trim() && !!value.verified.trim(), { message: 'Known progress needs a percentage, phase and verified basis; unknown progress must have no percentage' });
const taskFields = { title: text, description: optionalText, acceptanceCriteria: optionalText };
// Retain the legacy kind column/API field without requiring resource classification.
const legacyResourceKind = z.string().trim().max(500);
const resourceFields = { name: text, kind: legacyResourceKind.default(''), description: optionalText, capabilities: z.array(text).max(50).default([]), accessNotes: optionalText };
export const schemas = {
  preferencesUpdate: z.object({ text: longText, source: z.enum(preferenceSources), expectedVersion: z.number().int().nonnegative() }).strict(),
  taskProgressUpdate: z.object({ expectedVersion: z.number().int().positive(), progress: progressInput.nullable(), agentId: id.optional() }).strict(),
  taskCreate: z.object({ ...taskFields, agentId: id.optional() }).strict(),
  taskUpdate: z.object({ expectedVersion: z.number().int().positive(), title: text.optional(), description: longText.optional(), acceptanceCriteria: longText.optional(), status: z.enum(taskStatuses).optional(), agentId: id.optional() }).strict(),
  taskList: z.object({ after: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(20), statuses: z.array(z.enum(taskStatuses)).min(1).max(6).default(['todo', 'in_progress', 'in_review', 'blocked']), query: z.string().trim().min(1).max(500).optional() }).strict(),
  taskRead: z.object({ id, offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(8000).default(4000), expectedVersion: z.number().int().positive().optional() }).strict(),
  resourceCreate: z.object({ ...resourceFields, agentId: id.optional() }).strict(),
  resourceUpdate: z.object({ expectedVersion: z.number().int().positive(), name: text.optional(), kind: legacyResourceKind.optional(), description: longText.optional(), capabilities: z.array(text).max(50).optional(), accessNotes: longText.optional(), agentId: id.optional() }).strict(),
  agent: z.object({ name: text, agentId: id.optional() }).strict(),
  claim: z.object({ agentId: id, expectedVersion: z.number().int().positive() }).strict(),
  taskRelease: z.object({ agentId: id, expectedVersion: z.number().int().positive(), status: z.enum(['todo', 'blocked']).default('todo') }).strict(),
  entry: z.object({ agentId: id, kind: z.enum(entryKinds), summary: text, detail: optionalText, taskId: id.optional(), resourceId: id.optional(), recipientId: id.optional() }).strict(),
  context: z.object({ after: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(200).default(50), kind: z.enum(entryKinds).optional(), agentId: id.optional(), taskId: id.optional(), resourceId: id.optional(), query: z.string().trim().min(1).max(500).optional() }).strict(),
  usage: z.object({ resourceId: id, agentId: id, purpose: text, scope: optionalText, sharing: optionalText, taskId: id.optional() }).strict(),
  usageUpdate: z.object({ agentId: id, expectedVersion: z.number().int().positive(), purpose: text.optional(), scope: longText.optional(), sharing: longText.optional() }).strict(),
  release: z.object({ agentId: id, expectedVersion: z.number().int().positive() }).strict(),
};
export interface TaskProgress extends z.infer<typeof progressInput> { updatedAt: string; reportedBy: string }
export interface Task { id: string; title: string; description: string; acceptanceCriteria: string; status: typeof taskStatuses[number]; assignee: string | null; participants: string[]; progress: TaskProgress | null; version: number; createdAt: string; updatedAt: string }
export type TaskSummary = Omit<Task, 'description' | 'acceptanceCriteria' | 'progress'> & { progress: Omit<TaskProgress, 'verified' | 'remaining'> | null };
export interface Resource { id: string; name: string; kind: string; description: string; capabilities: string[]; accessNotes: string; version: number; createdAt: string; updatedAt: string }
export interface Agent { id: string; name: string; lastSeenAt: string }
export interface Preferences { boardId: string; text: string; source: typeof preferenceSources[number] | null; version: number; updatedAt: string | null }
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
        if (version > 10) throw new AppError('SCHEMA_TOO_NEW', 'Database schema is newer than this server', 500);
        // Standalone review candidates reused v6; only the declared release sequence may upgrade.
        if (version >= 6) {
          const features = ['board_preferences', 'task_progress', 'resource_admission_fences', 'board_overview'];
          for (const [index, table] of features.entries()) {
            const exists = !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
            if (exists !== (version >= index + 6)) throw new AppError('SCHEMA_VARIANT_MISMATCH', 'Database belongs to an incompatible unpublished schema candidate; restore its matching backup before upgrading', 500);
          }
        }
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
        if (version < 3) this.db.exec("CREATE TABLE IF NOT EXISTS automation_config(id INTEGER PRIMARY KEY CHECK(id=1), config TEXT NOT NULL); CREATE TABLE IF NOT EXISTS automation_bindings(taskId TEXT PRIMARY KEY REFERENCES tasks(id),agentId TEXT NOT NULL REFERENCES agents(id),threadId TEXT NOT NULL,automationId TEXT NOT NULL,automationVersion INTEGER NOT NULL,createdAt TEXT NOT NULL); PRAGMA user_version = 3;");
        this.db.prepare('INSERT OR IGNORE INTO automation_config(id,config) VALUES(1,?)').run(JSON.stringify({ ...defaultAutomationConfig, boardId: randomUUID() }));
        if (version < 4) {
          const config = this.readAutomation();
          if (config.state === 'off' && !config.desiredEnabled) this.saveAutomation({ ...config, desiredEnabled: true, version: config.version + 1, updatedAt: new Date().toISOString() });
          this.db.exec('PRAGMA user_version = 4;');
        }
        if (version < 5) {
          this.db.exec(`CREATE TABLE task_participants(taskId TEXT NOT NULL REFERENCES tasks(id),agentId TEXT NOT NULL REFERENCES agents(id),active INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(taskId,agentId));
            INSERT INTO task_participants(taskId,agentId) SELECT id,assignee FROM tasks WHERE assignee IS NOT NULL;
            UPDATE tasks SET assignee=NULL WHERE assignee IS NOT NULL;
            PRAGMA user_version=5;`);
        }
        if (version < 6) this.db.exec(`
          CREATE TABLE board_preferences(id INTEGER PRIMARY KEY CHECK(id=1), text TEXT NOT NULL, source TEXT CHECK(source IN ('human-input','main-chat-relay')), version INTEGER NOT NULL CHECK(version>=0), updatedAt TEXT);
          INSERT INTO board_preferences VALUES(1,'',NULL,0,NULL);
          PRAGMA user_version=6;
        `);
        if (version < 7) this.db.exec('CREATE TABLE task_progress(taskId TEXT PRIMARY KEY REFERENCES tasks(id),data TEXT NOT NULL); PRAGMA user_version=7;');
        if (version < 8) this.db.exec(`
          CREATE TABLE resource_admission_fences(agentId TEXT PRIMARY KEY REFERENCES agents(id));
          CREATE TRIGGER usage_admission_insert BEFORE INSERT ON usages
            WHEN NEW.active=1 AND EXISTS(SELECT 1 FROM resource_admission_fences WHERE agentId=NEW.agentId)
            BEGIN SELECT RAISE(ABORT, 'Member resource admission is closed'); END;
          CREATE TRIGGER usage_admission_update BEFORE UPDATE OF agentId,active ON usages
            WHEN NEW.active=1 AND EXISTS(SELECT 1 FROM resource_admission_fences WHERE agentId=NEW.agentId)
            BEGIN SELECT RAISE(ABORT, 'Member resource admission is closed'); END;
          PRAGMA user_version=8;
        `);
        if (version < 9) this.db.exec('CREATE TABLE board_overview(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL); PRAGMA user_version=9;');
        if (version < 10) this.db.exec('CREATE TABLE overview_status_facts(member_id TEXT PRIMARY KEY,data TEXT NOT NULL); PRAGMA user_version=10;');
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
    if (table === 'tasks') result.participants = this.db.prepare('SELECT agentId FROM task_participants WHERE taskId=? AND active=1 ORDER BY agentId').all(String(result.id)).map(r => String(r.agentId));
    if (table === 'tasks') {
      const progress = this.db.prepare('SELECT data FROM task_progress WHERE taskId=?').get(String(result.id)) as { data: string } | undefined;
      result.progress = progress ? JSON.parse(progress.data) as TaskProgress : null;
    }
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
    return this.transaction(() => ({ preferences: this.readPreferences(), tasks: this.list<Task>('tasks'), resources: this.list<Resource>('resources'), usages: this.list<Usage>('usages'), agents: this.list<Agent>('agents'), entries: this.db.prepare('SELECT * FROM (SELECT * FROM entries ORDER BY id DESC LIMIT 100) ORDER BY id').all().map(row => this.decode('entries', row) as unknown as Entry), cursor: Number((this.db.prepare('SELECT COALESCE(MAX(id),0) AS cursor FROM entries').get() as {cursor:number}).cursor) }));
  }
  readTask(taskId: string): Task { return this.get<Task>('tasks', taskId); }
  // Runtime lifecycle checks need states, never full human requirements or context.
  taskStates() { return this.db.prepare('SELECT id,status,version,assignee FROM tasks ORDER BY id').all() as unknown as Pick<Task, 'id' | 'status' | 'version' | 'assignee'>[]; }
  readTasks(input: unknown = {}, subscribedIds: string[] = []) {
    return this.transaction(() => this.taskPage(input, subscribedIds));
  }
  private taskPage(input: unknown, subscribedIds: string[]) {
    const query = parse(schemas.taskList, input);
    // Task rows are never deleted/reinserted. Their insertion ordinal is stable
    // across edits and tied/backward wall clocks; UUID/time ordering is not.
    const clauses = [`rowid > ?`, `status IN (${query.statuses.map(() => '?').join(',')})`];
    const values: (string | number)[] = [query.after, ...query.statuses];
    if (query.query) { clauses.push("instr(lower(title || char(10) || description || char(10) || acceptanceCriteria), lower(?)) > 0"); values.push(query.query); }
    if (subscribedIds.length) { clauses.push(`id IN (${subscribedIds.map(() => '?').join(',')})`); values.push(...subscribedIds); }
    const rows = this.db.prepare(`SELECT rowid AS discoveryCursor,id,title,status,assignee,version,createdAt,updatedAt FROM tasks WHERE ${clauses.join(' AND ')} ORDER BY rowid LIMIT ?`).all(...values, query.limit + 1);
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit).map(({ discoveryCursor: _, ...row }) => {
      const task = this.decode('tasks', row) as unknown as Task;
      const { verified: _verified, remaining: _remaining, ...compact } = task.progress ?? {};
      void _verified; void _remaining;
      return { ...task, progress: task.progress ? compact as Omit<TaskProgress, 'verified' | 'remaining'> : null } as TaskSummary;
    });
    return { items, hasMore, cursor: items.length ? Number(rows[items.length - 1]!.discoveryCursor) : query.after };
  }
  readTaskPage(input: unknown) {
    const query = parse(schemas.taskRead, input), task = this.readTask(query.id);
    if (query.expectedVersion !== undefined) this.checkVersion(task.version, query.expectedVersion);
    const end = query.offset + query.limit;
    return { ...task, description: task.description.slice(query.offset, end), acceptanceCriteria: task.acceptanceCriteria.slice(query.offset, end),
      textPage: { offset: query.offset, nextOffset: end, hasMore: task.description.length > end || task.acceptanceCriteria.length > end } };
  }
  // Shared-history visibility for an admitted reader: entries linked to goals
  // outside the admitted set stay unreadable, and direct messages addressed to
  // someone else are withheld the same way the runtime's update attachments
  // withhold them. Unlinked board notices stay visible.
  static historyScopeClause(scope: { taskIds?: string[]; recipientId?: string }): { clause: string; values: (string | number)[] } | undefined {
    if (!scope.taskIds?.length && !scope.recipientId) return undefined;
    const clauses: string[] = []; const values: (string | number)[] = [];
    if (scope.taskIds?.length) { clauses.push(`(taskId IS NULL OR taskId IN (${scope.taskIds.map(() => '?').join(',')}))`); values.push(...scope.taskIds); }
    if (scope.recipientId) { clauses.push('(recipientId IS NULL OR recipientId = ?)'); values.push(scope.recipientId); }
    return { clause: clauses.join(' AND '), values };
  }
  peerBoard(subscribedIds: string[] = [], history?: { taskIds?: string[]; recipientId?: string }) {
    return this.transaction(() => {
      const page = this.taskPage({}, subscribedIds);
      const visibility = Store.historyScopeClause(history ?? {});
      return { preferences: this.readPreferences(), tasks: page.items, taskPage: { cursor: page.cursor, hasMore: page.hasMore },
        resources: this.list<Resource>('resources'), usages: this.list<Usage>('usages'), agents: this.list<Agent>('agents'),
        entries: this.db.prepare(`SELECT id,kind,agentId,summary,substr(detail,1,1000) AS detail,length(detail)>1000 AS detailTruncated,taskId,resourceId,recipientId,createdAt FROM (SELECT * FROM entries ${visibility ? 'WHERE ' + visibility.clause : ''} ORDER BY id DESC LIMIT 20) ORDER BY id`).all(...(visibility?.values ?? [])).map(row => this.decode('entries', row)),
        cursor: Number((this.db.prepare('SELECT COALESCE(MAX(id),0) AS cursor FROM entries').get() as {cursor:number}).cursor) };
    });
  }
  readAutomation(): AutomationConfig {
    const row = this.db.prepare('SELECT config FROM automation_config WHERE id=1').get() as { config: string } | undefined;
    return row ? JSON.parse(row.config) as AutomationConfig : { ...defaultAutomationConfig };
  }
  readPreferences(): Preferences {
    const row = this.db.prepare('SELECT text,source,version,updatedAt FROM board_preferences WHERE id=1').get() as unknown as Omit<Preferences, 'boardId'>;
    return { ...row, boardId: this.readAutomation().boardId };
  }
  readOverviewRecord(): OverviewRecord | null {
    const row = this.db.prepare('SELECT data FROM board_overview WHERE id=1').get();
    return row ? JSON.parse(String(row.data)) as OverviewRecord : null;
  }
  // Formal transports bind the author and validate facts. No board event is
  // emitted for decoration: readers observe the durable CAS value directly.
  saveOverviewRecord(record: Omit<OverviewRecord, 'version'>, expectedVersion: number): OverviewRecord {
    return this.transaction(() => {
      this.checkVersion(this.readOverviewRecord()?.version ?? 0, expectedVersion);
      if (this.readPreferences().version !== record.preferencesVersion) throw new AppError('OVERVIEW_PREFERENCES_CHANGED', 'Preferences changed; read current preferences again', 409);
      const next = { ...record, version: expectedVersion + 1 };
      this.db.prepare('INSERT INTO board_overview VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(next));
      return next;
    });
  }
  // Self-registered seat status facts. One row per member identity: the
  // harness label is updatable metadata inside the envelope, so a re-registered
  // member replaces its row and duplicate identities can never count twice.
  // Expired rows are kept so stale groups surface as last-recorded, not zero.
  readOverviewStatusFacts(): StoredStatusFact[] {
    const rows = this.db.prepare('SELECT data FROM overview_status_facts ORDER BY member_id').all() as { data: string }[];
    return rows.map(row => JSON.parse(row.data) as StoredStatusFact);
  }
  readOverviewStatusFact(memberId: string): StoredStatusFact | null {
    const row = this.db.prepare('SELECT data FROM overview_status_facts WHERE member_id=?').get(memberId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as StoredStatusFact : null;
  }
  saveOverviewStatusFact(fact: StoredStatusFact): void {
    this.db.prepare('INSERT INTO overview_status_facts VALUES(?,?) ON CONFLICT(member_id) DO UPDATE SET data=excluded.data').run(fact.memberId, JSON.stringify(fact));
  }
  // Trusted human-host boundary only: do not expose this mutator to bound agents.
  // Source records declared provenance; it is never an authorization credential.
  writePreferences(input: unknown): Preferences {
    const data = parse(schemas.preferencesUpdate, input);
    return this.transaction(() => {
      const before = this.readPreferences(); this.checkVersion(before.version, data.expectedVersion);
      const next = { ...before, text: data.text, source: data.source, version: before.version + 1, updatedAt: new Date().toISOString() };
      // Keep a versioned empty row when clearing so stale drafts cannot resurrect it.
      this.db.prepare('UPDATE board_preferences SET text=?,source=?,version=?,updatedAt=? WHERE id=1 AND version=?').run(next.text,next.source,next.version,next.updatedAt,before.version);
      this.append({ kind: 'OBSERVED', agentId: 'host-preferences', summary: 'Personal preferences updated', detail: JSON.stringify({ signalId: 'BOARD_PREFERENCES_UPDATED', version: next.version, source: next.source, cleared: next.text === '' }) });
      return next;
    });
  }
  private saveAutomation(config: AutomationConfig): AutomationConfig {
    this.db.prepare('INSERT INTO automation_config(id,config) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config').run(JSON.stringify(config));
    return config;
  }
  private prepareAutomationLocked(data: z.infer<typeof automationSchemas.prepare>): AutomationConfig {
    const before = this.readAutomation();
    this.checkVersion(before.version, data.expectedVersion);
    const recovery = data.action === 'reconcile' || before.state === 'pending' || before.recoveryRequired;
    if (recovery) return this.saveAutomation({ ...before, version: before.version + 1, state: 'pending', setupMode: 'reconcile', recoveryRequired: true, requestId: randomUUID(), lastError: '', updatedAt: new Date().toISOString() });
    if (data.action === 'pause' && !before.automationId) throw new AppError('AUTOMATION_NOT_CONFIGURED', 'No native automation has been confirmed; inspect any pending setup before retrying', 409);
    let workspacePath = before.workspacePath;
    if (data.action === 'enable' && (data.workspacePath ?? before.workspacePath)) {
      try { workspacePath = canonicalWorkspace(data.workspacePath ?? before.workspacePath); }
      catch { throw new AppError('INVALID_WORKSPACE', 'Select an existing absolute workspace directory'); }
    }
    return this.saveAutomation({ ...before, version: before.version + 1, state: 'pending', setupMode: 'configure', recoveryRequired: false, desiredEnabled: data.action === 'enable', workspacePath, intervalMinutes: data.action === 'enable' ? data.intervalMinutes ?? before.intervalMinutes : before.intervalMinutes, requestId: randomUUID(), lastError: '', updatedAt: new Date().toISOString() });
  }
  prepareAutomation(input: unknown): AutomationConfig {
    const data = parse(automationSchemas.prepare, input);
    return this.transaction(() => this.prepareAutomationLocked(data));
  }
  ensureAutomation(input: unknown = {}) {
    const { retry } = parse(automationSchemas.ensure, input);
    return this.transaction(() => {
      const before = this.readAutomation();
      if (before.state === 'active' || !before.desiredEnabled || (!retry && (before.state === 'pending' || before.state === 'error'))) return { config: before, setupPrompt: null };
      const config = this.prepareAutomationLocked({ action: before.recoveryRequired || before.state === 'pending' ? 'reconcile' : 'enable', expectedVersion: before.version });
      return { config, setupPrompt: buildSetupPrompt(config) };
    });
  }
  confirmAutomation(input: unknown): AutomationConfig {
    const data = parse(automationSchemas.confirm, input);
    return this.transaction(() => {
      const before = this.readAutomation();
      this.checkVersion(before.version, data.expectedVersion);
      if (before.state !== 'pending' || before.requestId !== data.requestId || before.setupMode !== 'configure' || before.recoveryRequired) throw new AppError('AUTOMATION_REQUEST_CONFLICT', 'Setup request is no longer pending or requires recovery', 409);
      if (!before.workspacePath && data.projectId !== null) throw new AppError('AUTOMATION_PROJECT_MISMATCH', 'The board-global native schedule must use projectId=null', 409);
      if (data.status !== (before.desiredEnabled ? 'ACTIVE' : 'PAUSED')) throw new AppError('AUTOMATION_STATUS_MISMATCH', 'Native status does not match the requested action', 409);
      if (before.automationId && before.automationId !== data.automationId) throw new AppError('AUTOMATION_ID_MISMATCH', 'Update the existing native automation; do not create a duplicate', 409);
      return this.saveAutomation({ ...before, version: before.version + 1, state: data.status === 'ACTIVE' ? 'active' : 'off', automationId: data.automationId, actualStatus: data.status, model: data.model, reasoningEffort: data.reasoningEffort, projectId: data.projectId, setupMode: null, recoveryRequired: false, requestId: null, lastError: '', updatedAt: new Date().toISOString() });
    });
  }
  failAutomationSetup(input: unknown): AutomationConfig {
    const data = parse(automationSchemas.failed, input);
    return this.transaction(() => {
      const before = this.readAutomation();
      this.checkVersion(before.version, data.expectedVersion);
      if (before.state !== 'pending' || before.requestId !== data.requestId) throw new AppError('AUTOMATION_REQUEST_CONFLICT', 'Setup request is no longer pending', 409);
      return this.saveAutomation({ ...before, version: before.version + 1, state: 'error', setupMode: null, recoveryRequired: before.recoveryRequired || data.nativeOutcome === 'unknown', requestId: null, lastError: data.error, updatedAt: new Date().toISOString() });
    });
  }
  reconcileAutomation(input: unknown): AutomationConfig {
    const data = parse(automationSchemas.reconcile, input);
    return this.transaction(() => {
      const before = this.readAutomation();
      this.checkVersion(before.version, data.expectedVersion);
      if (before.state !== 'pending' || before.setupMode !== 'reconcile' || before.requestId !== data.requestId) throw new AppError('AUTOMATION_REQUEST_CONFLICT', 'Recovery request is no longer pending', 409);
      if (data.outcome === 'found') {
        if (!data.automationId || !data.status || !data.model || !data.reasoningEffort || data.projectId === undefined) throw new AppError('VALIDATION_ERROR', 'A found native automation requires its observed ID, status, model, reasoning effort and project');
        if (before.automationId && before.automationId !== data.automationId) throw new AppError('AUTOMATION_ID_MISMATCH', 'Reconcile the existing native automation; multiple identities need manual inspection', 409);
        return this.saveAutomation({ ...before, version: before.version + 1, state: 'off', setupMode: null, recoveryRequired: false, requestId: null, automationId: data.automationId, actualStatus: data.status, model: data.model, reasoningEffort: data.reasoningEffort, projectId: data.projectId ?? null, lastError: '', updatedAt: new Date().toISOString() });
      }
      if (data.automationId || data.status || data.model || data.reasoningEffort || Object.hasOwn(data, 'projectId')) throw new AppError('VALIDATION_ERROR', 'An absent result cannot contain native automation fields');
      return this.saveAutomation({ ...before, version: before.version + 1, state: 'off', setupMode: null, recoveryRequired: false, requestId: null, automationId: null, actualStatus: null, model: null, reasoningEffort: null, projectId: null, lastError: '', updatedAt: new Date().toISOString() });
    });
  }
  createTask(input: unknown): Task {
    const { agentId, ...data } = parse(schemas.taskCreate, input);
    return this.transaction(() => {
      if (agentId) this.agent(agentId);
      const now = new Date().toISOString(); const task: Task = { ...data, id: randomUUID(), status: 'todo', assignee: null, participants: [], progress: null, version: 1, createdAt: now, updatedAt: now };
      this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?)').run(task.id,task.title,task.description,task.acceptanceCriteria,task.status,null,1,now,now);
      // Goal creation and revision carry the actual post-write status/version
      // as semantic control metadata: any legitimately named host or participant
      // emits them generically, so wake eligibility never depends on a default
      // agentId, summary text, or a patch happening to include status.
      this.append({kind:'OBSERVED',agentId:agentId ?? 'human',summary:`Task created: ${task.title}`,detail:JSON.stringify({version:task.version,status:task.status}),taskId:task.id});
      if (agentId) this.touch(agentId); return task;
    });
  }
  updateTask(taskId: string, input: unknown): Task {
    const data = parse(schemas.taskUpdate,input);
    return this.transaction(() => {
      const before = this.get<Task>('tasks', taskId); this.checkVersion(before.version, data.expectedVersion);
      if (data.agentId) { this.agent(data.agentId); if (!before.participants.includes(data.agentId)) throw new AppError('NOT_PARTICIPANT','Only an active participant may update this shared goal as an agent',403); }
      const { expectedVersion: _version, agentId, ...patch } = data; void _version;
      for (const key of Object.keys(patch) as (keyof typeof patch)[]) if (patch[key] === undefined) delete patch[key];
      if (!Object.keys(patch).length) throw new AppError('VALIDATION_ERROR','Provide at least one task field');
      const next = { ...before, ...patch, assignee: patch.status === 'todo' ? null : before.assignee, version: before.version + 1, updatedAt: new Date().toISOString() };
      this.db.prepare('UPDATE tasks SET title=?,description=?,acceptanceCriteria=?,status=?,assignee=?,version=?,updatedAt=? WHERE id=?').run(next.title,next.description,next.acceptanceCriteria,next.status,next.assignee,next.version,next.updatedAt,taskId);
      this.append({kind:'OBSERVED',agentId:agentId ?? 'human',summary:`Task updated: ${next.title} (${next.status})`,detail:JSON.stringify({...patch,version:next.version,status:next.status}),taskId});
      if (patch.status === 'todo') this.db.prepare('UPDATE task_participants SET active=0 WHERE taskId=?').run(taskId);
      if (agentId) this.touch(agentId); return this.get<Task>('tasks', taskId);
    });
  }
  writeTaskProgress(taskId: string, input: unknown): Task {
    const data = parse(schemas.taskProgressUpdate, input);
    return this.transaction(() => {
      const before = this.readTask(taskId); this.checkVersion(before.version, data.expectedVersion);
      if (data.agentId) { this.agent(data.agentId); if (!before.participants.includes(data.agentId)) throw new AppError('NOT_PARTICIPANT', 'Only an active participant may report progress on this shared goal', 403); }
      const updatedAt = new Date().toISOString();
      const progress: TaskProgress | null = data.progress ? { ...data.progress, updatedAt, reportedBy: data.agentId ?? 'human' } : null;
      if (progress) this.db.prepare('INSERT INTO task_progress(taskId,data) VALUES(?,?) ON CONFLICT(taskId) DO UPDATE SET data=excluded.data').run(taskId, JSON.stringify(progress));
      else this.db.prepare('DELETE FROM task_progress WHERE taskId=?').run(taskId);
      // Progress is evidence-backed reporting, never a task-lifecycle transition.
      this.db.prepare('UPDATE tasks SET version=version+1,updatedAt=? WHERE id=?').run(updatedAt, taskId);
      const next = this.readTask(taskId);
      this.append({ kind: 'OBSERVED', agentId: data.agentId ?? 'human', summary: `Task progress reported: ${before.title}`, detail: JSON.stringify({ version: next.version, status: next.status, progress: progress ? { percent: progress.percent, state: progress.state, phase: progress.phase } : null }), taskId });
      if (data.agentId) this.touch(data.agentId);
      return next;
    });
  }
  createResource(input: unknown): Resource {
    const { agentId, ...data } = parse(schemas.resourceCreate,input);
    return this.transaction(() => {
      if (agentId) this.agent(agentId);
      const now = new Date().toISOString(); const resource = { ...data, id: randomUUID(), version: 1, createdAt: now, updatedAt: now };
      this.db.prepare('INSERT INTO resources VALUES(?,?,?,?,?,?,?,?,?)').run(resource.id,resource.name,resource.kind,resource.description,JSON.stringify(resource.capabilities),resource.accessNotes,1,now,now);
      this.append({kind:'OBSERVED',agentId:agentId ?? 'human',summary:`Resource added: ${resource.name}`,detail:JSON.stringify({version:resource.version}),resourceId:resource.id});
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
      this.append({kind:'OBSERVED',agentId:agentId ?? 'human',summary:`Resource updated: ${next.name}`,detail:JSON.stringify({...patch,version:next.version}),resourceId}); if (agentId) this.touch(agentId); return next;
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
  private joinGoalLocked(taskId: string, agentId: string, startBlocked: boolean): Task {
    this.agent(agentId); const before = this.get<Task>('tasks', taskId);
    if (['done','canceled'].includes(before.status)) throw new AppError('TASK_UNAVAILABLE', 'Completed or canceled goals cannot accept new work', 409);
    this.db.prepare('INSERT INTO task_participants VALUES(?,?,1) ON CONFLICT(taskId,agentId) DO UPDATE SET active=1').run(taskId,agentId);
    if (before.status === 'todo' || startBlocked && before.status === 'blocked') this.db.prepare("UPDATE tasks SET status='in_progress',assignee=NULL,version=version+1,updatedAt=? WHERE id=?").run(new Date().toISOString(),taskId);
    return this.get<Task>('tasks', taskId);
  }
  private claimTaskLocked(taskId: string, data: z.infer<typeof schemas.claim>): Task {
    this.agent(data.agentId); const before = this.get<Task>('tasks',taskId); this.checkVersion(before.version,data.expectedVersion);
    const task = this.joinGoalLocked(taskId,data.agentId,true);
    if (!before.participants.includes(data.agentId)) this.append({kind:'CLAIM',agentId:data.agentId,summary:`Joined shared goal: ${task.title}`,detail:'Participation does not reserve the goal or assign peer roles.',taskId});
    this.touch(data.agentId); return task;
  }
  claimTask(taskId: string,input: unknown): Task {
    const data = parse(schemas.claim,input);
    return this.transaction(() => this.claimTaskLocked(taskId, data));
  }
  claimAutomationTask(input: unknown) {
    const data = parse(automationSchemas.claim, input);
    return this.transaction(() => {
      const config = this.readAutomation();
      this.checkVersion(config.version, data.automationVersion);
      if (config.state !== 'active' || !config.desiredEnabled || config.actualStatus !== 'ACTIVE' || !config.automationId) throw new AppError('AUTOMATION_INACTIVE', 'Automatic claiming is not active; stop this scheduled cycle', 409);
      const currentTask = this.get<Task>('tasks', data.id);
      if (currentTask.status !== 'todo' || currentTask.participants.length) throw new AppError('TASK_UNAVAILABLE', 'Automatic workers may only claim todo tasks', 409);
      const task = this.claimTaskLocked(data.id, { agentId: data.agentId, expectedVersion: data.expectedVersion });
      this.db.prepare('UPDATE tasks SET assignee=? WHERE id=?').run(data.agentId,task.id); task.assignee = data.agentId;
      const binding = { taskId: task.id, agentId: data.agentId, threadId: data.threadId, automationId: config.automationId, automationVersion: config.version, createdAt: new Date().toISOString() };
      this.db.prepare('INSERT INTO automation_bindings(taskId,agentId,threadId,automationId,automationVersion,createdAt) VALUES(?,?,?,?,?,?) ON CONFLICT(taskId) DO UPDATE SET agentId=excluded.agentId,threadId=excluded.threadId,automationId=excluded.automationId,automationVersion=excluded.automationVersion,createdAt=excluded.createdAt').run(binding.taskId,binding.agentId,binding.threadId,binding.automationId,binding.automationVersion,binding.createdAt);
      return { task, binding };
    });
  }
  releaseTask(taskId: string, input: unknown): Task {
    const data = parse(schemas.taskRelease, input);
    return this.transaction(() => {
      this.agent(data.agentId);
      const before = this.get<Task>('tasks', taskId);
      this.checkVersion(before.version, data.expectedVersion);
      if (!before.participants.includes(data.agentId)) throw new AppError('NOT_PARTICIPANT', 'Only an active participant may leave this goal', 403);
      if (['done', 'canceled'].includes(before.status)) throw new AppError('TASK_UNAVAILABLE', 'Completed or canceled goals cannot be returned to the queue', 409);
      this.db.prepare('UPDATE task_participants SET active=0 WHERE taskId=? AND agentId=?').run(taskId,data.agentId);
      const remaining = this.get<Task>('tasks',taskId).participants;
      if (!remaining.length) this.db.prepare('UPDATE tasks SET assignee=NULL,status=?,version=version+1,updatedAt=? WHERE id=?').run(data.status,new Date().toISOString(),taskId);
      this.append({kind:'OBSERVED',agentId:data.agentId,summary:`Left shared goal: ${before.title}`,detail:JSON.stringify({remainingParticipants:remaining}),taskId});
      this.touch(data.agentId); return this.get<Task>('tasks',taskId);
    });
  }
  publishEntry(input: unknown): Entry {
    const data = parse(schemas.entry,input);
    return this.transaction(() => {
      this.agent(data.agentId); if (data.taskId) this.get('tasks',data.taskId); if (data.resourceId) this.get('resources',data.resourceId); if (data.recipientId) this.agent(data.recipientId);
      if (data.kind === 'CLAIM' && data.taskId) this.joinGoalLocked(data.taskId,data.agentId,false);
      const entry = this.append(data); this.touch(data.agentId); return entry;
    });
  }
  // Replay an internal outbox after a crash without duplicating its board event.
  // The immutable payload contains a persisted random signal identity. This is
  // deliberately not exposed as an agent MCP operation or a task write.
  publishSystemEntryOnce(input: unknown): Entry {
    const data = parse(schemas.entry, input);
    return this.transaction(() => {
      const found = this.db.prepare('SELECT * FROM entries WHERE agentId=? AND kind=? AND summary=? AND detail=? AND recipientId IS ? AND taskId IS ? ORDER BY id LIMIT 1')
        .get(data.agentId, data.kind, data.summary, data.detail, data.recipientId ?? null, data.taskId ?? null);
      if (found) return this.decode('entries', found) as unknown as Entry;
      this.agent(data.agentId); if (data.recipientId) this.agent(data.recipientId);
      return this.append(data);
    });
  }
  readEntries(input: unknown = {}, scope?: { taskIds?: string[]; recipientId?: string }) {
    const query = parse(schemas.context,input);
    return this.transaction(() => {
    const clauses = ['id > ?']; const values: (string|number)[] = [query.after];
    for (const key of ['kind','agentId','taskId','resourceId'] as const) if (query[key] !== undefined) {clauses.push(`${key} = ?`);values.push(query[key]);}
    if (query.query) { clauses.push("instr(lower(summary || char(10) || detail), lower(?)) > 0"); values.push(query.query); }
    // Applied inside the query so bounded pagination and cursors stay exact for
    // an admitted reader: out-of-scope rows are never consumed by its cursor.
    const visibility = Store.historyScopeClause(scope ?? {});
    if (visibility) { clauses.push(visibility.clause); values.push(...visibility.values); }
    const rows = this.db.prepare(`SELECT * FROM entries WHERE ${clauses.join(' AND ')} ORDER BY id LIMIT ?`).all(...values,query.limit+1);
    const hasMore = rows.length > query.limit; const items = rows.slice(0,query.limit).map(row => this.decode('entries',row) as unknown as Entry);
    const max = Number((this.db.prepare('SELECT COALESCE(MAX(id),0) AS cursor FROM entries').get() as {cursor:number}).cursor);
    return {items,cursor:hasMore ? items[items.length-1]!.id : Math.max(query.after,max),hasMore};
    });
  }
  /** Commit the admission fence before the sidecar can remove membership.
   *  Delayed writers serialize on this same board lock, including old clients
   *  whose earlier MCP permission check can no longer be withdrawn. */
  closeResourceAdmission(agentId: string) {
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM usages WHERE agentId=? AND active=1 LIMIT 1').get(agentId)) return false;
      this.db.prepare('INSERT OR IGNORE INTO resource_admission_fences(agentId) VALUES(?)').run(agentId);
      return true;
    });
  }
  reopenResourceAdmission(agentId: string, isRestored: () => boolean) {
    // Recheck sidecar membership while holding the board lock. A new retirement
    // must acquire this lock again before it can finalize, so a stale reopen
    // cannot race past its final admission fence.
    return this.transaction(() => {
      if (!isRestored()) return;
      this.db.prepare('DELETE FROM resource_admission_fences WHERE agentId=?').run(agentId);
    });
  }
  declareUsage(input: unknown): Usage {
    const data = parse(schemas.usage,input);
    return this.transaction(() => {
      this.agent(data.agentId); this.get('resources',data.resourceId); if (data.taskId) this.get('tasks',data.taskId);
      if (this.db.prepare('SELECT 1 FROM resource_admission_fences WHERE agentId=?').get(data.agentId)) throw new AppError('MEMBER_RETIRED', 'Member resource admission is closed until membership is restored', 409);
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
