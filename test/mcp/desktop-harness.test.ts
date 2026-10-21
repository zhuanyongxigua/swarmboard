// Check the archive's opt-in adapter surface without loading a live SDK or model.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

it('loads the shipped DSH module independently of the core and source checkout', () => {
  const version = (JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {version: string}).version;
  const archive = resolve(`dist/swarmboard-desktop-${version}.zip`);
  const root = mkdtempSync(join(tmpdir(), 'shipped-harness-'));
  try {
    const unpacked = join(root, 'plugin'); mkdirSync(unpacked);
    execFileSync('unzip', ['-q', archive, '-d', unpacked]);
    const moduleUrl = pathToFileURL(join(unpacked, 'server/harness/dsh/index.mjs')).href;
    const names = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
      'console.log(JSON.stringify(Object.keys(await import(process.argv[1]))))', moduleUrl],
    { cwd: root, encoding: 'utf8' })) as string[];
    expect(names).toEqual(expect.arrayContaining(['DshLifecycle', 'renderInstructions', 'createDshInstructionBoundary', 'createDshSdkFacade', 'createDshSdkSessionPort', 'driveOnce', 'createDshJournals']));
    const core = readFileSync(join(unpacked, 'server/swarmboard.mjs'), 'utf8');
    expect(core).not.toContain('DSH_RECONCILIATION_REQUIRED');
    expect(core).not.toContain('DSH_INVALID_SDK_CONFIG');
    expect(core).not.toContain('personal-instructions/v1');
    const contents = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' });
    expect(contents).toContain('server/harness/dsh/index.mjs');
    expect(contents).not.toContain('node_modules/');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
