import fs from 'node:fs';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { inspectDshSessionRequest, prepareDshSession, type DshSessionModule, type DshSessionRequest } from '../../src/harness/dsh/launch-session.js';

const directories: string[] = [];
afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { force: true, recursive: true }); });
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function fixture(options: { failedFlush?: boolean; changeOnDispose?: boolean } = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'dsh-session-contract-')); directories.push(root);
  const cwd = join(root, 'work'), persistenceRoot = join(root, 'sessions'), stateDirectory = join(root, 'state'), sdkRoot = join(root, 'sdk');
  for (const path of [cwd, persistenceRoot, stateDirectory, sdkRoot]) mkdirSync(path);
  const trace = join(root, 'trace.jsonl');
  // Synthetic public SDK modules exercise the real loader/filesystem boundary without an SDK dependency in CI.
  const sources = {
    cordis: `import fs from 'node:fs';import path from 'node:path';
      const trace=${JSON.stringify(trace)};const log=x=>fs.appendFileSync(trace,JSON.stringify(x)+'\\n');
      export class Context {get(){return undefined} async plugin(plugin,config){if(config)this.root=config.root;log('plugin')}
        sessions={create:(id,{meta})=>{log('create');this.data={meta:{id,cwd:meta.cwd},events:[]};return{append:(type,data)=>this.data.events.push({type,data})}},
        flush:async()=>{log('flush');if(${!!options.failedFlush})return false;fs.writeFileSync(path.join(this.root,'native.jsonl'),JSON.stringify(this.data));return true}};
        sessionPersistence={inspect:async id=>{log('inspect');return JSON.parse(fs.readFileSync(path.join(this.root,'native.jsonl'),'utf8'))},locate:()=>({path:path.join(this.root,'native.jsonl')})};
        fiber={dispose:async()=>{log('dispose');if(${!!options.changeOnDispose})fs.appendFileSync(path.join(this.root,'native.jsonl'),' ');}};}`,
    'dsh-session': `export const SessionStore={};export const SessionId=x=>x;`,
    'dsh-session-persistence-jsonl': `export const JsonlSessionPersistence={};`,
  };
  const pins = {} as Record<DshSessionModule, string>;
  for (const [name, source] of Object.entries(sources)) {
    const directory = join(sdkRoot, 'node_modules/@deepseek-ai', name, 'lib'); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'index.js'), source); writeFileSync(join(directory, '../package.json'), '{"type":"module"}');
    pins[name as DshSessionModule] = hash(source);
  }
  const request: DshSessionRequest = { mode: 'create', sessionRef: 'synthetic-session', cwd, persistenceRoot, stateDirectory, sdk: { root: sdkRoot, pins } };
  const calls = () => fs.existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').map(x => JSON.parse(x)) : [];
  return { root, request, calls };
}
it('inspection is inert and confirmed repeats reuse the original tuple, receipt and post-cleanup bytes', async () => {
  const f = fixture(); inspectDshSessionRequest(f.request); expect(f.calls()).toEqual([]);
  expect(fs.readdirSync(f.request.stateDirectory)).toEqual([]);
  const receipt = await prepareDshSession(f.request);
  expect(f.calls()).toEqual(['plugin', 'plugin', 'create', 'flush', 'inspect', 'dispose']);
  expect(receipt.nativeSha256).toBe(hash(readFileSync(receipt.nativePath))); expect(receipt.modelTurns).toBe(0);
  const before = f.calls(); expect(await prepareDshSession(f.request)).toEqual(receipt); expect(f.calls()).toEqual(before);
  expect(fs.statSync(join(f.request.stateDirectory, 'session-attempt.json')).mode & 0o777).toBe(0o600);
  await expect(prepareDshSession({ ...f.request, sessionRef: 'changed' })).rejects.toThrow('RECEIPT_CONFLICT');
  fs.appendFileSync(receipt.nativePath, ' ');
  await expect(prepareDshSession(f.request)).rejects.toThrow('NATIVE_CHANGED'); expect(f.calls()).toEqual(before);
});
it('select inspects original history without create/flush or a false zero-turn claim', async () => {
  const f = fixture(); f.request.mode = 'select';
  const file = join(f.request.persistenceRoot, 'native.jsonl');
  writeFileSync(file, JSON.stringify({ meta: { id: f.request.sessionRef, cwd: f.request.cwd }, events: [{ type: 'turn/end', data: {} }] }));
  const before = readFileSync(file);
  const receipt = await prepareDshSession(f.request);
  expect(receipt.created).toBe(false); expect(receipt.modelTurns).toBeNull(); expect(receipt.activated).toBe(false);
  expect(f.calls()).toEqual(['plugin', 'plugin', 'inspect', 'dispose']); expect(readFileSync(file)).toEqual(before);
});
it.each([{ failedFlush: true }, { changeOnDispose: true }])('retains unknown intent after failure including cleanup drift: %o', async options => {
  const f = fixture(options);
  await expect(prepareDshSession(f.request)).rejects.toThrow();
  expect(fs.existsSync(join(f.request.stateDirectory, 'session-attempt.json'))).toBe(true);
  expect(fs.existsSync(join(f.request.stateDirectory, 'session-prepared.json'))).toBe(false);
  const before = f.calls(); await expect(prepareDshSession(f.request)).rejects.toThrow('RECONCILIATION_REQUIRED');
  expect(f.calls()).toEqual(before);
});
it('rejects pin drift and path aliases before a durable attempt or import', async () => {
  const f = fixture(); const original = f.request.sdk.pins.cordis;
  f.request.sdk.pins.cordis = '0'.repeat(64);
  await expect(prepareDshSession(f.request)).rejects.toThrow('PIN_MISMATCH'); expect(f.calls()).toEqual([]);
  expect(fs.readdirSync(f.request.stateDirectory)).toEqual([]); f.request.sdk.pins.cordis = original;
  const alias = join(f.root, 'alias'); fs.symlinkSync(f.request.persistenceRoot, alias); f.request.persistenceRoot = alias;
  await expect(prepareDshSession(f.request)).rejects.toThrow('CANONICAL_DIRECTORY_REQUIRED'); expect(f.calls()).toEqual([]);
});
