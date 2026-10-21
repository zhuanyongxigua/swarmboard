import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { afterEach, expect, test } from 'vitest';
import { createDshCohortOperator } from '../../src/harness/dsh/cohort-operator.js';
import { parseDshLaunchConfig } from '../../src/harness/dsh/cohort-config.js';
import type { DshLauncherChannels, DshLauncherToolClient } from '../../src/harness/dsh/launcher-channels.js';
import type { DshPreparedSession } from '../../src/harness/dsh/launch-session.js';
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-operator-'))); roots.push(root);
  for (const dir of ['state', 'workspaces', 'runtime', 'sdk']) fs.mkdirSync(path.join(root, dir));
  const pin = (file: string, content = 'synthetic') => {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return { path: file, sha256: hash(content) };
  };
  const pins = Object.fromEntries(['cordis', 'dsh-session', 'dsh-session-persistence-jsonl', 'dsh-agent', 'dsh-llm'].map(name => [name,
    pin(path.join(root, 'sdk/node_modules/@deepseek-ai', name, 'lib/index.js')).sha256]));
  const config = parseDshLaunchConfig({ schema: 'swarmboard-dsh-launch/v1', cohortKey: 'synthetic', count: 2,
    stateDirectory: root + '/state', workspaceRoot: root + '/workspaces', runtimeRoot: root + '/runtime', poolId: 'pool',
    taskIds: ['goal'], boardDatabasePath: root + '/board.sqlite', nodeCommand: process.execPath,
    server: pin(root + '/server.mjs'), sdk: { root: root + '/sdk', pins },
    cli: { ...pin(root + '/cli.js'), profile: 'headless' }, model: { provider: 'synthetic', model: 'explicit', reasoningEffort: 'explicit' },
    providerConfiguration: { entryId: 'llm-synthetic', config: { apiKeyEnv: 'SYNTHETIC_MODEL_KEY' } },
    permissionPreset: 'explicit', sessions: { mode: 'create' } });
  const collaborators: Array<Record<string, unknown>> = [], calls: string[] = [], bindings = new Map<string, Record<string, unknown>>();
  let mutateDuringInstructions = false;
  const client = (id?: string): DshLauncherToolClient => ({
    async call(name, input = {}) {
      calls.push(name);
      if (name === 'runtime_read') return { pool: { id: 'pool', enabled: true, taskIds: ['goal'] }, collaborators,
        executionGrants: [{ taskId: 'goal', poolId: 'pool', enabled: true, externalHarnesses: ['dsh'], monitoring: true,
          executionWorkspace: root, projectPath: root, version: 1 }] };
      if (name === 'task_read') return { id: 'goal', status: 'in_review' };
      if (name === 'collaborator_configure') {
        let record = collaborators.find(value => value.id === input.id);
        if (!record) { record = { id: `member-${collaborators.length + 1}`, cursor: 10, version: 0 }; collaborators.push(record); }
        Object.assign(record, input, { id: record.id, version: Number(record.version) + 1 });
        return structuredClone(record);
      }
      if (name === 'preferences_read' || name === 'user_prompt_read') {
        if (mutateDuringInstructions && id === 'member-1') {
          const native = path.join(config.runtimeRoot, 'seat-1/sessions/native.jsonl');
          fs.appendFileSync(native, 'changed');
        }
        return { version: 1, text: 'Synthetic current instruction', source: 'synthetic' };
      }
      if (name === 'notification_binding_read') return { binding: bindings.get(String(input.adapterId)) ?? null };
      if (name === 'notification_register') {
        const record = collaborators.find(record => record.id === id)!;
        bindings.set(String(input.id), { adapterId: input.id, memberId: id, sessionRef: record.sessionRef,
          enabled: true, registrationVersion: 1, admissionVersion: record.version, capabilities: input.capabilities,
          taskIds: ['goal'], boardWide: false });
        return {};
      }
      throw new Error('unexpected synthetic RPC');
    },
    async callTool() { throw new Error('unused'); }, async close() {},
  });
  const mcpConfig: DshLauncherChannels['memberMcpConfig'] = () => ({ transport: 'stdio', command: process.execPath, args: [], env: {}, cwd: root,
    serverName: 'swarmboard_worker', failOnStartupError: true, reconnect: { enabled: false } });
  const channels: DshLauncherChannels = { openManagement: async () => client(),
    openMember: async (id: string) => Object.assign(client(id), { mcpConfig: mcpConfig(id) }),
    memberMcpConfig: mcpConfig, async close() {} };
  const options = { config, channels, childEntry: pin(root + '/child.mjs').path,
    prepareSession: async (request: Parameters<typeof import('../../src/harness/dsh/launch-session.js').prepareDshSession>[0]): Promise<DshPreparedSession> => {
      calls.push('prepare-session');
      const nativePath = path.join(request.persistenceRoot, 'native.jsonl'); fs.writeFileSync(nativePath, 'original-session');
      const receipt: DshPreparedSession = { schema: 'swarmboard-dsh-session/v1', requestSha256: '1'.repeat(64), sessionRef: request.sessionRef,
        cwd: request.cwd, nativeRoot: request.persistenceRoot, nativePath, nativeSha256: hash('original-session'),
        created: request.mode === 'create', modelTurns: request.mode === 'create' ? 0 : null, activated: false };
      fs.writeFileSync(path.join(request.stateDirectory, 'session-prepared.json'), JSON.stringify(receipt));
      return receipt;
    },
    spawn: () => {
      const state = JSON.parse(fs.readFileSync(path.join(config.stateDirectory, 'cohort.json'), 'utf8'));
      expect(state.seats.some((seat: { attempts: Array<{ stage: string; state: string }> }) => seat.attempts.at(-1)?.stage === 'launch'
        && seat.attempts.at(-1)?.state === 'intent')).toBe(true);
      calls.push('spawn');
      const child = Object.assign(new EventEmitter(), { pid: 100 + calls.length, unref() {} });
      queueMicrotask(() => child.emit('spawn'));
      return child as unknown as ChildProcess;
    },
  };
  return { root, config, options, calls, mutate: () => { mutateDuringInstructions = true; } };
}
test('actual production stage composition binds each real returned id and repeats without writes or spawn', async () => {
  const { options, calls, config } = fixture();
  const operator = createDshCohortOperator(options);
  expect(operator.inspect().seats).toHaveLength(2);
  expect(calls).toEqual([]);
  const result = await operator.run();
  expect(result.seats.map(seat => seat.phase)).toEqual(['launched', 'launched']);
  expect(calls.filter(call => call === 'collaborator_configure')).toHaveLength(4);
  expect(calls.filter(call => call === 'spawn')).toHaveLength(2);
  const before = calls.length;
  await operator.run(); expect(calls).toHaveLength(before);
  const overlay = JSON.parse(fs.readFileSync(path.join(config.stateDirectory, 'seat-1/overlay.json'), 'utf8'));
  expect(overlay.find((row: { id: string }) => row.id === 'headless-runner').disabled).toBe(true);
  expect(overlay.at(-1).insert).toHaveLength(2);
  expect(result.seats.every(seat => !seat.ready && !seat.consumed)).toBe(true);
  await operator.close();
});
test('original session provenance failure after asynchronous prompts blocks this seat before register or spawn', async () => {
  const { options, mutate, calls } = fixture(); mutate();
  const operator = createDshCohortOperator(options);
  const result = await operator.run();
  expect(result.seats.map(seat => seat.phase)).toEqual(['reconcile-required', 'launched']);
  expect(calls.filter(call => call === 'notification_register')).toHaveLength(1);
  expect(calls.filter(call => call === 'spawn')).toHaveLength(1);
  await operator.close();
});
