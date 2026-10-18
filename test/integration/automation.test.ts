// Verify real persisted schedule intent and atomic claim gates without touching native schedules or user data.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../../src/store.js';
import { buildSetupPrompt, buildWorkerPrompt } from '../../src/automation.js';

function activate(store: Store, workspacePath: string) {
  const pending = store.prepareAutomation({ action: 'enable', expectedVersion: store.readAutomation().version, workspacePath, intervalMinutes: 10 });
  return store.confirmAutomation({ expectedVersion: pending.version, requestId: pending.requestId, automationId: 'native-schedule', status: 'ACTIVE', model: 'host-resolved-model', reasoningEffort: 'high', projectId: 'saved-local-project' });
}

describe('native automation configuration and claiming', () => {
  it('keeps activation pending until a matching native result, persists it and pauses only after confirmation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarmboard-automation-')); const path = join(dir, 'board.sqlite');
    let store = new Store(path);
    try {
      expect(store.readAutomation()).toMatchObject({ version: 0, state: 'off', desiredEnabled: true, automationId: null, intervalMinutes: 10 });
      const pending = store.prepareAutomation({ action: 'enable', expectedVersion: 0, workspacePath: dir, intervalMinutes: 5 });
      expect(pending).toMatchObject({ state: 'pending', actualStatus: null, automationId: null });
      expect(buildSetupPrompt(pending)).toContain('This is setup only');
      const active = store.confirmAutomation({ expectedVersion: pending.version, requestId: pending.requestId, automationId: 'native-schedule', status: 'ACTIVE', model: 'host-resolved-model', reasoningEffort: 'high', projectId: 'saved-local-project' });
      store.close(); store = new Store(path); expect(store.readAutomation()).toEqual(active);
      const pause = store.prepareAutomation({ action: 'pause', expectedVersion: active.version });
      expect(pause).toMatchObject({ state: 'pending', desiredEnabled: false, actualStatus: 'ACTIVE' });
      const off = store.confirmAutomation({ expectedVersion: pause.version, requestId: pause.requestId, automationId: 'native-schedule', status: 'PAUSED', model: 'host-resolved-model', reasoningEffort: 'high', projectId: 'saved-local-project' });
      expect(off).toMatchObject({ state: 'off', actualStatus: 'PAUSED', desiredEnabled: false, requestId: null });
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('rejects stale revisions, wrong nonces, mismatched status and replacement native identities', () => {
    const store = new Store(); const dir = mkdtempSync(join(tmpdir(), 'swarmboard-automation-'));
    try {
      const pending = store.prepareAutomation({ action: 'enable', expectedVersion: 0, workspacePath: dir });
      const confirm = { expectedVersion: pending.version, requestId: pending.requestId, automationId: 'native-schedule', status: 'ACTIVE', model: 'host-resolved-model', reasoningEffort: 'high', projectId: 'saved-local-project' };
      expect(() => store.prepareAutomation({ action: 'enable', expectedVersion: 0, workspacePath: dir })).toThrow(/State changed/);
      expect(() => store.confirmAutomation({ ...confirm, requestId: 'wrong' })).toThrow(/no longer pending/);
      expect(() => store.confirmAutomation({ ...confirm, status: 'PAUSED' })).toThrow(/does not match/);
      const active = store.confirmAutomation(confirm);
      expect(() => store.failAutomationSetup({ expectedVersion: pending.version, requestId: pending.requestId, error: 'stale delivery' })).toThrow(/State changed/);
      const pause = store.prepareAutomation({ action: 'pause', expectedVersion: active.version });
      expect(() => store.confirmAutomation({ ...confirm, expectedVersion: pause.version, requestId: pause.requestId, status: 'PAUSED', automationId: 'duplicate' })).toThrow(/existing native automation/);
      const failed = store.failAutomationSetup({ expectedVersion: pause.version, requestId: pause.requestId, error: 'Native tool denied pause' });
      expect(failed).toMatchObject({ state: 'error', actualStatus: 'ACTIVE', automationId: 'native-schedule', lastError: 'Native tool denied pause' });
      expect(() => store.confirmAutomation({ ...confirm, expectedVersion: failed.version, requestId: pause.requestId })).toThrow(/no longer pending/);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('validates existing absolute workspaces and refuses to pause an unconfirmed schedule', () => {
    const store = new Store();
    try {
      expect(() => store.prepareAutomation({ action: 'enable', expectedVersion: 0, workspacePath: 'relative' })).toThrow(/existing absolute/);
      expect(() => store.prepareAutomation({ action: 'enable', expectedVersion: 0, workspacePath: '/not-a-real-swarmboard-workspace' })).toThrow(/existing absolute/);
      expect(() => store.prepareAutomation({ action: 'enable', expectedVersion: 0, workspacePath: tmpdir(), intervalMinutes: 1 })).toThrow(/intervalMinutes/);
      expect(() => store.prepareAutomation({ action: 'pause', expectedVersion: 0 })).toThrow(/No native automation/);
      expect(store.readAutomation().version).toBe(0);
    } finally { store.close(); }
  });
  it('blocks disabled, pending, stale and paused scheduled claims while keeping manual claims available', () => {
    const store = new Store();
    try {
      const agent = store.registerAgent({ name: 'Scheduled worker' }); const task = store.createTask({ title: 'Verified work' });
      const claim = { id: task.id, agentId: agent.id, expectedVersion: 1, automationVersion: 1, threadId: 'native-worker-thread' };
      const pending = store.prepareAutomation({ action: 'enable', expectedVersion: 0, workspacePath: tmpdir() });
      expect(() => store.claimAutomationTask(claim)).toThrow(/not active/);
      const active = store.confirmAutomation({ expectedVersion: pending.version, requestId: pending.requestId, automationId: 'native-schedule', status: 'ACTIVE', model: 'host-resolved-model', reasoningEffort: 'high', projectId: 'saved-local-project' });
      expect(() => store.claimAutomationTask(claim)).toThrow(/State changed/);
      const pause = store.prepareAutomation({ action: 'pause', expectedVersion: active.version });
      expect(() => store.claimAutomationTask({ ...claim, automationVersion: pause.version })).toThrow(/not active/);
      const off = store.confirmAutomation({ expectedVersion: pause.version, requestId: pause.requestId, automationId: 'native-schedule', status: 'PAUSED', model: 'host-resolved-model', reasoningEffort: 'high', projectId: 'saved-local-project' });
      expect(() => store.claimAutomationTask({ ...claim, automationVersion: off.version })).toThrow(/not active/);
      expect(store.board().tasks[0]).toMatchObject({ status: 'todo', version: 1, assignee: null });
      expect(store.claimTask(task.id, { agentId: agent.id, expectedVersion: 1 }).status).toBe('in_progress');
    } finally { store.close(); }
  });
  it('lets only one database client claim a todo task and persists its exact native session binding', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarmboard-automation-')); const path = join(dir, 'board.sqlite');
    const first = new Store(path); const second = new Store(path);
    try {
      const active = activate(first, dir); const a = first.registerAgent({ name: 'A' }); const b = second.registerAgent({ name: 'B' }); const task = first.createTask({ title: 'One owner' });
      const result = first.claimAutomationTask({ id: task.id, agentId: a.id, expectedVersion: 1, automationVersion: active.version, threadId: 'thread-a' });
      expect(result.task).toMatchObject({ assignee: a.id, status: 'in_progress', version: 2 });
      expect(result.binding).toMatchObject({ taskId: task.id, threadId: 'thread-a', automationId: 'native-schedule' });
      expect(() => second.claimAutomationTask({ id: task.id, agentId: b.id, expectedVersion: 1, automationVersion: active.version, threadId: 'thread-b' })).toThrow(/only claim todo/);
      expect(second.db.prepare('SELECT * FROM automation_bindings').all()).toEqual([result.binding]);
      first.releaseTask(task.id, { agentId: a.id, expectedVersion: 2, status: 'blocked' });
      expect(() => second.claimAutomationTask({ id: task.id, agentId: b.id, expectedVersion: 3, automationVersion: active.version, threadId: 'thread-b' })).toThrow(/only claim todo/);
    } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('upgrades a version-2 database without losing existing tasks or user records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarmboard-automation-')); const path = join(dir, 'board.sqlite');
    let store = new Store(path);
    try {
      const task = store.createTask({ title: 'Pre-upgrade task' }); const resource = store.createResource({ name: 'Existing machine' }); const before = store.board();
      store.db.exec('DROP TRIGGER usage_admission_insert; DROP TRIGGER usage_admission_update; DROP TABLE resource_admission_fences; DROP TABLE task_participants; DROP TABLE automation_bindings; DROP TABLE automation_config; PRAGMA user_version=2;');
      store.close(); store = new Store(path);
      expect(store.board()).toEqual(before); expect(store.board().tasks[0]?.id).toBe(task.id); expect(store.board().resources[0]?.id).toBe(resource.id);
      expect(store.readAutomation()).toMatchObject({ state: 'off', version: 0 });
      expect(store.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 6 });
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('turns unknown setup outcomes into durable read-only recovery and never permits a fresh creation retry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarmboard-recovery-')); const path = join(dir, 'board.sqlite');
    let store = new Store(path);
    try {
      const first = store.prepareAutomation({ action: 'enable', expectedVersion: 0, workspacePath: dir });
      const failed = store.failAutomationSetup({ expectedVersion: first.version, requestId: first.requestId, error: 'Delivery result was lost' });
      expect(failed).toMatchObject({ state: 'error', recoveryRequired: true, automationId: null });
      store.close(); store = new Store(path);
      expect(store.readAutomation()).toEqual(failed);
      const retry = store.prepareAutomation({ action: 'enable', expectedVersion: failed.version, workspacePath: dir });
      expect(retry).toMatchObject({ state: 'pending', setupMode: 'reconcile', recoveryRequired: true });
      const prompt = buildSetupPrompt(retry);
      expect(prompt).toContain('READ-ONLY native reconciliation'); expect(prompt).toContain('never create, update, pause, delete'); expect(prompt).toContain(first.boardId);
      expect(() => store.confirmAutomation({ expectedVersion: retry.version, requestId: retry.requestId, automationId: 'duplicate', status: 'ACTIVE', model: 'host-model', reasoningEffort: 'high', projectId: 'project' })).toThrow(/requires recovery/);
      expect(() => store.reconcileAutomation({ expectedVersion: retry.version, requestId: retry.requestId, outcome: 'absent', automationId: 'contradiction' })).toThrow(/absent result/);
      const absent = store.reconcileAutomation({ expectedVersion: retry.version, requestId: retry.requestId, outcome: 'absent' });
      expect(absent).toMatchObject({ state: 'off', recoveryRequired: false, automationId: null });
      expect(store.prepareAutomation({ action: 'enable', expectedVersion: absent.version, workspacePath: dir })).toMatchObject({ setupMode: 'configure', recoveryRequired: false });
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('fences overlapping pending setup callbacks and recovers an existing host identity without activating it', () => {
    const store = new Store();
    try {
      const original = store.prepareAutomation({ action: 'enable', expectedVersion: 0, workspacePath: tmpdir() });
      const recovery = store.prepareAutomation({ action: 'enable', expectedVersion: original.version, workspacePath: tmpdir() });
      expect(recovery.setupMode).toBe('reconcile');
      const fields = { automationId: 'native-recovered', status: 'ACTIVE', model: 'host-model', reasoningEffort: 'high', projectId: 'exact-local-project' };
      expect(() => store.confirmAutomation({ ...fields, expectedVersion: original.version, requestId: original.requestId })).toThrow(/State changed/);
      expect(() => store.reconcileAutomation({ expectedVersion: recovery.version, requestId: recovery.requestId, outcome: 'found' })).toThrow(/requires its observed/);
      const recovered = store.reconcileAutomation({ ...fields, expectedVersion: recovery.version, requestId: recovery.requestId, outcome: 'found' });
      expect(recovered).toMatchObject({ state: 'off', desiredEnabled: true, recoveryRequired: false, automationId: 'native-recovered', actualStatus: 'ACTIVE' });
      const pause = store.prepareAutomation({ action: 'pause', expectedVersion: recovered.version });
      expect(pause).toMatchObject({ setupMode: 'configure', automationId: 'native-recovered', desiredEnabled: false });
      const failed = store.failAutomationSetup({ expectedVersion: pause.version, requestId: pause.requestId, error: 'No native mutation happened', nativeOutcome: 'not-created' });
      expect(failed).toMatchObject({ recoveryRequired: false, actualStatus: 'ACTIVE' });
      const next = store.prepareAutomation({ action: 'reconcile', expectedVersion: failed.version });
      expect(() => store.reconcileAutomation({ ...fields, automationId: 'another-id', expectedVersion: next.version, requestId: next.requestId, outcome: 'found' })).toThrow(/existing native automation/);
      expect(store.failAutomationSetup({ expectedVersion: next.version, requestId: next.requestId, error: 'Lookup unavailable', nativeOutcome: 'not-created' }).recoveryRequired).toBe(true);
    } finally { store.close(); }
  });
  it('initializes one projectless native schedule without settings and does not retry pending viewers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarmboard-default-')); const path = join(dir, 'board.sqlite');
    const first = new Store(path); const second = new Store(path);
    try {
      expect(first.readAutomation()).toMatchObject({ desiredEnabled: true, workspacePath: '', state: 'off' });
      const winner = first.ensureAutomation(); const follower = second.ensureAutomation();
      expect(winner.setupPrompt).toContain('projectId=null'); expect(winner.setupPrompt).toContain('Do not ask the user to choose a workspace, model, interval or enable switch');
      expect(winner.config).toMatchObject({ state: 'pending', setupMode: 'configure', workspacePath: '' });
      expect(follower).toEqual({ config: winner.config, setupPrompt: null });
      expect(first.ensureAutomation()).toEqual(follower);
      expect(() => first.confirmAutomation({ expectedVersion: winner.config.version, requestId: winner.config.requestId, automationId: 'global-native', status: 'ACTIVE', model: 'host-default', reasoningEffort: 'high' })).toThrow(/projectId/);
      expect(() => first.confirmAutomation({ expectedVersion: winner.config.version, requestId: winner.config.requestId, automationId: 'global-native', status: 'ACTIVE', model: 'host-default', reasoningEffort: 'high', projectId: 'wrong-project' })).toThrow(/projectId=null/);
      const active = first.confirmAutomation({ expectedVersion: winner.config.version, requestId: winner.config.requestId, automationId: 'global-native', status: 'ACTIVE', model: 'host-default', reasoningEffort: 'high', projectId: null });
      expect(active.projectId).toBeNull(); expect(second.ensureAutomation({ retry: true }).setupPrompt).toBeNull();
      const pause = first.prepareAutomation({ action: 'pause', expectedVersion: active.version });
      first.confirmAutomation({ expectedVersion: pause.version, requestId: pause.requestId, automationId: 'global-native', status: 'PAUSED', model: 'host-default', reasoningEffort: 'high', projectId: null });
      expect(second.ensureAutomation({ retry: true }).setupPrompt).toBeNull();
    } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('does not loop on errors, and explicit retry recovers unknown native outcomes before configuring', () => {
    const store = new Store();
    try {
      const initial = store.ensureAutomation();
      const failed = store.failAutomationSetup({ expectedVersion: initial.config.version, requestId: initial.config.requestId, error: 'Unknown dispatch outcome' });
      expect(store.ensureAutomation()).toEqual({ config: failed, setupPrompt: null });
      const recovery = store.ensureAutomation({ retry: true });
      expect(recovery.config.setupMode).toBe('reconcile'); expect(recovery.setupPrompt).toContain('READ-ONLY native reconciliation');
      expect(store.ensureAutomation().setupPrompt).toBeNull();
      expect(() => store.reconcileAutomation({ expectedVersion: recovery.config.version, requestId: recovery.config.requestId, outcome: 'found', automationId: 'global-native', status: 'ACTIVE', model: 'host-default', reasoningEffort: 'high' })).toThrow(/requires its observed/);
      const recovered = store.reconcileAutomation({ expectedVersion: recovery.config.version, requestId: recovery.config.requestId, outcome: 'found', automationId: 'global-native', status: 'ACTIVE', model: 'host-default', reasoningEffort: 'high', projectId: null });
      expect(recovered).toMatchObject({ state: 'off', desiredEnabled: true, projectId: null, automationId: 'global-native' });
      const resume = store.ensureAutomation(); expect(resume.config.setupMode).toBe('configure'); expect(resume.config.automationId).toBe('global-native');
      const definite = store.failAutomationSetup({ expectedVersion: resume.config.version, requestId: resume.config.requestId, error: 'Native tool unavailable before mutation', nativeOutcome: 'not-created' });
      expect(store.ensureAutomation().setupPrompt).toBeNull();
      expect(store.ensureAutomation({ retry: true }).config).toMatchObject({ setupMode: 'configure', recoveryRequired: false, version: definite.version + 1 });
    } finally { store.close(); }
  });
  it('migrates a version-3 off configuration once without discarding its task or native identity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarmboard-default-migration-')); const path = join(dir, 'board.sqlite'); let store = new Store(path);
    try {
      const task = store.createTask({ title: 'Retained legacy task' }); const old = { ...store.readAutomation(), desiredEnabled: false, state: 'off', automationId: 'legacy-native', actualStatus: 'PAUSED', projectId: 'legacy-project', workspacePath: dir, version: 7 };
      store.db.prepare('UPDATE automation_config SET config=? WHERE id=1').run(JSON.stringify(old)); store.db.exec('DROP TRIGGER usage_admission_insert; DROP TRIGGER usage_admission_update; DROP TABLE resource_admission_fences; DROP TABLE task_participants; PRAGMA user_version=3'); store.close(); store = new Store(path);
      const migrated = store.readAutomation(); expect(migrated).toMatchObject({ desiredEnabled: true, automationId: 'legacy-native', actualStatus: 'PAUSED', workspacePath: dir, version: 8 });
      expect(store.board().tasks[0]?.id).toBe(task.id); store.close(); store = new Store(path); expect(store.readAutomation()).toEqual(migrated);
      const pending = store.prepareAutomation({ action: 'pause', expectedVersion: migrated.version }); store.confirmAutomation({ expectedVersion: pending.version, requestId: pending.requestId, automationId: 'legacy-native', status: 'PAUSED', model: 'host-default', reasoningEffort: 'high', projectId: 'legacy-project' });
      store.close(); store = new Store(path); expect(store.readAutomation().desiredEnabled).toBe(false); expect(store.ensureAutomation().setupPrompt).toBeNull();
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('gives global workers explicit target checks and ends empty boards before registering identities', () => {
    const prompt = buildWorkerPrompt('', 'board-default');
    expect(prompt).toContain('board-global projectless'); expect(prompt).toContain('Never assume the session’s starting directory'); expect(prompt).toContain('BEFORE agent_register'); expect(prompt).toContain('concrete missing-fact blocker'); expect(prompt).toContain('board-default');
    expect(buildWorkerPrompt('/legacy', 'board-old')).toContain('Use only that workspace as the working directory');
  });
  it('keeps setup and worker prompts bounded and prevents implicit or disabled execution', () => {
    const store = new Store();
    try {
      const config = store.prepareAutomation({ action: 'enable', expectedVersion: 0, workspacePath: tmpdir() }); const setup = buildSetupPrompt(config); const worker = buildWorkerPrompt(config.workspacePath, config.boardId);
      expect(setup.length).toBeLessThan(15000); expect(setup).toContain('automation_update'); expect(setup).toContain('never create a duplicate'); expect(setup).toContain('projectKind=local, hostId=local'); expect(setup).toContain('do not hardcode or guess');
      expect(worker).toContain('automation_claim, never ordinary task_claim'); expect(worker).toContain('state=active'); expect(worker).toContain('not a lock'); expect(worker).toContain('resource_release'); expect(worker).toContain('task_release status=blocked');
    } finally { store.close(); }
  });
});
