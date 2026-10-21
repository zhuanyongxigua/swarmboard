// Exercise the shipped command after relocation, with no source tree, SDK or model.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
test('a relocated package exposes the inert CLI and configurable local state without SDK or MCP', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cli-package-'))); roots.push(root);
  const built = path.join(root, 'built');
  execFileSync(process.execPath, ['--input-type=module', '-e',
    'const {buildHarnessModules}=await import(process.argv[1]);await buildHarnessModules(process.argv[2],process.argv[3]);',
    new URL('../../scripts/build-harness-modules.mjs', import.meta.url).href, process.cwd(), built], { stdio: 'pipe' });
  const unpacked = path.join(root, 'unpacked'); fs.mkdirSync(unpacked);
  const archive = path.join(root, 'adapter.zip');
  execFileSync('zip', ['-q', '-r', archive, 'server'], { cwd: built });
  execFileSync('unzip', ['-q', archive, '-d', unpacked]);
  fs.rmSync(built, { recursive: true });
  const command = path.join(unpacked, 'server/harness/dsh/launch.mjs');
  expect(JSON.parse(execFileSync(process.execPath, [command, '--help'], { cwd: root, encoding: 'utf8' })).usage).toContain('--config');
  const inspect = execFileSync(process.execPath, ['--input-type=module', '-e',
    'const m=await import(process.argv[1]);console.log(JSON.stringify({apply:typeof m.default?.apply,read:typeof m.readDshChildStatus}));',
    new URL('file://' + path.join(unpacked, 'server/harness/dsh/child.mjs')).href], { cwd: root, encoding: 'utf8' });
  expect(JSON.parse(inspect)).toEqual({ apply: 'function', read: 'function' });
  for (const count of [1, 3]) {
    const base = path.join(root, `count-${count}`); fs.mkdirSync(base);
    for (const name of ['state', 'runtime', 'workspaces']) fs.mkdirSync(path.join(base, name));
    const config = { schema: 'swarmboard-dsh-launch/v1', cohortKey: `count-${count}`, count,
      stateDirectory: base + '/state', workspaceRoot: base + '/workspaces', runtimeRoot: base + '/runtime',
      poolId: 'synthetic-pool', taskIds: ['synthetic-goal'], boardDatabasePath: base + '/absent-board.sqlite',
      server: { path: base + '/absent-server.mjs', sha256: '1'.repeat(64) }, nodeCommand: process.execPath,
      sdk: { root: base + '/absent-sdk', pins: Object.fromEntries(['cordis', 'dsh-session', 'dsh-session-persistence-jsonl',
        'dsh-agent', 'dsh-llm'].map(name => [name, '2'.repeat(64)])) },
      cli: { path: base + '/absent-cli.js', sha256: '3'.repeat(64), profile: 'headless' },
      model: { provider: 'synthetic', model: 'explicit', reasoningEffort: 'explicit' },
      providerConfiguration: { entryId: 'llm-synthetic', config: { apiKeyEnv: 'SYNTHETIC_MODEL_KEY' } },
      permissionPreset: 'explicit', sessions: { mode: 'create' } };
    const file = path.join(base, 'config.json'); fs.writeFileSync(file, JSON.stringify(config));
    const before = fs.readdirSync(base).sort();
    for (const flags of [[], ['--status']]) {
      const result = JSON.parse(execFileSync(process.execPath, [command, '--config', file, ...flags], { cwd: root, encoding: 'utf8' }));
      expect(result.seats).toHaveLength(count);
      expect(result.seats.every((seat: { operatorPhase: string; startupReady: boolean }) => seat.operatorPhase === 'planned' && !seat.startupReady)).toBe(true);
    }
    expect(fs.readdirSync(base).sort()).toEqual(before);
    for (const name of ['state', 'runtime', 'workspaces']) expect(fs.readdirSync(path.join(base, name))).toEqual([]);
  }
});
