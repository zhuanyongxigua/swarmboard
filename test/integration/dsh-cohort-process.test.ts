import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { DSH_COHORT_STAGES, type DshCohortStatus } from '../../src/harness/dsh/cohort.js';

const children: ChildProcess[] = [];
const roots: string[] = [];
afterEach(() => {
  children.forEach(child => { if (child.exitCode === null) child.kill(); });
  children.length = 0;
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});
function child(directory: string, mode: string) {
  const process = fork(fileURLToPath(new URL('../fixtures/dsh-cohort-process.ts', import.meta.url)), [directory, mode], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  children.push(process);
  return process;
}
function message(child: ChildProcess, type: string): Promise<{ type: string; result: DshCohortStatus }> {
  return new Promise((resolve, reject) => {
    const receive = (value: unknown) => {
      const item = value as { type: string; result: DshCohortStatus };
      if (item.type === type) { child.off('message', receive); resolve(item); }
    };
    child.on('message', receive);
    child.once('error', reject);
    child.once('exit', code => { if (code !== 0) reject(new Error(`fixture exited ${code}`)); });
  });
}
test('two independent CLI processes cannot both perform the first side effect', async () => {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dsh-process-')));
  roots.push(directory);
  const first = child(directory, 'hold');
  await message(first, 'effect');
  const second = child(directory, 'normal');
  expect((await message(second, 'result')).result.busy).toBe(true);
  expect(readFileSync(path.join(directory, 'effects.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  const finished = message(first, 'result');
  first.send('release');
  expect((await finished).result.seats[0].phase).toBe('launched');
  const third = child(directory, 'normal');
  expect((await message(third, 'result')).result.seats[0].phase).toBe('launched');
  expect(readFileSync(path.join(directory, 'effects.jsonl'), 'utf8').trim().split('\n')).toHaveLength(DSH_COHORT_STAGES.length);
});

test('a new process preserves the old effect when its receipt could not be committed', async () => {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dsh-process-loss-')));
  roots.push(directory);
  const first = child(directory, 'receipt-loss');
  await message(first, 'receipt-failed');
  const second = child(directory, 'normal');
  expect((await message(second, 'result')).result.seats[0].phase).toBe('reconcile-required');
  expect(readFileSync(path.join(directory, 'effects.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
});
