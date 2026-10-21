import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { parseDshLaunchConfig, assertDshLaunchAuthority } from '../../src/harness/dsh/cohort-config.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function config() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dsh-launch-config-'))); roots.push(root);
  return { schema: 'swarmboard-dsh-launch/v1', cohortKey: 'synthetic', count: 2,
    stateDirectory: root + '/state', workspaceRoot: root + '/workspaces', runtimeRoot: root + '/runtime',
    poolId: 'synthetic-pool', taskIds: ['synthetic-goal'], boardDatabasePath: root + '/board.sqlite',
    nodeCommand: process.execPath, server: { path: root + '/server.mjs', sha256: '0'.repeat(64) },
    sdk: { root: root + '/sdk', pins: Object.fromEntries(['cordis', 'dsh-session', 'dsh-session-persistence-jsonl', 'dsh-agent', 'dsh-llm'].map(key => [key, '1'.repeat(64)])) },
    cli: { path: root + '/dsh.js', sha256: '2'.repeat(64), profile: 'headless' },
    model: { provider: 'synthetic-provider', model: 'synthetic-model', reasoningEffort: 'explicit-effort' },
    providerConfiguration: { entryId: 'synthetic-provider-row', config: { apiKeyEnv: 'SYNTHETIC_MODEL_KEY' } },
    permissionPreset: 'explicit-permission', sessions: { mode: 'create' },
  };
}
test('requires explicit model, permissions and count without carrying personal defaults', () => {
  const value = config();
  expect(parseDshLaunchConfig(value).model).toEqual(value.model);
  expect(() => parseDshLaunchConfig({ ...value, count: 0 })).toThrow();
  expect(() => parseDshLaunchConfig({ ...value, permissionPreset: undefined })).toThrow();
  expect(() => parseDshLaunchConfig({ ...value, model: { provider: 'synthetic' } })).toThrow();
  expect(() => parseDshLaunchConfig({ ...value, credential: 'never accepted' })).toThrow();
});
test('selected sessions preserve original refs and require one explicit selection per seat', () => {
  const value = config();
  const seats = [1, 2].map(index => ({ sessionRef: `session-${index}`, cwd: value.workspaceRoot + '/' + index, persistenceRoot: value.runtimeRoot + '/' + index }));
  expect(parseDshLaunchConfig({ ...value, sessions: { mode: 'select', seats } }).sessions).toEqual({ mode: 'select', seats });
  expect(() => parseDshLaunchConfig({ ...value, sessions: { mode: 'select', seats: seats.slice(0, 1) } })).toThrow();
});
test('formal pool, goal grant and execution workspace are rechecked before mutations', () => {
  const value = parseDshLaunchConfig(config());
  const runtime = { pool: { id: value.poolId, enabled: true, taskIds: value.taskIds }, collaborators: [],
    executionGrants: [{ taskId: value.taskIds[0], poolId: value.poolId, enabled: true, monitoring: true,
      externalHarnesses: ['dsh'], version: 1, executionWorkspace: path.dirname(value.stateDirectory) }] };
  expect(() => assertDshLaunchAuthority(value, runtime)).not.toThrow();
  expect(() => assertDshLaunchAuthority(value, { ...runtime, pool: { ...runtime.pool, enabled: false } })).toThrow('DSH_LAUNCH_AUTHORITY_REQUIRED');
  expect(() => assertDshLaunchAuthority(value, { ...runtime, executionGrants: [] })).toThrow('DSH_LAUNCH_AUTHORITY_REQUIRED');
  expect(() => assertDshLaunchAuthority({ ...value, workspaceRoot: '/synthetic/outside' }, runtime)).toThrow('DSH_LAUNCH_WORKSPACE_OUTSIDE_GRANT');
});
