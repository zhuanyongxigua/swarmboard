// Production assembly in real OS processes: the independent event daemon and
// the desktop stdio entrypoint share one configuration seam, select the
// configured backend, and fail loudly on an unknown backend.
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'swarmboard-assembly-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'board.sqlite');
}
function daemon(databasePath: string, harness: string) {
  const child = fork(resolve('src/stdio.ts'), ['--event-runtime'], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, SWARMBOARD_DB_PATH: databasePath, SWARMBOARD_HARNESS: harness },
  });
  cleanups.push(() => { if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); });
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += chunk.toString(); });
  // The daemon reports readiness on stdout only after its stop handlers exist.
  let ready = false;
  child.stdout!.on('data', chunk => { if (chunk.toString().includes('event runtime ready')) ready = true; });
  return { child, stderr: () => stderr, ready: () => ready };
}
async function until(accept: () => boolean, label: string, ms = 10000) {
  const end = Date.now() + ms;
  while (!accept() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50));
  expect(accept(), label).toBe(true);
}

describe.skipIf(process.platform === 'win32')('harness backend assembly in real processes', () => {
  it('exits with an UNKNOWN_HARNESS diagnostic when the configured backend does not exist', async () => {
    const { child, stderr } = daemon(workspace(), 'does-not-exist');
    const [code] = await once(child, 'exit');
    expect(code).toBe(1);
    expect(stderr()).toContain('Unknown harness backend');
  });
  it('starts the event daemon with the echo reference backend and stops cleanly', async () => {
    const databasePath = workspace();
    const { child, ready } = daemon(databasePath, 'echo');
    await until(ready, 'daemon reported readiness after installing stop handlers');
    expect(child.exitCode).toBeNull();
    child.kill('SIGTERM');
    const [code, signal] = await once(child, 'exit');
    expect(code).toBe(0); expect(signal).toBe(null);
  });
  it('keeps the default daemon compatible with the official Codex backend', async () => {
    const databasePath = workspace();
    const { child, ready } = daemon(databasePath, 'codex');
    await until(ready, 'daemon reported readiness after installing stop handlers');
    expect(child.exitCode).toBeNull();
    child.kill('SIGTERM');
    const [code] = await once(child, 'exit');
    expect(code).toBe(0);
  });
});
