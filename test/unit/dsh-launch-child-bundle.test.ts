import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

it('bundles the actual default child and imports it outside the source tree without SDK or runtime effects', async () => {
  const root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'dsh-child-bundle-'));
  try {
    const output = join(root, 'child.mjs');
    const result = await build({ absWorkingDir: resolve('.'), entryPoints: ['src/harness/dsh/launch-child.ts'], outfile: output,
      platform: 'node', target: 'node24', format: 'esm', bundle: true, metafile: true,
      banner: { js: 'import {createRequire as __createRequire} from "node:module"; const require=__createRequire(import.meta.url);' } });
    expect(result.metafile!.inputs).toHaveProperty('src/harness/dsh/launcher-member-ports.ts');
    expect(result.metafile!.inputs).toHaveProperty('src/harness/dsh/launcher-channels.ts');
    expect(fs.readFileSync(output, 'utf8')).not.toMatch(/\/Users\/|\/private\/tmp\/swarmboard-/);
    const script = 'const m=await import(process.argv[1]); console.log(JSON.stringify({name:m.default.name,apply:typeof m.default.apply,control:typeof m.createDshLaunchChild,status:typeof m.readDshChildStatus}));';
    const readback = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, pathToFileURL(output).href],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    expect(readback).toEqual({ name: 'swarmboard-dsh-launch-child', apply: 'function', control: 'function', status: 'function' });
    expect(fs.readdirSync(root)).toEqual(['child.mjs']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
