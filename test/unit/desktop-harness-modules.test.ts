// Exercise portable optional-module outputs without importing a real harness.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
const builder = pathToFileURL(resolve('scripts/build-harness-modules.mjs')).href;
const noticesBuilder = pathToFileURL(resolve('scripts/build-notices.mjs')).href;
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'portable-harness-')); directories.push(root);
  const source = join(root, 'source'); const destination = join(root, 'plugin');
  mkdirSync(join(source, 'src/harness'), { recursive: true });
  return { root, source, destination };
}
function build(source: string, destination: string) {
  const script = 'const {buildHarnessModules}=await import(process.argv[1]); const results=await buildHarnessModules(process.argv[2],process.argv[3]); console.log(JSON.stringify(results.map(r=>r.metafile)));';
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, builder, source, destination], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) as {inputs: Record<string, unknown>}[];
}

describe('portable optional harness modules', () => {
  it('bundles an arbitrary explicitly exported module and imports it from an unrelated cwd', () => {
    const f = fixture(); const module = join(f.source, 'src/harness/third-party'); mkdirSync(module);
    writeFileSync(join(module, 'index.ts'), 'export {value} from "./value.js";');
    writeFileSync(join(module, 'value.ts'), 'export const value: string = "synthetic-only";');
    const metadata = build(f.source, f.destination);
    expect(metadata).toHaveLength(1);
    expect(Object.keys(metadata[0]!.inputs)).toContain('src/harness/third-party/value.ts');
    // Import after archiving/extracting, with no source checkout or node_modules.
    const zip = join(f.root, 'modules.zip'); execFileSync('zip', ['-q', '-r', zip, 'server'], { cwd: f.destination });
    const unpacked = join(f.root, 'unpacked'); mkdirSync(unpacked); execFileSync('unzip', ['-q', zip, '-d', unpacked]);
    rmSync(f.source, { recursive: true });
    const moduleUrl = pathToFileURL(join(unpacked, 'server/harness/third-party/index.mjs')).href;
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', 'console.log((await import(process.argv[1])).value)', moduleUrl], { cwd: f.root, encoding: 'utf8' });
    expect(result.trim()).toBe('synthetic-only');
  });

  it('does not export helper-only directories or execute module code during the build', () => {
    const f = fixture(); const helper = join(f.source, 'src/harness/helper'); mkdirSync(helper);
    writeFileSync(join(helper, 'private.ts'), 'throw new Error("not an entry");');
    expect(build(f.source, f.destination)).toEqual([]);
    const module = join(f.source, 'src/harness/explicit'); mkdirSync(module);
    writeFileSync(join(module, 'index.ts'), 'throw new Error("must not execute during build"); export const value=1;');
    expect(build(f.source, f.destination)).toHaveLength(1);
    expect(readFileSync(join(f.destination, 'server/harness/explicit/index.mjs'), 'utf8')).toContain('must not execute during build');
  });

  it('rejects absolute imports and relative imports that escape the source root', () => {
    const f = fixture(); const module = join(f.source, 'src/harness/explicit'); mkdirSync(module);
    const external = join(f.root, 'outside.ts'); writeFileSync(external, 'export const value=1;');
    for (const specifier of [external, relative(module, external)]) {
      writeFileSync(join(module, 'index.ts'), `export {value} from ${JSON.stringify(specifier)};`);
      expect(() => build(f.source, f.destination)).toThrow(/Harness module (absolute import|outside source root)/);
    }
  });

  it('includes the dependency license of an independently bundled module in the common notices', () => {
    const f = fixture(); const module = join(f.source, 'src/harness/third-party'); mkdirSync(module);
    const dependency = join(f.source, 'node_modules/synthetic-library'); mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: 'synthetic-library', version: '1.2.3', main: 'index.js', license: 'MIT' }));
    writeFileSync(join(dependency, 'index.js'), 'export const value=7;');
    writeFileSync(join(dependency, 'LICENSE'), 'Synthetic MIT license text.');
    writeFileSync(join(module, 'index.ts'), 'export {value} from "synthetic-library";');
    const metadata = build(f.source, f.destination);
    const script = 'const {dependencyNotices}=await import(process.argv[1]); console.log(await dependencyNotices(process.argv[2],JSON.parse(process.argv[3]),[]));';
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', script, noticesBuilder, f.source, JSON.stringify(metadata)], { encoding: 'utf8' });
    expect(result).toContain('synthetic-library@1.2.3 (MIT)');
    expect(result).toContain('Synthetic MIT license text.');
    expect(result.match(/synthetic-library@/g)).toHaveLength(1);
  });
});
